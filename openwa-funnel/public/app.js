import { createApi } from './api.js';
const api = createApi();
const $ = id => document.getElementById(id);
const element = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
let selected = '', enabled = false, currentContact, contacts = [], contactCursor = '', messageCursor = '', currentMessages = new Map(), polling = false, posting = false;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; setTimeout(() => $('toast').hidden = true, 4500); }
function contactList() {
  $('contacts').replaceChildren(); $('empty').hidden = contacts.length > 0;
  for (const c of contacts) {
    const button = element('button', undefined, 'contact' + (c.peer === selected ? ' active' : ''));
    button.append(element('strong', c.name || c.peer.split('@')[0]));
    if (c.unread) button.firstChild.append(element('span', String(c.unread), 'count'));
    button.append(element('small', c.preview)); button.onclick = () => choose(c.peer); $('contacts').append(button);
  }
}
async function choose(peer) {
  selected = peer; currentMessages.clear(); messageCursor = ''; contactList();
  try { await api('seen', { peer }); } catch { toast('Chat opened. WhatsApp read receipt is not confirmed.'); }
  await loadMessages();
}
async function loadContacts(older = false) {
  const rows = await api('contacts' + (older && contactCursor ? '?before=' + encodeURIComponent(contactCursor) : ''));
  if (older) contacts = [...contacts, ...rows.filter(r => !contacts.some(c => c.key === r.key))];
  else { const ids = new Set(rows.map(c => c.key)); contacts = [...rows, ...contacts.filter(c => !ids.has(c.key))]; }
  if (older || !contactCursor) contactCursor = rows.at(-1)?._cursor || '';
  $('moreContacts').hidden = rows.length < 50; contactList();
}
async function loadMessages(older = false) {
  if (!selected) return;
  const peer = selected, result = await api('messages?peer=' + encodeURIComponent(peer) + (older && messageCursor ? '&before=' + encodeURIComponent(messageCursor) : ''));
  if (selected !== peer) return;
  currentContact = result.contact;
  if (!currentContact) return;
  $('name').textContent = currentContact.name || currentContact.peer.split('@')[0];
  $('details').textContent = `${currentContact.peer.split('@')[0]} · ${currentContact.optedOut ? 'Opted out' : currentContact.paused ? 'Automation paused' : 'Automation ready'} · Payment: ${currentContact.payment.replaceAll('_', ' ')}`;
  $('chatActions').hidden = false; $('composer').hidden = false;
  $('pause').textContent = currentContact.paused ? 'Resume automation' : 'Pause automation';
  $('payment').textContent = currentContact.payment === 'verified_by_owner' ? 'Mark payment pending' : 'Verify payment';
  $('reply').disabled = !!currentContact.optedOut; $('send').disabled = !!currentContact.optedOut || posting;
  for (const m of result.messages) currentMessages.set(m.key, m);
  if (older || !messageCursor) messageCursor = result.messages.at(-1)?._cursor || '';
  const list = $('messages'), nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const oldHeight = list.scrollHeight, oldTop = list.scrollTop;
  list.replaceChildren();
  if (messageCursor && currentMessages.size >= 50) { const b = element('button', 'Load older messages', 'older'); b.onclick = () => loadMessages(true).catch(e => toast(e.message)); list.append(b); }
  for (const m of [...currentMessages.values()].sort((a,b) => a.at - b.at || a.key.localeCompare(b.key))) {
    const bubble = element('div', undefined, 'message ' + (m.direction === 'out' ? 'out' : 'in'));
    if (m.body) bubble.append(element('div', m.body, 'text'));
    if (m.url) { const a = element('a', 'View ' + m.type); a.href = m.url; a.target = '_blank'; a.rel = 'noreferrer noopener'; bubble.append(a); }
    if (m.media) { const a = element('a', 'Download customer attachment'); a.href = '/media/' + m.media.id; a.download = 'whatsapp-attachment'; bubble.append(a); }
    if (m.attachmentError) bubble.append(element('p', m.attachmentError));
    bubble.append(element('div', new Date(m.at).toLocaleString([], { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) + ' · ' + m.status, 'meta')); list.append(bubble);
  }
  if (older) list.scrollTop = oldTop + list.scrollHeight - oldHeight; else if (nearBottom || !oldHeight) list.scrollTop = list.scrollHeight;
  $('uncertain').replaceChildren(); $('uncertain').hidden = !result.jobs.length;
  for (const job of result.jobs) {
    $('uncertain').append(element('p', 'A send has an uncertain outcome. Check this chat in WhatsApp before deciding.'));
    for (const [action, label] of [['sent','I checked: it was sent'],['skip','Skip this message'],['retry','I checked: retry once']]) {
      const button = element('button', label); button.onclick = async () => { try { await api('resolve', { peer, key: job.key, action }); await loadMessages(); } catch (e) { toast(e.message); } }; $('uncertain').append(button);
    }
  }
}
async function refresh() {
  if (polling) return; polling = true;
  try {
    const status = await api('status'); enabled = status.enabled;
    $('connection').textContent = status.connection.replaceAll('_', ' '); $('connection').className = 'badge ' + status.connection;
    $('connect').disabled = ['connected','starting','scan_qr','enter_code','restarting'].includes(status.connection);
    $('linkOptions').hidden = !status.canPairWithPhone || status.connection === 'connected';
    $('generateCode').disabled = $('useQr').disabled = ['starting','restarting','connected'].includes(status.connection);
    $('toggle').textContent = enabled ? 'Pause funnel' : 'Enable funnel';
    $('summary').textContent = `${status.contacts} customers · ${status.queued} queued · ${status.uncertain} need checking`;
    $('backup').textContent = `Cloud backup: ${status.cloud.replaceAll('_', ' ')}${status.backupPending ? ' · ' + status.backupPending + ' changes pending' : ''}`;
    $('pairing').hidden = !status.qr && !status.pairingCode;
    $('codePanel').hidden = !status.pairingCode; $('pairCode').textContent = status.pairingCode || '';
    $('qr').hidden = !status.qr;
    if (status.qr && $('qr').getAttribute('src') !== status.qr) $('qr').src = status.qr;
    if (!status.qr) $('qr').removeAttribute('src');
    if (status.error) $('summary').textContent = status.error;
    await loadContacts(); await loadMessages();
  } catch (e) { $('connection').textContent = 'Reconnecting to gateway…'; } finally { polling = false; }
}
$('connect').onclick = async () => { try { await api('connect', {}); await refresh(); } catch(e) { toast(e.message); } };
async function requestPairing(mode) {
  $('generateCode').disabled = $('useQr').disabled = true;
  try { await api('pairing', { mode, ...(mode === 'phone' ? {phone:$('pairPhone').value} : {}) }); toast('Preparing your link. The private service will restart; keep this page open.'); }
  catch (e) { toast(e.message); }
  await refresh();
}
$('phonePairing').onsubmit = event => { event.preventDefault(); void requestPairing('phone'); };
$('useQr').onclick = () => void requestPairing('qr');
$('toggle').onclick = async () => { try { await api('enabled', { enabled: !enabled }); await refresh(); } catch(e) { toast(e.message); } };
$('refresh').onclick = refresh;
$('moreContacts').onclick = () => loadContacts(true).catch(e => toast(e.message));
$('pause').onclick = async () => { try { await api('pause', { peer:selected, paused:!currentContact.paused }); await loadMessages(); } catch(e) { toast(e.message); } };
$('payment').onclick = async () => { const verified = currentContact.payment !== 'verified_by_owner'; if (verified && !confirm('Have you independently checked that the ₹29 payment reached your account? A screenshot alone is not confirmation.')) return; try { await api('payment', { peer:selected, verified }); await loadMessages(); } catch(e) { toast(e.message); } };
let draftId = '';
$('composer').onsubmit = async event => {
  event.preventDefault(); const text = $('reply').value.trim(), peer = selected; if (!text || posting) return;
  posting = true; $('send').disabled = true; draftId ||= crypto.randomUUID();
  try { await api('send', { peer, body:text, requestId:draftId }); if (selected === peer) $('reply').value = ''; draftId = ''; toast('Reply queued. Delivery status will update after WhatsApp accepts it.'); await loadMessages(); }
  catch(e) { toast(e.message + '. Retrying this same draft will not duplicate it.'); }
  finally { posting = false; $('send').disabled = false; }
};
$('reply').oninput = () => { draftId = ''; };
void refresh(); setInterval(refresh, 3000);
