import {createHmac,randomBytes,scrypt as derive,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(derive),LIFE=30*86400000;
const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
export async function passwordHash(password){const salt=randomBytes(24).toString('hex');return salt+':'+Buffer.from(await scrypt(password,salt,64)).toString('hex');}
export class OwnerAuth {
 constructor(env,{now=Date.now}={}){
  this.now=now;this.hash=env.OWNER_PASSWORD_HASH;this.key=env.OWNER_SESSION_KEY;
  if(!/^[a-f0-9]{48}:[a-f0-9]{128}$/.test(this.hash||'')||!/^[a-f0-9]{64}$/.test(this.key||''))throw Error('owner_login_configuration_required');
  this.base=env.PUBLIC_BASE_PATH||'';if(this.base&&!/^\/[a-z0-9-]+$/.test(this.base))throw Error('invalid_public_base_path');
  this.attempts=new Map();this.global=[];this.inflight=0;
 }
 sign(value){return createHmac('sha256',this.key).update(this.hash+'|'+value).digest('base64url');}
 issue(){const value=this.now()+'.'+randomBytes(24).toString('hex');return value+'.'+this.sign(value);}
 valid(token){if(typeof token!=='string'||token.length>200)return false;const parts=token.split('.');if(parts.length!==3||!/^\d{13}$/.test(parts[0])||!/^[a-f0-9]{48}$/.test(parts[1]))return false;const age=this.now()-Number(parts[0]);return age>=0&&age<LIFE&&same(parts[2],this.sign(parts[0]+'.'+parts[1]));}
 cookie(token,secure){return 'rekha_owner='+token+'; HttpOnly; SameSite=Strict; Path='+(this.base||'/')+'; Max-Age='+(token?LIFE/1000:0)+(secure?'; Secure':'');}
 authenticated(req){const c=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('rekha_owner='))?.slice(12);return this.valid(c);}
 async login(password,ip='local'){
  const now=this.now();this.global=this.global.filter(t=>t>now-60000);
  for(const [key,value]of this.attempts)if(value.until<=now)this.attempts.delete(key);
  const state=this.attempts.get(ip);if(this.global.length>=60||this.inflight>=2||state?.count>=5)return {ok:false,status:429};
  this.global.push(now);this.attempts.set(ip,{count:(state?.count||0)+1,until:state?.until||now+15*60000});
  if(this.attempts.size>10000)return {ok:false,status:429};
  if(typeof password!=='string'||Buffer.byteLength(password)>256)return {ok:false,status:401};
  this.inflight++;let ok=false;
  try{const [salt,hash]=this.hash.split(':');ok=same(Buffer.from(await scrypt(password,salt,64)).toString('hex'),hash);}finally{this.inflight--;}
  if(ok){this.attempts.delete(ip);return {ok:true,status:200,token:this.issue()};}return {ok:false,status:401};
 }
}
