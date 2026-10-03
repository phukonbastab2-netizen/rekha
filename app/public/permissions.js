const names={microphone:'Microphone',camera:'Camera','video-call':'Microphone and camera',notifications:'Message alerts'};
let serial=0,helpDialog=null;
const pending=new Map();
function stylesheet(){if(document.querySelector('link[data-feature-access]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href='/permissions.css';link.dataset.featureAccess='true';document.head.append(link);}
const cancelled=()=>new DOMException('The feature request was cancelled.','AbortError');
function checkCancelled(signal){if(signal?.aborted)throw cancelled();}
function nativeEnvironment(){
  const bridge=window.RekhaDevice;
  // Old APKs may have no feature bridge. Never send their users to browser settings.
  const app=!!bridge||/\b(?:Rekha[A-Za-z]*|AstroRani)Android(?:\/|\b)/i.test(navigator.userAgent||'');
  return {app,bridge,request:typeof bridge?.requestPermissionsForFeature==='function'};
}
function nativeRequest(feature,{signal}={}){
  checkCancelled(signal);
  const environment=nativeEnvironment();
  if(!environment.request)return Promise.resolve(environment.app?'unavailable':null);
  const requestId='rekha-permission-'+Date.now()+'-'+(++serial);
  return new Promise((resolve,reject)=>{
    let settled=false;const cleanup=()=>{pending.delete(requestId);clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    const finish=(error,status)=>{if(settled)return;settled=true;cleanup();if(error)reject(error);else resolve(status);};
    const abort=()=>finish(cancelled());
    const timer=setTimeout(()=>finish(permissionError(feature,'busy')),90000);
    pending.set(requestId,{feature,resolve:status=>finish(null,status)});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
    try{environment.bridge.requestPermissionsForFeature(requestId,feature);}catch(error){finish(permissionError(feature,'unavailable'));}
  });
}
window.addEventListener('rekha:native-permission',event=>{const detail=event.detail||{},entry=pending.get(detail.requestId);if(!entry||entry.feature!==detail.feature||!['granted','denied','blocked','busy','opened','unavailable'].includes(detail.status))return;pending.delete(detail.requestId);entry.resolve(detail.status);});
function permissionError(feature,status){
  const {app}=nativeEnvironment(),label=names[feature]||'Feature';
  const message=status==='busy'?'Finish the current permission prompt, then tap the feature again.':status==='blocked'?`Enable ${label} in ${app?'Android app':'browser site'} settings, then try again.`:status==='unavailable'?(app?'Update the Rekha Astrology app, then tap the feature again.':'This browser cannot request access here. Open the secure app link in a supported browser.'):`${label} access was not allowed. Tap Allow to try again. Text chat stays available.`;
  const error=new Error(message);error.name='PermissionAccessError';error.status=status;error.permanent=status==='blocked';error.source=app?'native':'browser';return error;
}
function helpDescription(feature,status){
  const {app}=nativeEnvironment(),label=names[feature]||'Feature';
  if(status==='busy')return 'Finish the permission prompt already on screen. Then tap Try again here.';
  if(status==='unavailable')return app?'This version cannot open the Android permission prompt. Update the Rekha Astrology app, then tap the feature again.':'This browser could not request access here. Open the secure app link in a supported browser.';
  if(status==='blocked')return app?`Android has blocked another ${label.toLowerCase()} prompt. Open app settings and allow only the permission you want to use.`:`Your browser reports that ${label.toLowerCase()} is blocked for this site. Allow it in the browser’s site permissions, then tap the feature again.`;
  return app?'Tap Allow to open the Android permission prompt directly in the app.':'Tap Allow to request access here. Choose Allow when your browser asks.';
}
export function showPermissionHelp(feature,status='denied',{constraints}={}){
  stylesheet();helpDialog?.close();const dialog=document.createElement('dialog');helpDialog=dialog;dialog.className='feature-access-dialog';
  const title=document.createElement('h2');title.textContent=(names[feature]||'Feature')+' access';const description=document.createElement('p');
  const note=document.createElement('p');note.className='feature-access-note';note.textContent='Text chat stays available. Your files are shared only when you choose and send them.';
  const statusLine=document.createElement('p');statusLine.className='feature-access-status';statusLine.setAttribute('role','status');
  const controller=new AbortController();let busy=false;
  const buttons=document.createElement('div');buttons.className='feature-access-actions';const close=document.createElement('button');close.type='button';close.textContent='Close';close.onclick=()=>dialog.close();
  const renderActions=currentStatus=>{
    description.textContent=helpDescription(feature,currentStatus);buttons.replaceChildren();
    const environment=nativeEnvironment();
    if(currentStatus==='blocked'&&environment.app&&typeof environment.bridge?.openPermissionSettings==='function'){
      const settings=document.createElement('button');settings.type='button';settings.textContent='Open app settings';settings.onclick=()=>{environment.bridge.openPermissionSettings();dialog.close();};buttons.append(settings);
    }else if(currentStatus!=='blocked'&&currentStatus!=='unavailable'){
      const retry=document.createElement('button');retry.type='button';retry.textContent=currentStatus==='busy'?'Try again':'Allow';
      retry.onclick=async()=>{
        if(busy||controller.signal.aborted)return;busy=true;retry.disabled=true;statusLine.textContent='Opening permission request…';
        try{
          if(feature==='notifications'){const result=await nativeRequest(feature,{signal:controller.signal});checkCancelled(controller.signal);if(result!=='granted')throw permissionError(feature,result||'unavailable');}
          else{const stream=await requestMedia(feature,constraints||mediaConstraints(feature),controller.signal);stream.getTracks().forEach(track=>track.stop());}
          if(!dialog.open||controller.signal.aborted)return;
          description.textContent=(names[feature]||'Feature')+' is allowed. Close this message and tap the feature again.';statusLine.textContent='Access allowed.';buttons.replaceChildren(close);
        }catch(error){if(dialog.open&&!controller.signal.aborted&&error.name!=='AbortError'){statusLine.textContent=error.message;renderActions(error.status||'unavailable');}}
        finally{busy=false;if(retry.isConnected)retry.disabled=false;}
      };buttons.append(retry);
    }
    buttons.append(close);
  };
  renderActions(status);dialog.append(title,description,note,statusLine,buttons);document.body.append(dialog);dialog.addEventListener('close',()=>{controller.abort();if(helpDialog===dialog)helpDialog=null;dialog.remove();},{once:true});dialog.addEventListener('cancel',()=>controller.abort(),{once:true});dialog.showModal();return dialog;
}
function acquireMedia(constraints,signal){
  checkCancelled(signal);
  const request=navigator.mediaDevices.getUserMedia(constraints);
  if(!signal)return request;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const abort=()=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);reject(cancelled());};
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    // Browser permission prompts cannot be forcibly dismissed. Observe the
    // original promise and release tracks if it completes after cancellation.
    request.then(stream=>{if(settled||signal.aborted){stream.getTracks().forEach(track=>track.stop());if(!settled)abort();return;}settled=true;signal.removeEventListener('abort',abort);resolve(stream);},error=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);reject(signal.aborted?cancelled():error);});
  });
}
const mediaConstraints=feature=>feature==='microphone'?{audio:true}:feature==='video-call'?{audio:true,video:true}:{video:true};
async function browserDenialStatus(feature){
  if(!navigator.permissions?.query)return 'denied';
  const categories=feature==='video-call'?['microphone','camera']:[feature];
  const states=await Promise.all(categories.map(async name=>{try{return (await navigator.permissions.query({name})).state;}catch{return 'unknown';}}));
  // A rejected capture can mean dismissal, a temporary refusal or policy failure.
  // Only an explicit browser permission state proves that its prompt is blocked.
  return states.includes('denied')?'blocked':'denied';
}
async function requestMedia(feature,constraints,signal){
  checkCancelled(signal);
  if(!['microphone','camera','video-call'].includes(feature))throw new Error('Choose a microphone or camera feature.');
  if(!navigator.mediaDevices?.getUserMedia)throw permissionError(feature,'unavailable');
  const status=await nativeRequest(feature,{signal});checkCancelled(signal);
  if(status&&status!=='granted')throw permissionError(feature,status);
  try{const stream=await acquireMedia(constraints,signal);if(signal?.aborted){stream.getTracks().forEach(track=>track.stop());throw cancelled();}return stream;}catch(error){
    if(signal?.aborted||error.name==='AbortError')throw cancelled();
    if(error.name==='NotAllowedError'||error.name==='PermissionDeniedError'){
      const denial=nativeEnvironment().app?'denied':await browserDenialStatus(feature);checkCancelled(signal);throw permissionError(feature,denial);
    }
    if(error.name==='SecurityError')throw permissionError(feature,'unavailable');
    throw error;
  }
}
export async function getFeatureMedia(feature,constraints,{signal}={}){
  try{return await requestMedia(feature,constraints,signal);}
  catch(error){checkCancelled(signal);if(error.name==='PermissionAccessError')showPermissionHelp(feature,error.status,{constraints});throw error;}
}
export function openFeatureAccess(){
  stylesheet();const dialog=document.createElement('dialog');dialog.className='feature-access-dialog';dialog.setAttribute('aria-label','Feature access');
  dialog.innerHTML='<h2>Feature access</h2><p>Set up the features you want to use. Android asks separately for each permission.</p><div class="feature-access-list"></div><p class="feature-access-note">Only photos, videos and documents you choose and send reach the chat. SMS and your full gallery are not collected.</p><p class="feature-access-status" role="status"></p><div class="feature-access-actions"><button type="button" data-close>Done</button></div>';
  const list=dialog.querySelector('.feature-access-list'),statusLine=dialog.querySelector('[role=status]'),controller=new AbortController();let busy=false;
  for(const [feature,label,description]of [['microphone','Microphone','Voice notes and calls'],['camera','Camera','Camera photos and video calls'],['notifications','Message alerts','Optional notifications for new messages']]){
    const row=document.createElement('div'),text=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small'),button=document.createElement('button');row.className='feature-access-row';strong.textContent=label;small.textContent=description;text.append(strong,small);button.type='button';button.textContent='Set up';
    button.onclick=async()=>{if(busy)return;busy=true;button.disabled=true;statusLine.textContent='Opening '+label.toLowerCase()+'…';try{
      if(feature==='notifications'){
        if(nativeEnvironment().request){const result=await nativeRequest(feature,{signal:controller.signal});checkCancelled(controller.signal);if(result!=='granted'){showPermissionHelp(feature,result);throw permissionError(feature,result);}statusLine.textContent='Message alerts are enabled. Android background checks are periodic; open the app for live chat and calls.';button.textContent='Allowed';}
        else if(typeof window.RekhaDevice?.showAlertSettings==='function'){window.RekhaDevice.showAlertSettings();statusLine.textContent='Choose Enable in the message alert settings.';}
        else if(nativeEnvironment().app){showPermissionHelp(feature,'unavailable');throw permissionError(feature,'unavailable');}
        else if('Notification'in window){const value=await Notification.requestPermission();statusLine.textContent=value==='granted'?'Browser notification permission allowed. This preview does not provide background web push.':'Notifications were not allowed.';}
        else statusLine.textContent='Message alerts are available in the Android app.';
      }else{const stream=await getFeatureMedia(feature,feature==='microphone'?{audio:true}:{video:true},{signal:controller.signal});stream.getTracks().forEach(track=>track.stop());if(dialog.open&&!controller.signal.aborted){button.textContent='Allowed';statusLine.textContent=label+' is ready.';}}
    }catch(error){if(dialog.open&&!controller.signal.aborted&&error.name!=='AbortError')statusLine.textContent=error.message;}finally{busy=false;if(button.isConnected)button.disabled=false;}};
    row.append(text,button);list.append(row);
  }
  const files=document.createElement('p');files.className='feature-access-note';files.textContent='Photos, videos and documents: tap Attach in chat to open your phone’s picker. No full-gallery permission is needed.';list.append(files);
  dialog.querySelector('[data-close]').onclick=()=>{controller.abort();dialog.close();};dialog.addEventListener('close',()=>{controller.abort();dialog.remove();},{once:true});dialog.addEventListener('cancel',()=>controller.abort(),{once:true});document.body.append(dialog);dialog.showModal();return dialog;
}
