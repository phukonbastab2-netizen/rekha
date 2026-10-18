// The provider list is ordered by record revision (stamp, key), not message time.
// Keep refresh catch-up separate from the owner's older-history position.
export function decodeCursor(value) {
  if (typeof value !== 'string' || !value || value.length > 1500) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return Number.isSafeInteger(parsed.stamp) && typeof parsed.key === 'string' ? parsed : null;
  } catch { return null; }
}
export function compareCursors(a, b) {
  const left = decodeCursor(a), right = decodeCursor(b);
  if (!left || !right) throw Error('WhatsApp inbox pagination is unavailable. Please refresh the chat.');
  return left.stamp - right.stamp || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}
export function historyCursor(row) {
  if (!row?._historyCursor && Number.isSafeInteger(row?.at) && typeof row.key === 'string') return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({at:row.at,key:row.key})))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  if (typeof row?._historyCursor !== 'string') throw Error('WhatsApp history pagination is unavailable. Please refresh the chat.');
  try {
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(row._historyCursor.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))));
    if (Number.isSafeInteger(parsed.at) && parsed.key === row.key) return row._historyCursor;
  } catch {}
  throw Error('WhatsApp history pagination is unavailable. Please refresh the chat.');
}
export function releaseMessageMedia(node) {
  for (const media of node.querySelectorAll('img,video,audio')) {
    if (typeof media.pause === 'function') media.pause();
    media.removeAttribute('src');
    if (typeof media.load === 'function') media.load();
  }
}

export function createMessageState({ pageSize = 50, pagesPerPoll = 4, maxRecords = 500 } = {}) {
  const records = new Map();
  let peer = '', generation = 0, loaded = false, head = '', older = '', catchup = null;
  let deletedAt = 0, historyMode = false, hasNewer = false, queue = Promise.resolve(), controller = new AbortController();
  function clear() {
    controller.abort(); controller = new AbortController();
    generation++; records.clear(); loaded = false; head = ''; older = ''; catchup = null;
    historyMode = false; hasNewer = false; queue = Promise.resolve();
  }
  function noticeContact(contact) {
    if (contact?.peer !== peer) return false;
    const boundary = Number(contact.contentDeletedAt) || 0;
    if (boundary <= deletedAt) return false;
    deletedAt = boundary; clear(); return true;
  }
  function trim() {
    if (records.size <= maxRecords) return;
    const ordered = [...records.values()].sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    const retained = historyMode ? ordered.slice(-maxRecords) : ordered.slice(0, maxRecords);
    const keys = new Set(retained.map(row => row.key));
    for (const key of records.keys()) if (!keys.has(key)) records.delete(key);
    if (!historyMode && retained.length) older = historyCursor(retained.at(-1));
  }
  function merge(rows, isOlder) {
    for (const row of rows) {
      if (!row || typeof row.key !== 'string' || row.peer && row.peer !== peer) continue;
      if (row.kind === 'deleted' || row.deleted === true) { records.delete(row.key); continue; }
      if (!decodeCursor(row._cursor)) throw Error('WhatsApp inbox pagination is unavailable. Please refresh the chat.');
      if (deletedAt && Number(row.at) <= deletedAt) continue;
      const existing = records.get(row.key);
      if (existing && compareCursors(row._cursor, existing._cursor) < 0) continue;
      if (historyMode && !isOlder && !existing) { hasNewer = true; continue; }
      records.set(row.key, row);
    }
    trim();
  }
  async function perform(fetchPage, isOlder, ticket, requestPeer) {
    if (ticket !== generation || requestPeer !== peer) return { stale: true };
    if (isOlder && (!loaded || !older)) return { stale: false, generation, peer, exhausted: true };
    let metadata, invalidated = false;
    const page = async (before, order = 'revision') => {
      const result = await fetchPage({ peer: requestPeer, before, order, signal: controller.signal });
      if (ticket !== generation || requestPeer !== peer) return null;
      if (result?.contact && result.contact.peer !== requestPeer) return null;
      if (noticeContact(result?.contact)) { ticket = generation; invalidated = true; }
      metadata = result;
      return Array.isArray(result?.messages) ? result.messages : [];
    };
    if (isOlder) {
      const cursor = older, rows = await page(cursor, 'timeline');
      if (!rows) return { stale: true };
      if (!invalidated) {
        historyMode = true; merge(rows, true);
        const next = rows.length ? historyCursor(rows.at(-1)) : '';
        if (rows.length >= pageSize && next === cursor) throw Error('Older-message refresh did not advance. Please try again.');
        older = rows.length >= pageSize ? next : '';
      }
    } else {
      let pages = 0;
      do {
        const initializing = !loaded;
        if (!initializing && !catchup) catchup = { before: '', stop: head, nextHead: '' };
        const requested = initializing ? '' : catchup.before;
        let rows = await page(requested, initializing ? 'timeline' : 'revision');
        if (!rows) return { stale: true };
        // A remote content deletion invalidates every old request and old media.
        // The current response can seed only messages newer than that boundary.
        if (!loaded) {
          if (invalidated && !initializing) rows = await page('', 'timeline');
          if (!rows) return { stale: true };
          if (metadata.revisionCursor && !decodeCursor(metadata.revisionCursor)) throw Error('WhatsApp inbox pagination is unavailable. Please refresh the chat.');
          merge(rows, false); loaded = true; head = metadata.revisionCursor || '';
          older = rows.length >= pageSize ? historyCursor(rows.at(-1)) : '';
          catchup = null; break;
        }
        if (!catchup) break;
        if (!catchup.nextHead) catchup.nextHead = rows[0]?._cursor || head;
        merge(rows, false);
        const last = rows.at(-1)?._cursor || '';
        const reached = !last || rows.length < pageSize || !!catchup.stop && compareCursors(last, catchup.stop) <= 0;
        if (reached) { head = catchup.nextHead || head; catchup = null; }
        else {
          if (last === requested) throw Error('Message refresh did not advance. Please try again.');
          catchup.before = last;
        }
        pages++;
      } while (catchup && pages < pagesPerPoll);
    }
    return { ...metadata, stale: false, invalidated, generation, peer, catchingUp: !!catchup };
  }
  return {
    records,
    get peer() { return peer; }, get generation() { return generation; },
    get olderCursor() { return older; }, get catchingUp() { return !!catchup; },
    get historyMode() { return historyMode; }, get hasNewer() { return hasNewer; },
    select(nextPeer) { peer = nextPeer; deletedAt = 0; clear(); },
    latest() { clear(); },
    noticeContact,
    load(fetchPage, { older: isOlder = false } = {}) {
      const ticket = generation, requestPeer = peer;
      const result = queue.then(() => perform(fetchPage, isOlder, ticket, requestPeer)).catch(error => {
        if (ticket !== generation || requestPeer !== peer) return { stale: true };
        throw error;
      });
      queue = result.catch(() => {}); return result;
    }
  };
}

