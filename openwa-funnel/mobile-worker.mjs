import {mobileAssets} from './mobile-assets.mjs';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
const json=(value,status=200,extra={})=>Response.json(value,{status,headers:{...headers,...extra}});
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export const hash=async value=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const sourceOk=value=>/^[a-f0-9-]{36}$/.test(value||'');
const peerOk=value=>typeof value==='string'&&/^[0-9]{5,25}@(c\.us|lid|s\.whatsapp\.net)$/.test(value);
const idOk=value=>typeof value==='string'&&/^[a-zA-Z0-9-]{10,80}$/.test(value);
const first=async statement=>(await statement.all()).results[0];
async function body(request,max=12000){const raw=await request.text();if(raw.length>max)throw Error('Request too large');return JSON.parse(raw||'{}');}
const cookie=(token,age=2592000)=>`ow_mobile=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
function cleanStatus(s){return{connection:['connected','starting','error','disconnected','scan_qr','enter_code','restarting'].includes(s?.connection)?s.connection:'disconnected',enabled:!!s?.enabled,contacts:Number(s?.contacts)||0,queued:Number(s?.queued)||0,uncertain:Number(s?.uncertain)||0,cloud:['synced','retrying','waiting'].includes(s?.cloud)?s.cloud:'waiting',monitor:s?.monitor||null};}
export async function bridge(request,env){
  const url=new URL(request.url),now=Date.now();
  if(url.pathname==='/bridge/releases/admin'&&request.method==='PUT'){
    const bytes=await request.arrayBuffer();if(bytes.byteLength<1000||bytes.byteLength>15000000||new Uint8Array(bytes)[0]!==80||new Uint8Array(bytes)[1]!==75)return json({error:'Invalid APK'},400);
    await env.MEDIA.put('openwa-public/rekha-whatsapp-admin.apk',bytes,{httpMetadata:{contentType:'application/vnd.android.package-archive'}});
    return json({bytes:bytes.byteLength,sha256:hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))});
  }
  if(request.method!=='POST')return json({error:'Not found'},404);
  const input=await body(request,40000);if(!sourceOk(input.source))return json({error:'Invalid source'},400);
  if(url.pathname==='/bridge/pairings'){
    if(!/^[a-f0-9]{64}$/.test(input.hash||'')||!Number.isSafeInteger(input.expires)||input.expires<now||input.expires>now+610000)return json({error:'Invalid pairing'},400);
    await env.DB.prepare('INSERT INTO ow_mobile_pairings(hash,source,expires) VALUES(?,?,?)').bind(input.hash,input.source,input.expires).run();return json({ok:true});
  }
  if(url.pathname==='/bridge/revoke'){
    await env.DB.batch([env.DB.prepare('DELETE FROM ow_mobile_sessions WHERE source=?').bind(input.source),env.DB.prepare('DELETE FROM ow_mobile_pairings WHERE source=?').bind(input.source)]);return json({ok:true});
  }
  if(url.pathname==='/bridge/poll'){
    await env.DB.prepare('INSERT INTO ow_gateway_status VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET payload=excluded.payload,stamp=excluded.stamp').bind(input.source,JSON.stringify(cleanStatus(input.status)),now).run();
    if(Array.isArray(input.results))for(const item of input.results.slice(0,20)){
      if(!idOk(item.id))continue;
      const result={ok:!!item.result?.ok,...(typeof item.result?.more==='boolean'?{more:item.result.more}:{}),...(typeof item.result?.error==='string'?{error:item.result.error.slice(0,200)}:{})};
      await env.DB.prepare("UPDATE ow_mobile_commands SET state='done',result=? WHERE source=? AND id=? AND state='queued'").bind(JSON.stringify(result),input.source,item.id).run();
    }
    if(input.cleanup===true)await env.DB.batch([
      env.DB.prepare('DELETE FROM ow_mobile_pairings WHERE expires<?').bind(now),env.DB.prepare('DELETE FROM ow_mobile_sessions WHERE expires<?').bind(now),env.DB.prepare('DELETE FROM ow_mobile_rate WHERE expires<?').bind(now),env.DB.prepare('DELETE FROM ow_mobile_commands WHERE expires<?').bind(now-7*86400000)
    ]);
    const commands=(await env.DB.prepare("SELECT id,action,payload,expires FROM ow_mobile_commands WHERE source=? AND state='queued' AND expires>? ORDER BY created LIMIT 10").bind(input.source,now).all()).results;
    return json({commands:commands.map(c=>({...c,payload:JSON.parse(c.payload)}))});
  }
  return json({error:'Not found'},404);
}
export async function mobile(request,env){
  const url=new URL(request.url),route=url.pathname,now=Date.now();
  if(route==='/downloads/rekha-whatsapp-admin.apk'){
    const object=await env.MEDIA.get('openwa-public/rekha-whatsapp-admin.apk');if(!object)return json({error:'APK not available yet'},404);
    return new Response(object.body,{headers:{'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="RekhaWhatsAppAdmin.apk"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(request.method==='GET'&&mobileAssets[route]){const asset=mobileAssets[route];return new Response(asset.body,{headers:{...headers,'Content-Type':asset.type}});}
  if(!route.startsWith('/admin/api/'))return json({error:'Not found'},404);
  if(['cross-site','same-site'].includes(request.headers.get('Sec-Fetch-Site')))return json({error:'Forbidden'},403);
  if(request.method!=='GET'&&(request.headers.get('Origin')!==url.origin||!request.headers.get('Content-Type')?.startsWith('application/json')))return json({error:'Forbidden'},403);
  if(route==='/admin/api/login'&&request.method==='POST'){
    const input=await body(request,1000),code=typeof input.code==='string'?input.code.toUpperCase().replace(/[ -]/g,''):'';
    if(!/^[A-F0-9]{20}$/.test(code))return json({error:'Enter the admin sign-in code from your private panel.'},400);
    const key=await hash((request.headers.get('CF-Connecting-IP')||'unknown')+':'+Math.floor(now/60000));
    const rate=await first(env.DB.prepare('INSERT INTO ow_mobile_rate VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,now+120000));
    if(rate.count>5)return json({error:'Too many attempts. Wait a minute.'},429);
    const match=await first(env.DB.prepare('UPDATE ow_mobile_pairings SET used=1 WHERE hash=? AND used=0 AND expires>? RETURNING source').bind(await hash(code),now));
    if(!match)return json({error:'Code expired or already used. Generate a new admin code.'},401);
    const token=random();await env.DB.prepare('INSERT INTO ow_mobile_sessions VALUES(?,?,?)').bind(await hash(token),match.source,now+30*86400000).run();
    return json({ok:true},200,{'Set-Cookie':cookie(token)});
  }
  const token=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ow_mobile='))?.slice(10)||'';
  if(!/^[a-f0-9]{64}$/.test(token))return json({error:'Sign in to your admin app.'},401);
  const sessionHash=await hash(token),session=await first(env.DB.prepare('SELECT source,expires FROM ow_mobile_sessions WHERE hash=? AND expires>?').bind(sessionHash,now));
  if(!session)return json({error:'Your admin session expired. Sign in again.'},401);
  const source=session.source;
  if(route==='/admin/api/logout'&&request.method==='POST'){await env.DB.prepare('DELETE FROM ow_mobile_sessions WHERE hash=?').bind(sessionHash).run();return json({ok:true},200,{'Set-Cookie':cookie('',0)});}
  if(route==='/admin/api/status'&&request.method==='GET'){
    const status=await first(env.DB.prepare('SELECT payload,stamp FROM ow_gateway_status WHERE source=?').bind(source));
    return json(status?{...JSON.parse(status.payload),updatedAt:status.stamp,online:now-status.stamp<60000}:{connection:'disconnected',online:false});
  }
  if(route==='/admin/api/contacts'&&request.method==='GET'){
    const before=Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER,key=url.searchParams.get('key')||'\uffff';
    const rows=(await env.DB.prepare("SELECT key,stamp,payload FROM ow_backup WHERE source=? AND kind='contact' AND (stamp,key)<(?,?) ORDER BY stamp DESC,key DESC LIMIT 50").bind(source,before,key).all()).results;
    return json(rows.map(r=>({...JSON.parse(r.payload),_stamp:r.stamp})));
  }
  if(route==='/admin/api/messages'&&request.method==='GET'){
    const peer=url.searchParams.get('peer');if(!peerOk(peer))return json({error:'Invalid customer'},400);
    const contact=await first(env.DB.prepare("SELECT payload FROM ow_backup WHERE source=? AND kind='contact' AND key=?").bind(source,'contact:'+peer));
    if(!contact)return json({error:'Customer not found'},404);
    const before=Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER,key=url.searchParams.get('key')||'\uffff';
    const messages=(await env.DB.prepare("SELECT stamp,payload FROM ow_backup WHERE source=? AND kind='message' AND peer=? AND (stamp,key)<(?,?) ORDER BY stamp DESC,key DESC LIMIT 50").bind(source,peer,before,key).all()).results;
    const jobs=(await env.DB.prepare("SELECT payload FROM ow_backup WHERE source=? AND kind='job' AND peer=? AND json_extract(payload,'$.state')='unknown' LIMIT 20").bind(source,peer).all()).results;
    return json({contact:JSON.parse(contact.payload),messages:messages.map(r=>({...JSON.parse(r.payload),_stamp:r.stamp})),jobs:jobs.map(r=>JSON.parse(r.payload))});
  }
  const media=route.match(/^\/admin\/api\/media\/([a-f0-9]{64})$/);
  if(media&&request.method==='GET'){
    const object=await env.MEDIA.get('openwa-private/'+source+'/'+media[1]);if(!object)return json({error:'Attachment not found'},404);
    return new Response(object.body,{headers:{...headers,'Content-Type':object.httpMetadata?.contentType||'application/octet-stream','Content-Disposition':'attachment; filename="customer-attachment"'}});
  }
  if(route==='/admin/api/commands'&&request.method==='POST'){
    const input=await body(request),p=input.payload||{},action=input.action;
    if(!idOk(input.id)||!['send','enabled','pause','payment','seen','resolve','delete'].includes(action))return json({error:'Invalid action'},400);
    const existing=await first(env.DB.prepare('SELECT action,payload,state,result FROM ow_mobile_commands WHERE source=? AND id=?').bind(source,input.id));
    if(existing){if(existing.action!==action||existing.payload!==JSON.stringify(p))return json({error:'Request ID was already used for a different action.'},409);return json({id:input.id,state:existing.state,result:existing.result?JSON.parse(existing.result):null});}
    const status=await first(env.DB.prepare('SELECT stamp FROM ow_gateway_status WHERE source=?').bind(source));
    if(!status||now-status.stamp>60000)return json({error:'Your WhatsApp server is offline. Try again when it reconnects.'},503);
    if(action==='enabled'){if(typeof p.enabled!=='boolean')return json({error:'Invalid setting'},400);}
    else {
      if(!peerOk(p.peer))return json({error:'Invalid customer'},400);
      const row=await first(env.DB.prepare("SELECT payload FROM ow_backup WHERE source=? AND kind='contact' AND key=?").bind(source,'contact:'+p.peer));if(!row)return json({error:'Customer not found'},404);
      if(action==='send'&&(JSON.parse(row.payload).optedOut||typeof p.body!=='string'||!p.body.trim()||p.body.length>8000))return json({error:'Message is empty, too long, or customer opted out.'},400);
      if(action==='pause'&&typeof p.paused!=='boolean'||action==='payment'&&typeof p.verified!=='boolean')return json({error:'Invalid setting'},400);
      if(action==='resolve'&&(!['sent','skip','retry'].includes(p.action)||typeof p.key!=='string'||p.key.length>600))return json({error:'Invalid resolution'},400);
      if(action==='delete'&&p.confirm!=='DELETE CHAT CONTENT')return json({error:'Confirmation required'},400);
    }
    await env.DB.prepare('INSERT INTO ow_mobile_commands(source,id,action,payload,created,expires) VALUES(?,?,?,?,?,?)').bind(source,input.id,action,JSON.stringify(p),now,now+300000).run();return json({id:input.id,state:'queued'},202);
  }
  const command=route.match(/^\/admin\/api\/commands\/([a-zA-Z0-9-]{10,80})$/);
  if(command&&request.method==='GET'){
    const row=await first(env.DB.prepare('SELECT state,result,expires FROM ow_mobile_commands WHERE source=? AND id=?').bind(source,command[1]));if(!row)return json({error:'Not found'},404);
    return json({state:row.state==='queued'&&row.expires<now?'expired':row.state,result:row.result?JSON.parse(row.result):null});
  }
  return json({error:'Not found'},404);
}
