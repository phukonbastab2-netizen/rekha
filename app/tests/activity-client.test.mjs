import test from 'node:test';
import assert from 'node:assert/strict';
import {createActivityTracker,ACTIVITY_ACTIONS,ACTIVITY_SCREENS} from '../public/activity.js';
import {activityActions,activityScreens} from '../cloudflare/activity.mjs';

const consentKey='rekha:activity-consent-v1',visitorKey='rekha:activity-visitor-v1';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
let uuidSerial=0;
class Surface {
  constructor(){this.listeners=new Map();}
  addEventListener(type,listener){const values=this.listeners.get(type)||new Set();values.add(listener);this.listeners.set(type,values);}
  emit(type,details={}){for(const listener of this.listeners.get(type)||[])listener({type,...details});}
}
class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.id='';this.type='';this.parentElement=null;this.className='';this.classList={contains:value=>this.className.split(/\s+/).includes(value)};}
  append(...children){for(const child of children){child.remove();child.parentElement=this;this.children.push(child);}}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  hasAttribute(name){return Object.hasOwn(this.attributes,name);}
}
function fixture({path='/',surface='website',userAgent='Chrome',storage=new Map(),response=async()=>({ok:true,status:202}),hidden=false,online=true}={}){
  const document=new Surface();document.hidden=hidden;document.body=new Element('body');document.createElement=tag=>new Element(tag);
  const window=new Surface();window.location={pathname:path,search:'?password=private-secret',hash:'#name=private-name'};
  const navigator={userAgent,onLine:online};let clock=1_800_000_000_000,serial=0,timerSerial=0;
  const timers=new Map(),requests=[],writes=[];
  const store={getItem:key=>storage.get(key)??null,setItem(key,value){writes.push([key,value]);storage.set(key,value);},removeItem:key=>storage.delete(key)};
  const tracker=createActivityTracker({windowTarget:window,documentTarget:document,navigatorTarget:navigator,storage:store,cryptoTarget:{randomUUID(){serial++;return '00000000-0000-4000-8000-'+String(++uuidSerial).padStart(12,'0');}},fetchActivity:async(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return response(requests.length,options);},now:()=>clock,setTimer(fn,delay){const id=++timerSerial;timers.set(id,{fn,due:clock+delay});return id;},clearTimer:id=>timers.delete(id)});
  tracker.init({surface});
  const advance=async(ms)=>{clock+=ms;let safety=0;while(true){const next=[...timers.entries()].find(([,timer])=>timer.due<=clock);if(!next)break;if(++safety>1000)throw new Error('Timer loop');timers.delete(next[0]);next[1].fn();await settle();}};
  const click=(element,trusted=true)=>document.emit('click',{target:element,isTrusted:trusted,clientX:123,clientY:456});
  return{tracker,document,window,navigator,storage,requests,writes,timers,advance,click,ids:()=>serial,now:()=>clock};
}
const element=(tag,id,attributes={})=>{const node=new Element(tag);node.id=id;for(const [name,value]of Object.entries(attributes))node.setAttribute(name,value);return node;};
const actions=f=>f.requests.flatMap(request=>request.body.events.map(event=>event.action));

test('client actions/screens exactly match the backend contract, including intro/download/policy integration hooks',()=>{
  assert.deepEqual([...ACTIVITY_ACTIONS].sort(),[...activityActions].sort());assert.deepEqual([...ACTIVITY_SCREENS].sort(),[...activityScreens].sort());
  const f=fixture();f.tracker.setConsent(true);for(const screen of ['intro','download','policy'])assert.equal(f.tracker.setScreen(screen),true);
});

