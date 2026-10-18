import {mobile,bridge} from './mobile-worker.mjs';
const reply = (data, status = 200, extraHeaders = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders } });
export function backupFailure(error, now = Date.now()) {
  let current = error, quota = false;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    const message = String(current.message || '').toLowerCase();
    if (message.includes('d1') && message.includes('exceeded') && message.includes('daily row write limit')) quota = true;
  }
  if (quota) {
    const retryAt = (Math.floor(now / 86400000) + 1) * 86400000;
    return reply({ error: 'Cloud backup write limit reached', code: 'D1_WRITE_QUOTA', retryAt }, 503, { 'Retry-After': String(Math.max(1, Math.ceil((retryAt - now) / 1000))) });
  }
  return reply({ error: 'Request failed' }, 400);
}
const validSource = value => /^[a-f0-9-]{36}$/.test(value || '');
async function authorized(request, secret) {
  const provided = request.headers.get('Authorization') || '';
  if (!secret || provided.length > 300) return false;
  const hash = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([hash(provided), hash('Bearer ' + secret)]);
  return new Uint8Array(a).every((byte, i) => byte === new Uint8Array(b)[i]);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if(url.pathname==='/admin'||url.pathname.startsWith('/admin/')||url.pathname==='/downloads/rekha-whatsapp-admin.apk'||url.pathname==='/assets/qr-shahrukh-20261018.png'){
      try{return await mobile(request,env);}catch{return reply({error:'Request failed'},400);}
    }
    if (url.pathname === '/health' && request.method === 'GET') return reply({ service: 'rekha-openwa-private-backup', ok: true });
    if (!await authorized(request, env.BRIDGE_TOKEN)) return reply({ error: 'Unauthorized' }, 401);
    try {
      if(url.pathname.startsWith('/bridge/'))return await bridge(request,env);
      if(url.pathname==='/usage'&&request.method==='GET'){
        const measured=await env.DB.prepare('SELECT 1 AS ok FROM ow_backup LIMIT 1').all();
        return reply({databaseBytes:measured.meta?.size_after??null,checkedAt:Date.now()});
      }
      if (request.method === 'POST' && url.pathname === '/sync') {
        if (Number(request.headers.get('Content-Length') || 0) > 1000000) return reply({ error: 'Too large' }, 413);
        const raw = await request.text(); if (raw.length > 1000000) return reply({ error: 'Too large' }, 413);
        const { source, changes } = JSON.parse(raw);
        if (!validSource(source) || !Array.isArray(changes) || !changes.length || changes.length > 50) return reply({ error: 'Invalid batch' }, 400);
        const statements = changes.map(c => {
          if (!Number.isSafeInteger(c.seq) || c.seq < 1 || typeof c.key !== 'string' || c.key.length > 600 || !['contact','message','job','settings','deleted'].includes(c.kind) || typeof c.json !== 'string' || c.json.length > 30000 || typeof c.peer !== 'string' || c.peer.length > 80 || !Number.isSafeInteger(c.stamp)) throw Error('Invalid change');
          const value = JSON.parse(c.json); if (value.key !== c.key || value.kind !== c.kind) throw Error('Invalid record');
          return env.DB.prepare(`INSERT INTO ow_backup(source,key,kind,peer,revision,stamp,payload) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(source,key) DO UPDATE SET kind=excluded.kind,peer=excluded.peer,revision=excluded.revision,stamp=excluded.stamp,payload=excluded.payload WHERE excluded.revision>ow_backup.revision`).bind(source,c.key,c.kind,c.peer,c.seq,c.stamp,c.json);
        });
        const written=await env.DB.batch(statements);
        for (const c of changes) {
          const value = JSON.parse(c.json);
          if (value.kind === 'deleted' && /^[a-f0-9]{64}$/.test(value.mediaId || '')) {
            const current = (await env.DB.prepare('SELECT revision,kind FROM ow_backup WHERE source=? AND key=?').bind(source,c.key).all()).results[0];
            if (current?.revision === c.seq && current.kind === 'deleted') await env.MEDIA.delete('openwa-private/' + source + '/' + value.mediaId);
          }
        }
        return reply({ acknowledged: changes.at(-1).seq,databaseBytes:written?.at(-1)?.meta?.size_after??null });
      }
      if (request.method === 'GET' && url.pathname === '/records') {
        const source = url.searchParams.get('source'), cursor = url.searchParams.get('cursor') || '', kind = url.searchParams.get('kind');
        if (!validSource(source) || cursor.length > 600 || (kind && !['contact','message','job','settings','deleted'].includes(kind))) return reply({ error: 'Invalid query' }, 400);
        const statement = kind ? env.DB.prepare('SELECT key,revision,payload FROM ow_backup WHERE source=? AND kind=? AND key>? ORDER BY key LIMIT 100').bind(source,kind,cursor) : env.DB.prepare('SELECT key,revision,payload FROM ow_backup WHERE source=? AND key>? ORDER BY key LIMIT 100').bind(source,cursor);
        const rows = (await statement.all()).results;
        return reply({ records: rows, next: rows.length === 100 ? rows.at(-1).key : null });
      }
      const match = url.pathname.match(/^\/media\/([a-f0-9-]{36})\/([a-f0-9]{64})$/);
      if (match && request.method === 'PUT') {
        const size = Number(request.headers.get('Content-Length')), type = request.headers.get('Content-Type');
        if (!Number.isFinite(size) || size < 1 || size > 25 * 1024 * 1024 || !/^(image\/(jpeg|png|webp)|video\/mp4|audio\/(mpeg|ogg|mp4|wav)|application\/pdf)$/.test(type || '')) return reply({ error: 'Unsupported attachment' }, 400);
        const bytes = await request.arrayBuffer(); if (bytes.byteLength !== size) return reply({ error: 'Bad length' }, 400);
        await env.MEDIA.put('openwa-private/' + match[1] + '/' + match[2], bytes, { httpMetadata: { contentType: type } });
        return reply({ saved: true });
      }
      if (match && request.method === 'GET') {
        const object = await env.MEDIA.get('openwa-private/' + match[1] + '/' + match[2]);
        if (!object) return reply({ error: 'Not found' }, 404);
        return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': 'attachment', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      return reply({ error: 'Not found' }, 404);
    } catch (error) { return backupFailure(error); }
  }
};
