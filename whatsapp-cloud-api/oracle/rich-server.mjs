import http from 'node:http';
import fs from 'node:fs';
import {OwnerAuth} from './owner-auth.mjs';
import {Readable,Transform} from 'node:stream';
import {RichInbox} from './rich-inbox.mjs';
import {firstSequence} from '../funnel.mjs';
process.umask(0o077);
const env={...process.env};
if(!env.SQLITE_PATH||!env.ADMIN_TOKEN||!env.META_ACCESS_TOKEN||!/^https:\/\//.test(env.FUNNEL_ORIGIN||''))throw Error('private_configuration_required');
const inbox=new RichInbox(env.SQLITE_PATH,env),port=Number(env.PORT||4342),auth=new OwnerAuth(env),base=auth.base;
const publicOrigin=env.PUBLIC_ORIGIN||'';
if(publicOrigin&&!/^https:\/\/[a-z0-9.-]+$/.test(publicOrigin))throw Error('invalid_public_origin');
const html=fs.readFileSync(new URL('./inbox.html',import.meta.url),'utf8').replaceAll('__BASE__',base);
const loginHtml=fs.readFileSync(new URL('./login.html',import.meta.url),'utf8').replaceAll('__BASE__',base);
let active=0,uploadRequests=0,lastViewerAt=0,stopping=false;
const server=http.createServer(async(req,res)=>{
 active++;res.once('close',()=>active--);const reply=(status,value)=>{if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
 const host=req.headers.host,local=['127.0.0.1:'+port,'localhost:'+port].includes(host),secure=Boolean(publicOrigin&&host===new URL(publicOrigin).host);
 if(!local&&!secure)return reply(403,{error:'Use the owner inbox address.'});
 const origin=secure?publicOrigin:'http://'+host,url=new URL(req.url,origin);
 res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-robots-tag','noindex, nofollow');res.setHeader('cache-control','no-store');
 if(secure)res.setHeader('strict-transport-security','max-age=31536000');
 if(base&&url.pathname===base||local&&base&&url.pathname==='/'){res.writeHead(302,{location:base+'/'});return res.end();}
 if(base&&!url.pathname.startsWith(base+'/'))return reply(404,{error:'Not found.'});
 url.pathname=url.pathname.slice(base.length)||'/';
 const allowedOrigin=req.headers.origin===origin;
 if(req.method==='POST'&&(!allowedOrigin||!(/^(application\/json|multipart\/form-data)(;|$)/.test(String(req.headers['content-type']||'')))||['cross-site','same-site'].includes(req.headers['sec-fetch-site'])))return reply(403,{error:'Use the owner inbox page.'});
 const page=value=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(value);};
 if(url.pathname==='/downloads/RekhaInbox.apk'&&req.method==='GET'){
  const path=new URL('./downloads/RekhaInbox.apk',import.meta.url);if(!fs.existsSync(path))return reply(404,{error:'Android app is being prepared.'});
  const stat=fs.statSync(path);res.writeHead(200,{'content-type':'application/vnd.android.package-archive','content-disposition':'attachment; filename="RekhaInbox.apk"','content-length':stat.size,'cache-control':'public, max-age=300'});return fs.createReadStream(path).pipe(res);
 }
 if(url.pathname==='/auth/login'&&req.method==='POST'){
  try{let length=0;const chunks=[];for await(const c of req){length+=c.length;if(length>1024)return reply(413,{error:'Request too large.'});chunks.push(c);}const value=JSON.parse(Buffer.concat(chunks).toString());
   const ip=secure?String(req.headers['cf-connecting-ip']||'public').slice(0,64):'local';const result=await auth.login(value.password,ip);
   if(!result.ok)return reply(result.status,{error:result.status===429?'Please try again later.':'Incorrect password.'});
   res.setHeader('set-cookie',auth.cookie(result.token,secure));return reply(200,{ok:true});
  }catch{return reply(400,{error:'Invalid request.'});}
 }
 const signedIn=auth.authenticated(req);
 if(url.pathname==='/'&&req.method==='GET')return page(signedIn?html:loginHtml);
 if(!signedIn)return reply(401,{error:'Please sign in to your inbox.'});lastViewerAt=Date.now();
 if(url.pathname==='/auth/logout'&&req.method==='POST'){res.setHeader('set-cookie',auth.cookie('',secure));return reply(200,{ok:true});}
 if(url.pathname==='/app.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/javascript; charset=utf-8'});return res.end(fs.readFileSync(new URL('./app.js',import.meta.url)));}
 try{
  if(req.method==='GET'){
   if(url.pathname==='/api/status')return reply(200,inbox.status());
   if(url.pathname==='/api/chats')return reply(200,inbox.chatPage({search:url.searchParams.get('q')||'',filter:url.searchParams.get('filter')||'all',after:url.searchParams.get('after')}));
   if(url.pathname==='/api/messages')return reply(200,inbox.messagePage(url.searchParams.get('id'),{after:url.searchParams.get('after'),search:url.searchParams.get('q')||'',starred:url.searchParams.get('starred')==='true'}));
   if(url.pathname==='/api/payment-config')return reply(200,{amount:29,currency:'INR',qrUrl:firstSequence[3].url});
   if(url.pathname==='/api/events'){
    const after=Number(url.searchParams.get('after'))||0,until=Date.now()+20000;
    while(!res.destroyed&&!stopping&&inbox.version===after&&Date.now()<until)await new Promise(r=>setTimeout(r,300));
    return reply(200,{version:inbox.version,status:inbox.status()});
   }
   if(url.pathname==='/api/media'){
    const mediaId=inbox.mediaId({message:url.searchParams.get('message'),upload:url.searchParams.get('upload')});
    const upstream=await inbox.media.download(mediaId,req.headers.range);const type=(upstream.headers.get('content-type')||'application/octet-stream').split(';')[0];
    const inline=/^(image\/(jpeg|png|webp)|audio\/(ogg|mpeg|mp4|aac|amr)|video\/(mp4|3gpp))$/.test(type);
    const headers={'content-type':inline?type:'application/octet-stream','cache-control':'private, max-age=60','x-content-type-options':'nosniff','content-disposition':inline?'inline':'attachment; filename="WhatsApp file"'};
    for(const key of ['content-length','content-range','accept-ranges'])if(upstream.headers.has(key))headers[key]=upstream.headers.get(key);
    res.writeHead(upstream.status,headers);let bytes=0;
    const guard=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;callback(bytes>100*1024*1024?Error('media_limit'):null,chunk);}});
    const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.destroy());guard.on('error',()=>{stream.destroy();res.destroy();});res.on('close',()=>stream.destroy());return stream.pipe(guard).pipe(res);
   }
  }
  if(req.method==='POST'&&url.pathname==='/api/upload'){
   if(uploadRequests>=2)return reply(429,{error:'Please wait for the current uploads.'});uploadRequests++;
   try{
    const id=req.headers['x-contact-id'];await inbox.preflight(id);
    if(Number(req.headers['content-length'])>101*1024*1024)return reply(413,{error:'File exceeds 100 MB.'});
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>101*1024*1024)return reply(413,{error:'File exceeds 100 MB.'});chunks.push(chunk);}
    const form=await new Request('https://upload.internal',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData();const file=form.get('file');
    if(!file||typeof file.arrayBuffer!=='function')return reply(400,{error:'Choose a file.'});return reply(200,await inbox.upload(id,file,{voice:form.get('voice')==='true'}));
   }finally{uploadRequests--;}
  }
  if(req.method==='POST'){
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>20000)return reply(413,{error:'Request too large.'});chunks.push(chunk);}
   let value;try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{return reply(400,{error:'Invalid request.'});}
   if(url.pathname==='/api/send')return reply(200,await inbox.manualReply(value));
   if(url.pathname==='/api/sync'){await inbox.sync({force:true});return reply(200,inbox.status());}
   if(url.pathname==='/api/chat/action')return reply(200,inbox.chatAction(value));
   if(url.pathname==='/api/star')return reply(200,inbox.star(value));
   if(url.pathname==='/api/payment')return reply(200,inbox.payment(value));
  }
  return reply(404,{error:'Not found.'});
 }catch(error){return reply(error.status||503,{error:error.status?error.message:'The connection is temporarily unavailable. A possible send will not be retried automatically.'});}
});
server.headersTimeout=10000;server.requestTimeout=120000;
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'rekha-oracle-manual-inbox',port,automaticFunnel:false})));
let timer,failures=0;
async function pulse(){try{await inbox.sync();failures=0;}catch{failures++;}if(!stopping)timer=setTimeout(pulse,failures?Math.min(120000,10000*2**Math.min(failures,4)):Date.now()-lastViewerAt<30000?3000:30000);}
pulse();
async function stop(){if(stopping)return;stopping=true;clearTimeout(timer);server.close();const deadline=Date.now()+30000;while((active||inbox.syncing||inbox.serial.size||inbox.media.uploading)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));inbox.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