test('before explicit opt-in there are no identifiers, event storage, timers or requests; decline is optional',async()=>{
  const f=fixture();f.click(element('button','customer-secret'));f.tracker.record('download_start');f.tracker.setScreen('chat');await f.advance(60000);
  assert.equal(f.ids(),0);assert.equal(f.writes.length,0);assert.equal(f.requests.length,0);assert.equal(f.timers.size,0);
  const ribbon=f.document.body.children[0];assert.equal(ribbon.getAttribute('data-activity-consent'),'true');assert.match(ribbon.children[0].textContent,/Share button and screen activity/);assert.equal(ribbon.children[1].lang,'hi');
  ribbon.children[2].children[1].onclick();assert.equal(f.tracker.getConsent(),false);assert.equal(f.storage.get(consentKey),'no');assert.equal(f.document.body.children.length,0);assert.equal(f.storage.has(visitorKey),false);
  f.tracker.manageConsent();assert.equal(f.document.body.children.length,1);assert.equal(f.ids(),0);
});
test('acceptance sends only allowlisted structural labels; page query, DOM text, entered values and coordinates never leave',async()=>{
  const f=fixture({path:'/astrorani/privacy-policy.html'});f.tracker.setConsent(true);
  Object.defineProperty(f.document,'cookie',{get(){throw new Error('Collector must not read authentication cookies.');}});
  const link=element('a','private-name',{href:'https://private.example/?password=secret'});link.textContent='Private kundli message';
  const input=element('input','signup-name');input.value='Person born on 2000-01-01';
  const unsafe=element('button','private-customer-id',{'data-activity':'my secret message'});unsafe.textContent='OTP123';
  f.click(link);f.click(input);f.click(unsafe);assert.equal(f.tracker.record('private-message',{type:'click',text:'secret'}),false);f.tracker.record('chat_send',{type:'click',text:'message-body',name:'real name'});
  assert.equal(f.tracker.record('chat_send',{type:'media'}),false);await f.tracker.flush();
  assert.equal(f.requests[0].url,'/astrorani/api/activity');assert.equal(f.requests[0].options.credentials,'same-origin');
  assert.deepEqual(Object.keys(f.requests[0].body).sort(),['consent','events','sessionId','surface','visitorId']);
  for(const event of f.requests[0].body.events){assert.deepEqual(Object.keys(event).sort(),['action','at','id','page','screen','type']);assert.equal(event.page,'/astrorani/privacy-policy.html');assert.ok(ACTIVITY_ACTIONS.includes(event.action));assert.ok(ACTIVITY_SCREENS.includes(event.screen));}
  assert.deepEqual(actions(f),['page_view','link_click','profile_name','button_click','chat_send']);
  assert.ok(!/private-|secret|kundli message|2000-01-01|clientX|message-body|real name/.test(f.requests[0].options.body));
  assert.deepEqual([...f.storage.keys()].sort(),[consentKey,visitorKey].sort());
});
test('no tracking prompt or capture exists on admin, native admin, unknown paths or invalid surfaces',async()=>{
  for(const options of[{path:'/admin'},{path:'/admin/'},{path:'/admin.html'},{userAgent:'Mozilla RekhaAdminAndroid/0.9.3'},{path:'/api/chat'},{surface:'admin'}]){const f=fixture(options);assert.equal(f.document.body.children.length,0);assert.equal(f.document.listeners.size,0);assert.equal(f.tracker.setConsent(true),false);assert.equal(f.ids(),0);await f.tracker.flush();assert.equal(f.requests.length,0);}
});
test('fixed controls work across nested icons while unknown controls remain generic; credentials and consent controls are skipped',async()=>{
  const f=fixture({surface:'customer'});f.tracker.setConsent(true);
  const button=element('button','kundli-send'),icon=element('svg','secret-svg-id');button.append(icon);f.click(icon);
  const custom=element('button','freeform',{'data-activity':'donate_interest'});f.click(custom);
  f.click(element('button','private-element'));f.click(element('div','__proto__'));
  const password=element('input','sign-in-secret',{autocomplete:'current-password'});password.type='password';f.click(password);
  f.click(element('input','otp'));f.click(element('input','credit-entry',{autocomplete:'cc-number'}));
  const credentials=element('form','credential-form'),login=element('button','submit');credentials.append(login);f.click(login);
  const consent=element('section','',{'data-activity-consent':'true'}),decline=element('button','');consent.append(decline);f.click(decline);
  f.click(custom,false);await f.tracker.flush();assert.deepEqual(actions(f),['page_view','profile_send','donate_interest','button_click','page_click']);
});
test('screen hooks dedupe unchanged static screens; native first-open occurs once after consent with no UA in payload',async()=>{
  const saved=new Map(),first=fixture({surface:'customer',userAgent:'Private UA RekhaAstrologyAndroid/0.9.4',storage:saved});
  first.tracker.setScreen('profile');first.tracker.setConsent(true);first.tracker.setScreen('chat');first.tracker.setScreen('chat');assert.equal(first.tracker.setScreen('Alice born at secret town'),false);await first.tracker.flush();
  assert.deepEqual(actions(first),['page_view','app_open','first_app_open','page_view']);assert.ok(!first.requests[0].options.body.includes('Private UA'));assert.equal(first.requests[0].body.events[0].screen,'profile');
  const second=fixture({surface:'customer',userAgent:'RekhaAstrologyAndroid/0.9.4',storage:saved});await second.tracker.flush();assert.deepEqual(actions(second),['page_view','app_open']);assert.equal(second.requests[0].body.visitorId,first.requests[0].body.visitorId);
  assert.equal(second.requests[0].url,'/api/activity','Customer calls stay on their own origin API route.');
  // Each document gets a distinct cryptographic session even with the same visitor.
  assert.notEqual(second.requests[0].body.sessionId,first.requests[0].body.sessionId);
});
test('download hook and trusted click dedupe once; native media controls use generic play/ended without source/title',async()=>{
  const f=fixture();f.tracker.setConsent(true);const link=element('a','download-apk');
  f.click(link);assert.equal(f.tracker.record('download_start'),false);f.document.emit('play',{target:element('video','name-sensitive'),isTrusted:true});f.document.emit('ended',{target:element('audio','phone-sensitive'),isTrusted:true});f.document.emit('play',{target:element('video',''),isTrusted:false});
  await f.tracker.flush();assert.deepEqual(actions(f),['page_view','download_start','media_play','media_ended']);assert.deepEqual(f.requests[0].body.events.slice(-2).map(event=>event.type),['media','media']);
});
test('actual source-static customer controls get functional names without dynamic message IDs, values, media URLs or emoji',async()=>{
  const f=fixture({surface:'customer'});f.tracker.setConsent(true);
  const controls=[['input','signup-name',{},'profile_name'],['input','signup-dob',{},'profile_dob'],['button','reload-onboarding-video',{},'intro_retry'],['textarea','message-input',{},'chat_input'],['button','camera-photo',{},'chat_camera'],['button','emoji-picker',{},'chat_emoji'],['button','stop-record',{},'voice_stop'],['button','cancel-capture',{},'voice_cancel'],['button','load-earlier',{},'chat_history'],['button','jump-latest',{},'chat_latest'],['button','connection-retry',{},'chat_retry'],['button','save-privacy',{},'privacy_save'],['button','confirm-delete',{},'delete_confirm'],['button','',{'data-menu':'search'},'chat_search'],['button','',{'data-action':'edit'},'message_edit'],['button','',{'data-attach':'gallery'},'attachment_gallery'],['button','',{'data-followup-yes':'private-message-id'},'yes_choice'],['button','',{'data-donation-interest':'private-message-id'},'donate_interest'],['button','',{'data-message-actions':'private-message-id'},'message_options'],['button','',{'data-jump-message':'private-message-id'},'message_quote_open'],['button','',{'data-react':'private-emoji'},'message_react'],['button','',{'data-remove-draft':'private-filename'},'attachment_remove'],['button','',{'data-insert-emoji':'private-emoji'},'chat_emoji_insert'],['a','',{'data-media-url':'https://private-media.example/private-file'},'media_open']];
  for(const [tag,id,attributes]of controls){const node=element(tag,id,attributes);node.value='private-entered-content';const get=node.getAttribute.bind(node);node.getAttribute=name=>{if(['data-media-url','data-followup-yes','data-donation-interest','data-message-actions','data-jump-message','data-react','data-remove-draft','data-insert-emoji'].includes(name))throw new Error('Dynamic values must never be read');return get(name);};f.click(node);}
  const send=element('button','');send.className='send compose-primary';f.click(send);send.setAttribute('data-mode','voice');f.click(send);
  const audio=element('button','',{'data-call-type':'voice'});audio.className='call-launch';f.click(audio);audio.setAttribute('data-call-type','video');f.click(audio);
  const end=element('button','');end.className='call-end';f.click(end);const take=element('button','');take.className='camera-take';f.click(take);
  await f.tracker.flush();await f.tracker.flush();assert.deepEqual(actions(f),['page_view',...controls.map(control=>control[3]),'chat_send','chat_voice','chat_call','chat_video_call','call_end','camera_capture']);
  assert.ok(f.requests.every(request=>!request.options.body.includes('private-')));
});
test('native foreground returns count once per hidden-to-visible transition and first-open survives withdrawal/reacceptance',async()=>{
  const native=fixture({surface:'customer',userAgent:'Mozilla RekhaAstrologyAndroid/0.9.4'});native.tracker.setConsent(true);await native.tracker.flush();
  native.document.emit('visibilitychange');assert.equal(actions(native).filter(action=>action==='app_open').length,1);
  native.document.hidden=true;native.document.emit('visibilitychange');await native.advance(10000);native.document.hidden=false;native.document.emit('visibilitychange');native.document.emit('visibilitychange');await native.tracker.flush();
  assert.equal(actions(native).filter(action=>action==='app_open').length,2);assert.equal(actions(native).filter(action=>action==='first_app_open').length,1);
  native.tracker.setConsent(false);native.document.hidden=true;native.document.emit('visibilitychange');native.document.hidden=false;native.document.emit('visibilitychange');native.tracker.setConsent(true);await native.tracker.flush();
  assert.equal(actions(native).filter(action=>action==='app_open').length,3);assert.equal(actions(native).filter(action=>action==='first_app_open').length,1);
  const browser=fixture({surface:'customer'});browser.tracker.setConsent(true);browser.document.hidden=true;browser.document.emit('visibilitychange');browser.document.hidden=false;browser.document.emit('visibilitychange');await browser.tracker.flush();assert.deepEqual(actions(browser),['page_view']);
});
test('automatic downloads and customer interactions before consent are discarded instead of replayed after acceptance',async()=>{
  const f=fixture();f.tracker.record('download_start');f.click(element('button','kundli-send'));f.document.emit('ended',{target:element('video',''),isTrusted:true});f.tracker.setConsent(true);await f.tracker.flush();assert.deepEqual(actions(f),['page_view']);
});
test('offline collection is bounded to200, sends batches <=20 and8KiB on reconnection, without offline timer loops',async()=>{
  const f=fixture({online:false});f.tracker.setConsent(true);for(let i=0;i<280;i++)f.tracker.record('button_click');await f.advance(60000);assert.equal(f.timers.size,0);assert.equal(f.requests.length,0);
  f.navigator.onLine=true;f.window.emit('online');await f.advance(0);for(let i=0;i<12;i++)await f.advance(5000);
  assert.equal(f.requests.reduce((sum,request)=>sum+request.body.events.length,0),200);assert.ok(f.requests.every(request=>request.body.events.length<=20&&request.options.body.length<=8192));assert.equal(f.timers.size,0);
});
test('transient failures preserve event UUIDs but stop after3 attempts;429 pauses all new traffic until Retry-After',async()=>{
  const fail=fixture({response:async()=>{throw new Error('Offline');}});fail.tracker.setConsent(true);await fail.tracker.flush();await fail.advance(5000);await fail.advance(5000);await fail.advance(60000);assert.equal(fail.requests.length,3);assert.equal(fail.timers.size,0);assert.equal(new Set(fail.requests.map(request=>request.body.events[0].id)).size,1);
  const limited=fixture({response:async()=>({ok:false,status:429,headers:{get:()=> '120'}})});limited.tracker.setConsent(true);await limited.tracker.flush();limited.tracker.record('link_click');await limited.advance(60000);assert.equal(limited.requests.length,1);limited.window.emit('online');await limited.advance(59000);assert.equal(limited.requests.length,1);await limited.advance(1000);assert.equal(limited.requests.length,2);
});
test('decline during a request aborts, removes identifiers and prevents queued retry; cross-tab decline also clears',async()=>{
  let resolve;const f=fixture({response:()=>new Promise(done=>{resolve=done;})});f.tracker.setConsent(true);const request=f.tracker.flush();await settle();f.tracker.record('button_click');f.tracker.setConsent(false);assert.equal(f.requests[0].options.signal.aborted,true);assert.equal(f.storage.has(visitorKey),false);resolve({ok:false,status:503});await request;await f.advance(60000);assert.equal(f.requests.length,1);assert.equal(f.ids()>0,true);assert.equal(f.tracker.record('page_click'),false);assert.equal(f.timers.size,0);
  const other=fixture({storage:new Map([[consentKey,'yes']])});other.window.emit('storage',{key:consentKey,newValue:'no'});await other.advance(10000);assert.equal(other.storage.has(visitorKey),false);assert.equal(other.requests.length,0);assert.equal(other.tracker.getConsent(),false);
});
test('pagehide uses a bounded keepalive batch and stale events are dropped rather than replayed',async()=>{
  const f=fixture();f.tracker.setConsent(true);f.tracker.record('button_click');f.window.emit('pagehide');await settle();assert.equal(f.requests[0].options.keepalive,true);assert.equal(f.timers.size,0);
  const stale=fixture({online:false});stale.tracker.setConsent(true);await stale.advance(24*60*60*1000+1);stale.navigator.onLine=true;await stale.tracker.flush();assert.equal(stale.requests.length,0);
});
test('blocked storage or unavailable secure randomness does not block the app or send unstable identifiers',async()=>{
  const f=fixture();f.tracker.setConsent(true);f.tracker.init({surface:'customer'});await f.tracker.flush();assert.equal(f.requests[0].body.surface,'website');assert.equal(f.document.listeners.get('click').size,1);
  const document=new Surface();document.body=new Element('body');document.createElement=tag=>new Element(tag);const window=new Surface();window.location={pathname:'/'};const badStorage={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');}};
  const api=createActivityTracker({windowTarget:window,documentTarget:document,navigatorTarget:{},storage:badStorage,cryptoTarget:{},fetchActivity:()=>{throw new Error('must not request');}});api.init({surface:'website'});assert.equal(api.setConsent(true),true);assert.equal(api.record('button_click'),false);assert.equal(await api.flush(),false);
});
