export const REWARDED_UNIT='ca-app-pub-1925059485391491/8048976367';
const KEY_URL='https://www.gstatic.com/admob/reward/verifier-keys.json';
const rewardError=(status,message)=>Object.assign(new Error(message),{status});
const fromBase64=text=>Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
// Google sends ASN.1 DER ECDSA; Web Crypto accepts fixed-width P1363 r||s.
export function rewardSignature(bytes){
  let p=0;if(bytes[p++]!==48)throw rewardError(400,'Invalid signature.');
  const length=bytes[p++];if(length!==bytes.length-2)throw rewardError(400,'Invalid signature.');
  const out=new Uint8Array(64);
  for(let part=0;part<2;part++){
    if(bytes[p++]!==2)throw rewardError(400,'Invalid signature.');const n=bytes[p++];
    if(n<1||n>33||p+n>bytes.length||bytes[p]&128)throw rewardError(400,'Invalid signature.');
    let component=bytes.slice(p,p+n);p+=n;if(component.length===33){if(component[0]!==0)throw rewardError(400,'Invalid signature.');component=component.slice(1);}
    out.set(component,part*32+32-component.length);
  }
  if(p!==bytes.length)throw rewardError(400,'Invalid signature.');return out;
}
export async function verifyReward(url,fetchKeys=fetch){
  const raw=url.search.slice(1);if(raw.length>8192)throw rewardError(400,'Invalid callback.');
  const match=/^(.*)&signature=([^&]+)&key_id=(\d+)$/.exec(raw);if(!match)throw rewardError(400,'Signed callback required.');
  const params=url.searchParams;const names=[...params.keys()];if(new Set(names).size!==names.length)throw rewardError(400,'Duplicate parameters.');
  let response;
  try{response=await fetchKeys(KEY_URL,{signal:AbortSignal.timeout(10000),cf:{cacheTtl:21600,cacheEverything:true}});}catch{throw rewardError(503,'Verification temporarily unavailable.');}
  if(!response.ok)throw rewardError(503,'Verification temporarily unavailable.');
  const document=await response.json(),key=document.keys?.find(k=>String(k.keyId)===match[3]);if(!key)throw rewardError(403,'Unknown signing key.');
  const publicKey=await crypto.subtle.importKey('spki',fromBase64(key.base64||key.pem.replace(/-----[^-]+-----|\s/g,'')),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  let signature;try{signature=rewardSignature(fromBase64(decodeURIComponent(match[2])));}catch{throw rewardError(400,'Invalid signature.');}
  if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,signature,new TextEncoder().encode(match[1])))throw rewardError(403,'Invalid signature.');
  const setup=params.get('custom_data')==='0'.repeat(64);
  // Console verification is a signed connectivity test, not a customer reward.
  if(!setup&&(![REWARDED_UNIT,REWARDED_UNIT.split('/')[1]].includes(params.get('ad_unit'))||params.get('reward_amount')!=='1'))throw rewardError(403,'Unexpected ad reward.');
  const timestamp=Number(params.get('timestamp')),transaction=params.get('transaction_id'),attempt=params.get('custom_data');
  if(!Number.isSafeInteger(timestamp)||timestamp>Date.now()+300000||Date.now()-timestamp>86400000||!transaction||transaction.length>200||!attempt||!/^[a-f0-9]{64}$/.test(attempt))throw rewardError(400,'Invalid or expired reward.');
  return{timestamp,transaction,attempt};
}
export async function rewardCallback({url,stmt,one}){
  let reward;
  try{reward=await verifyReward(url);}catch(error){
    // Keep only the latest bounded diagnostic, never callback signatures or customer tokens.
    await stmt("INSERT OR REPLACE INTO reward_settings(key,value) VALUES('last_callback_error',?)",JSON.stringify({at:Date.now(),error:error.status?error.message:'Verification failure',unit:(url.searchParams.get('ad_unit')||'').slice(0,80),amount:(url.searchParams.get('reward_amount')||'').slice(0,12)})).run();
    throw error;
  }
  // A signed AdMob console test confirms the callback configuration without awarding credit.
  if(reward.attempt==='0'.repeat(64)){
    await stmt("INSERT OR REPLACE INTO reward_settings(key,value) VALUES('ssv_verified',?)",String(Date.now())).run();
    return Response.json({ok:true,setupVerified:true});
  }
  // Both the Google transaction and the server-issued attempt are unique.
  if(await one('SELECT 1 FROM reward_grants WHERE transaction_id=?',reward.transaction))return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
  const attempt=await one('SELECT * FROM reward_attempts WHERE id=?',reward.attempt);
  if(!attempt||reward.timestamp<attempt.created-300000||reward.timestamp>attempt.expires||Date.now()>attempt.expires+86400000)throw rewardError(400,'Reward attempt expired.');
  await stmt('INSERT OR IGNORE INTO reward_grants(transaction_id,attempt_id,conversation_id,created) VALUES(?,?,?,?)',reward.transaction,attempt.id,attempt.conversation_id,Date.now()).run();
  return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
}
