import http from 'node:http';
import fs from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Inbox} from './inbox.mjs';
process.umask(0o077);
const env={...process.env};
if(!env.SQLITE_PATH||!env.ADMIN_TOKEN||!env.META_ACCESS_TOKEN||!/^https:\/\//.test(env.FUNNEL_ORIGIN||''))throw Error('private_configuration_required');
const inbox=new Inbox(env.SQLITE_PATH,env),port=Number(env.PORT||4342),session=randomBytes(32).toString('hex');
const html=fs.readFileSync(new URL('./inbox.html',import.meta.url));
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
let active=0;
const server=http.createServer(async(req,res)=>{
 active++;res.once('close',()=>active--);
 const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
 const host=req.headers.host;
 if(!['127.0.0.1:'+port,'localhost:'+port].includes(host))return reply(403,{error:'Private owner connection required.'});
 const url=new URL(req.url,'http://'+host);
 if(url.pathname==='/'&&req.method==='GET'){
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','set-cookie':'rekha_oracle_session='+session+'; HttpOnly; SameSite=Strict; Path=/',
   'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src https: data:; media-src https:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'x-content-type-options':'nosniff'});return res.end(html);
 }
 const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('rekha_oracle_session='))?.slice('rekha_oracle_session='.length);
 if(!equal(cookie,session))return reply(401,{error:'Open the private inbox again to reconnect.'});
 if(req.method==='POST'&&(req.headers.origin!=='http://'+host||!String(req.headers['content-type']||'').startsWith('application/json')))return reply(403,{error:'Open the private owner page to send.'});
 try{
  if(req.method==='GET'&&url.pathname==='/api/status')return reply(200,inbox.status());
  if(req.method==='GET'&&url.pathname==='/api/chats')return reply(200,{chats:inbox.chats(url.searchParams.get('q')||'')});
  if(req.method==='GET'&&url.pathname==='/api/messages'){
   const id=url.searchParams.get('id');if(!/^[a-f0-9]{64}$/i.test(id||''))return reply(400,{error:'Choose a conversation.'});
   return reply(200,{messages:inbox.messages(id,url.searchParams.get('before'))});
  }
  if(req.method==='POST'&&['/api/send','/api/sync'].includes(url.pathname)){
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>20000)return reply(413,{error:'Message too long.'});chunks.push(chunk);}
   let value;try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{return reply(400,{error:'Invalid request.'});}
   if(url.pathname==='/api/sync'){await inbox.sync({force:true});return reply(200,inbox.status());}
   return reply(200,await inbox.manualReply(value));
  }
  return reply(404,{error:'Not found.'});
 }catch(error){return reply(error.status||503,{error:error.status?error.message:'The connection is temporarily unavailable. Your message has not been retried.'});}
});
server.headersTimeout=10000;server.requestTimeout=30000;
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'rekha-oracle-manual-inbox',port,automaticFunnel:false})));
const sync=()=>inbox.sync().catch(()=>{});sync();const timer=setInterval(sync,10000);timer.unref();
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);server.close();const deadline=Date.now()+25000;while((active||inbox.syncing||inbox.serial.size)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));inbox.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
