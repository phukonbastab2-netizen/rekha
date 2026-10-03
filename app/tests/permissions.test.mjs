import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../public/permissions.js',import.meta.url),'utf8').replace(/^export /gm,'');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
class Element extends EventTarget{
  constructor(tag,document){super();this.tagName=tag;this.document=document;this.children=[];this.dataset={};this.attributes={};this._text='';this.open=false;}
  append(...children){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
  replaceChildren(...children){for(const child of this.children)child.parent=null;this.children=[];this._text='';this.append(...children);}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}}
  set textContent(value){this.replaceChildren();this._text=String(value);}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join(' ');}
  setAttribute(name,value){this.attributes[name]=value;}
  get isConnected(){return this===this.document.body||this===this.document.head||!!this.parent?.isConnected;}
  showModal(){this.open=true;}
  close(){if(!this.open)return;this.open=false;this.dispatchEvent(new Event('close'));}
  querySelector(selector){return this.all().find(child=>selector==='link[data-feature-access]'?child.tagName==='link'&&child.dataset.featureAccess:selector==='button'?child.tagName==='button':false)||null;}
  all(){return this.children.flatMap(child=>[child,...child.all()]);}
}
function fixture({userAgent='Chrome',permissionState='prompt',query=true,capture}={}){
  const document={};document.head=new Element('head',document);document.body=new Element('body',document);document.createElement=tag=>new Element(tag,document);document.querySelector=selector=>document.head.querySelector(selector)||document.body.querySelector(selector);
  const window=new EventTarget(),events=[],streams=[];
  const navigator={userAgent,mediaDevices:{getUserMedia:async constraints=>{events.push('capture');if(capture)return capture(constraints);const track={stopped:false,stop(){this.stopped=true;}};const stream={getTracks:()=>[track]};streams.push(stream);return stream;}}};
  if(query)navigator.permissions={query:async({name})=>{events.push('query:'+name);return{state:typeof permissionState==='function'?await permissionState(name):permissionState};}};
  const api=new Function('window','navigator','document','DOMException','AbortController','setTimeout','clearTimeout',source+'\nreturn {getFeatureMedia,showPermissionHelp,openFeatureAccess};')(window,navigator,document,DOMException,AbortController,setTimeout,clearTimeout);
  const reply=(requestId,feature,status)=>{const event=new Event('rekha:native-permission');event.detail={requestId,feature,status};window.dispatchEvent(event);};
  let nativeStatus='granted',settings=0;
  const installNative=()=>window.RekhaDevice={requestPermissionsForFeature(requestId,feature){events.push('native:'+feature);queueMicrotask(()=>reply(requestId,feature,nativeStatus));},openPermissionSettings(){settings++;}};
  const dialog=()=>document.body.children.find(child=>child.tagName==='dialog'),buttons=()=>dialog()?.all().filter(child=>child.tagName==='button')||[],button=label=>buttons().find(child=>child.textContent===label);
  return{api,window,navigator,document,events,streams,reply,installNative,status:value=>nativeStatus=value,settings:()=>settings,dialog,buttons,button,close:()=>dialog()?.close()};
}
const denial=()=>new DOMException('Request declined','NotAllowedError');

