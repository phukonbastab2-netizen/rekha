// Owner-operated, loopback-only credential entry. Keys are never saved locally or logged.
import http from 'node:http';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
const session=randomBytes(32).toString('hex');
const account='17b4c6b100c17f80099c4d7eaf7ed744';
const worker='rekha-whatsapp-leads';
const csrf=randomBytes(32).toString('hex');
let origin, busy=false, saved=false;
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function request(method,url,token,body){return new Promise((resolve,reject)=>{
 const args=['--ipv4','--silent','--show-error','--max-time','45','--request',method,'--header','Authorization: Bearer '+token];
 if(body!==undefined)args.push('--header','Content-Type: application/json','--data-binary','@-');args.push(url);
 const child=spawn('curl.exe',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let result='',size=0;
 child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2e6)child.kill();else result+=chunk;});child.stderr.resume();
 child.on('error',()=>reject(new Error('Connection failed.')));child.on('close',code=>{if(code!==0)return reject(new Error('Connection failed.'));try{resolve(JSON.parse(result));}catch{reject(new Error('Unexpected service response.'));}});
 child.stdin.end(body);
});}
const page=()=>`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect OpenAI · Rekha Astrology</title><style>body{font:17px system-ui;background:#edf4ef;color:#152f26;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:420px;padding:30px;background:white;border-radius:20px;margin:20px;box-shadow:0 10px 50px #1232}h1{font-size:26px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:15px;border-radius:10px;margin:12px 0}input{border:1px solid #b4c9bd}button{background:#167947;color:white;border:0;cursor:pointer}p{line-height:1.5}.small{font-size:14px;color:#52675d}#result{white-space:pre-line}</style><main><h1>Connect OpenAI</h1><p>Enter your OpenAI API key for Rekha Astrology.</p><form method="post" action="/${session}/save"><input type="hidden" name="csrf" value="${csrf}"><label for="key">OpenAI API key</label><input id="key" name="key" type="password" required autocomplete="off" spellcheck="false" minlength="20" maxlength="1024"><button>Save securely to Cloudflare</button></form><p class="small">The key goes directly from this computer to your Cloudflare Worker. It is never saved in the app, GitHub or chat. Replies remain off during setup.</p><p class="small">Your OpenAI account must have API access. ${process.env.REKHA_APPROVED_CONNECTION_TEST==='true'?'This includes the owner-approved small connection test using existing API credit.':'This step checks the key without generating a paid reply.'}</p></main></html>`;
const server=http.createServer(async(req,res)=>{
 const security={'cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",'referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
 const respond=(status,body,type='text/html; charset=utf-8')=>{res.writeHead(status,{...security,'content-type':type});res.end(body);};
 if(req.headers.host!==new URL(origin).host)return respond(403,'Forbidden','text/plain');
 const path=new URL(req.url,origin).pathname;
 if(req.method==='GET'&&path===`/${session}`)return respond(200,saved?'<h1>OpenAI key saved securely.</h1><p>You can return to the chat. Replies are still off until setup is complete.</p>':page());
 // Some desktop browser form transports omit Origin. The unguessable URL,
 // exact Host and per-form CSRF token still authenticate that local submission.
 // Opaque desktop transport origins are allowed only with the same nonce and CSRF checks.
 // All other cross-origin requests are rejected.
 if(req.method!=='POST'||path!==`/${session}/save`||(req.headers.origin&&req.headers.origin!=='null'&&req.headers.origin!==origin))return respond(404,'Not found','text/plain');
 if(busy||saved)return respond(409,'Setup already submitted. Return to the chat.','text/plain');
 let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)return respond(413,'Too large','text/plain');}
 const fields=new URLSearchParams(body);if(!equal(fields.get('csrf'),csrf))return respond(403,'Forbidden','text/plain');
 let key=fields.get('key')?.trim();body='';fields.delete('key');
 if(!/^sk-[A-Za-z0-9_\-]{16,1020}$/.test(key||''))return respond(400,'Please enter a valid OpenAI API key. Use Back to try again.','text/plain');
 busy=true;
 try{
  const models=await request('GET','https://api.openai.com/v1/models',key);
  if(!Array.isArray(models.data))throw new Error('OpenAI did not accept the key. Check the key and project permissions, then use Back to try again.');
  const preferred=['gpt-6-luna'];const model=preferred.find(id=>models.data.some(m=>m.id===id));
  if(!model)throw new Error('The key works, but a supported reply model was not found. Return to the chat to select a model.');
  // Run only after owner approval for the small, noncustomer connection test.
  if(process.env.REKHA_APPROVED_CONNECTION_TEST==='true'){
   const probe=await request('POST','https://api.openai.com/v1/responses',key,JSON.stringify({model,input:'Reply with READY.',store:false,max_output_tokens:32,reasoning:{effort:'none'}}));
   if(probe.status!=='completed'||!probe.output?.some(item=>item.type==='message'&&item.content?.some(c=>c.type==='output_text'&&c.text?.trim())))throw new Error('The OpenAI reply test did not succeed. Check API credit and Responses permissions, then return to the chat.');
   console.log(JSON.stringify({openaiReplyTestPassed:true,model,testContainedCustomerData:false}));
  }
  const auth=fs.readFileSync(process.env.APPDATA+'/xdg.config/.wrangler/config/default.toml','utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  if(!auth)throw new Error('Cloudflare sign-in needs to be refreshed. Return to the chat.');
  const base=`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}`;
  const stored=await request('PUT',base+'/secrets',auth,JSON.stringify({name:'OPENAI_API_KEY',type:'secret_text',text:key}));
  if(!stored.success)throw new Error('Cloudflare could not save the key. Return to the chat.');
  key='';
  // Model/API version are configured separately during the controlled rollout.
  saved=true;console.log(JSON.stringify({openaiKeyStored:true,availablePreferredModel:model,sendingEnabled:false}));
  respond(200,'<meta name="viewport" content="width=device-width,initial-scale=1"><h1>OpenAI key saved securely.</h1><p>Return to the chat and say <b>done</b>. Replies remain off until the connection test is complete.</p>');
 }catch(error){key='';respond(400,error.message,'text/plain');}finally{busy=false;}
});
server.listen(0,'127.0.0.1',()=>{origin=`http://127.0.0.1:${server.address().port}`;console.log(JSON.stringify({url:origin+'/'+session,expiresMinutes:30}));});
setTimeout(()=>server.close(),30*60*1000).unref();