// Contacts also arrive in revision order: a burst of more than one page must
// finish catching up without changing the owner's older-contact position.
export function createContactState({ pageSize = 50, pagesPerPoll = 4 } = {}) {
  const records = new Map();
  let loaded = false, head = '', older = '', catchup = null, queue = Promise.resolve();
  const merge = rows => { for (const row of rows) { if (!decodeCursor(row?._cursor)) throw Error('Contact pagination is unavailable.'); const old = records.get(row.key); if (!old || compareCursors(row._cursor, old._cursor) >= 0) records.set(row.key, row); } };
  async function perform(fetchPage, isOlder) {
    if (isOlder && (!loaded || !older)) return;
    if (!loaded || isOlder) {
      const requested = isOlder ? older : '', rows = await fetchPage(requested);
      merge(rows); const next = rows.at(-1)?._cursor || '';
      if (next && next === requested) throw Error('Contact history did not advance.');
      older = rows.length >= pageSize ? next : '';
      if (!loaded) { loaded = true; head = rows[0]?._cursor || ''; }
      return;
    }
    catchup ||= { before: '', stop: head, nextHead: '' };
    for (let count = 0; count < pagesPerPoll && catchup; count++) {
      const requested = catchup.before, rows = await fetchPage(requested); merge(rows);
      catchup.nextHead ||= rows[0]?._cursor || head;
      const last = rows.at(-1)?._cursor || '';
      if (!last || rows.length < pageSize || catchup.stop && compareCursors(last, catchup.stop) <= 0) { head = catchup.nextHead || head; catchup = null; }
      else { if (last === requested) throw Error('Contact refresh did not advance.'); catchup.before = last; }
    }
  }
  return { records, get olderCursor() { return older; }, get catchingUp() { return !!catchup; }, load(fetchPage, {older:isOlder=false} = {}) { const result = queue.then(() => perform(fetchPage,isOlder)); queue = result.catch(() => {}); return result; } };
}