test('a native feature tap requests Android permission before media capture',async()=>{
  const f=fixture();f.installNative();const stream=await f.api.getFeatureMedia('microphone',{audio:true});
  assert.deepEqual(f.events,['native:microphone','capture']);assert.equal(f.dialog(),undefined);stream.getTracks().forEach(track=>track.stop());
});
test('a fresh native denial offers Allow; retry directly requests Android and releases its test stream',async()=>{
  const f=fixture();f.installNative();f.status('denied');
  await assert.rejects(f.api.getFeatureMedia('camera',{video:true}),error=>error.status==='denied'&&!error.permanent&&error.source==='native');
  assert.deepEqual(f.buttons().map(button=>button.textContent),['Allow','Close']);assert.ok(!/browser|settings/i.test(f.dialog().textContent));assert.equal(f.settings(),0);
  f.status('granted');await f.button('Allow').onclick();assert.deepEqual(f.events,['native:camera','native:camera','capture']);assert.ok(f.streams[0].getTracks().every(track=>track.stopped));assert.match(f.dialog().textContent,/Access allowed/);f.close();
});
test('only confirmed native blocked status offers app settings and never opens settings automatically',async()=>{
  const f=fixture();f.installNative();f.status('blocked');await assert.rejects(f.api.getFeatureMedia('microphone',{audio:true}),error=>error.permanent&&error.status==='blocked');
  assert.deepEqual(f.events,['native:microphone']);assert.equal(f.settings(),0);assert.equal(f.button('Allow'),undefined);assert.ok(!/browser/i.test(f.dialog().textContent));
  f.button('Open app settings').onclick();assert.equal(f.settings(),1);assert.equal(f.dialog(),undefined);
});
test('browser temporary refusal is retryable through Allow without site-settings guidance',async()=>{
  let denied=true;const f=fixture();f.navigator.mediaDevices.getUserMedia=async()=>{f.events.push('capture');if(denied)throw denial();const track={stopped:false,stop(){this.stopped=true;}};const stream={getTracks:()=>[track]};f.streams.push(stream);return stream;};
  await assert.rejects(f.api.getFeatureMedia('microphone',{audio:true}),error=>error.status==='denied'&&!error.permanent);
  assert.ok(f.button('Allow'));assert.ok(!/settings/i.test(f.dialog().textContent));denied=false;await f.button('Allow').onclick();assert.equal(f.events.filter(event=>event==='capture').length,2);assert.ok(f.streams[0].getTracks()[0].stopped);f.close();
});
test('missing or unsupported browser Permissions API cannot establish permanent denial',async()=>{
  for(const options of[{query:false},{permissionState:()=>{throw new Error('Unsupported permission name');}}]){
    const f=fixture({...options,capture:async()=>{throw denial();}});await assert.rejects(f.api.getFeatureMedia('camera',{video:true}),error=>error.status==='denied'&&!error.permanent);assert.ok(f.button('Allow'));assert.ok(!/settings/i.test(f.dialog().textContent));f.close();
  }
});
test('explicit browser denied state shows site recovery and no repeated futile prompt',async()=>{
  const f=fixture({permissionState:'denied',capture:async()=>{throw denial();}});await assert.rejects(f.api.getFeatureMedia('camera',{video:true}),error=>error.status==='blocked'&&error.permanent&&error.source==='browser');
  assert.match(f.dialog().textContent,/browser’s site permissions/);assert.equal(f.button('Allow'),undefined);assert.equal(f.button('Open app settings'),undefined);f.close();
});
test('video-call denial checks both browser media categories',async()=>{
  const f=fixture({permissionState:name=>name==='camera'?'denied':'granted',capture:async()=>{throw denial();}});await assert.rejects(f.api.getFeatureMedia('video-call',{audio:true,video:true}),error=>error.status==='blocked');assert.deepEqual(f.events,['capture','query:microphone','query:camera']);f.close();
});
test('WebView media refusal after native grant stays an in-app retry instead of browser-settings guidance',async()=>{
  const f=fixture({permissionState:'denied',capture:async()=>{throw denial();}});f.installNative();await assert.rejects(f.api.getFeatureMedia('camera',{video:true}),error=>error.status==='denied'&&error.source==='native');assert.ok(f.button('Allow'));assert.ok(!/query:|browser|settings/i.test(f.events.join(' ')+f.dialog().textContent));f.close();
});
test('known APKs without a current bridge request an update and never fall through to browser capture/settings',async()=>{
  for(const userAgent of['Mozilla Android RekhaAstrologyAndroid/0.8.0','Mozilla Android RekhaAdminAndroid/0.8.0','Mozilla Android AstroRaniAndroid/0.4.0']){
    const f=fixture({userAgent});await assert.rejects(f.api.getFeatureMedia('microphone',{audio:true}),error=>error.status==='unavailable'&&error.source==='native');assert.deepEqual(f.events,[]);assert.match(f.dialog().textContent,/Update the Rekha Astrology app/);assert.ok(!/browser|settings/i.test(f.dialog().textContent));f.close();
  }
  const f=fixture();f.window.RekhaDevice={};await assert.rejects(f.api.getFeatureMedia('camera',{video:true}),error=>error.status==='unavailable');assert.deepEqual(f.events,[]);f.close();
});
test('security or unsupported-media failure is not misreported as permanent site denial',async()=>{
  const f=fixture({capture:async()=>{throw new DOMException('Unsupported policy','SecurityError');}});await assert.rejects(f.api.getFeatureMedia('camera',{video:true}),error=>error.status==='unavailable'&&!error.permanent);assert.ok(!/settings/i.test(f.dialog().textContent));f.close();
});
test('busy native requests can be retried in app without offering settings',async()=>{
  const f=fixture();f.installNative();f.status('busy');await assert.rejects(f.api.getFeatureMedia('microphone',{audio:true}),error=>error.status==='busy'&&!error.permanent);assert.ok(f.button('Try again'));assert.equal(f.button('Open app settings'),undefined);f.close();
});
test('closing retry help cancels its native response and cannot start late capture',async()=>{
  const f=fixture();f.installNative();f.status('denied');await assert.rejects(f.api.getFeatureMedia('microphone',{audio:true}));let request;f.window.RekhaDevice.requestPermissionsForFeature=(requestId,feature)=>request={requestId,feature};
  const retry=f.button('Allow').onclick();f.close();f.reply(request.requestId,request.feature,'granted');await retry;assert.ok(!f.events.includes('capture'));assert.equal(f.dialog(),undefined);
});
test('cancellation during browser-state lookup suppresses late help',async()=>{
  let resolve;const f=fixture({permissionState:()=>new Promise(done=>resolve=done),capture:async()=>{throw denial();}}),controller=new AbortController();const request=f.api.getFeatureMedia('camera',{video:true},{signal:controller.signal});await settle();controller.abort();resolve('denied');await assert.rejects(request,{name:'AbortError'});assert.equal(f.dialog(),undefined);
});
test('a stream completing after cancellation is immediately stopped',async()=>{
  let resolve;const track={stopped:false,stop(){this.stopped=true;}},f=fixture({capture:()=>new Promise(done=>resolve=done)}),controller=new AbortController();const request=f.api.getFeatureMedia('microphone',{audio:true},{signal:controller.signal});await settle();controller.abort();await assert.rejects(request,{name:'AbortError'});resolve({getTracks:()=>[track]});await settle();assert.equal(track.stopped,true);assert.equal(f.dialog(),undefined);
});
