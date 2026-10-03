const names={microphone:'Microphone',camera:'Camera','video-call':'Microphone and camera',notifications:'Message alerts'};
let serial=0,helpDialog=null;
const pending=new Map();
function stylesheet(){if(document.querySelector('link[data-feature-access]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href='/permissions.css';link.dataset.featureAccess='true';document.head.append(link);}
function nativeRequest(feature){
  if(typeof window.RekhaDevice?.requestPermissionsForFeature!=='function')return Promise.resolve(null);
  const requestId='rekha-permission-'+Date.now()+'-'+(++serial);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('The permission request is still waiting. Finish the Android prompt, then try again.'));},90000);
    pending.set(requestId,{feature,resolve:status=>{clearTimeout(timer);resolve(status);}});
    try{window.RekhaDevice.requestPermissionsForFeature(requestId,feature);}catch(error){pending.delete(requestId);clearTimeout(timer);reject(new Error('Could not open Android permissions. Please update the app and try again.'));}
  });
}
window.addEventListener('rekha:native-permission',event=>{const detail=event.detail||{},entry=pending.get(detail.requestId);if(!entry||entry.feature!==detail.feature||!['granted','denied','blocked','busy','opened','unavailable'].includes(detail.status))return;pending.delete(detail.requestId);entry.resolve(detail.status);});
function permissionError(feature,status){const error=new Error(status==='busy'?'Finish the current permission prompt, then tap the feature again.':status==='blocked'?`Enable ${names[feature]||'this feature'} in app settings, then try again.`:`${names[feature]||'Feature'} access was not allowed. You can keep using text chat.`);error.name='PermissionAccessError';return error;}
export function showPermissionHelp(feature,status='denied'){
  stylesheet();helpDialog?.close();const dialog=document.createElement('dialog');helpDialog=dialog;dialog.className='feature-access-dialog';
  const native=typeof window.RekhaDevice?.requestPermissionsForFeature==='function';
  const title=document.createElement('h2');title.textContent=(names[feature]||'Feature')+' access';const description=document.createElement('p');description.textContent=status==='busy'?'Finish the Android permission prompt already on screen, then try again.':native?'Allow access in the Android permission prompt. If Android has stopped showing it, open app settings and enable only the permission you need.':'Allow access in your browser’s site permissions. If you previously blocked it, change that setting, then tap the feature again.';
  const note=document.createElement('p');note.className='feature-access-note';note.textContent='Text chat stays available. Your files are shared only when you choose and send them.';
  const buttons=document.createElement('div');buttons.className='feature-access-actions';const close=document.createElement('button');close.type='button';close.textContent='Close';close.onclick=()=>dialog.close();
  if(native&&status!=='busy'&&typeof window.RekhaDevice?.openPermissionSettings==='function'){const settings=document.createElement('button');settings.type='button';settings.textContent='Open app settings';settings.onclick=()=>{window.RekhaDevice.openPermissionSettings();dialog.close();};buttons.append(settings);}
  buttons.append(close);dialog.append(title,description,note,buttons);document.body.append(dialog);dialog.addEventListener('close',()=>{if(helpDialog===dialog)helpDialog=null;dialog.remove();},{once:true});dialog.showModal();
}
export async function getFeatureMedia(feature,constraints){
  if(!['microphone','camera','video-call'].includes(feature))throw new Error('Choose a microphone or camera feature.');
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone and camera features need the updated app or a supported browser.');
  const status=await nativeRequest(feature);
  if(status&&status!=='granted'){showPermissionHelp(feature,status);throw permissionError(feature,status);}
  try{return await navigator.mediaDevices.getUserMedia(constraints);}catch(error){
    if(error.name==='NotAllowedError'||error.name==='PermissionDeniedError'||error.name==='SecurityError'){showPermissionHelp(feature,'blocked');throw permissionError(feature,'denied');}
    throw error;
  }
}
export function openFeatureAccess(){
  stylesheet();const dialog=document.createElement('dialog');dialog.className='feature-access-dialog';dialog.setAttribute('aria-label','Feature access');
  dialog.innerHTML='<h2>Feature access</h2><p>Set up the features you want to use. Android asks separately for each permission.</p><div class="feature-access-list"></div><p class="feature-access-note">Only photos, videos and documents you choose and send reach the chat. SMS and your full gallery are not collected.</p><p class="feature-access-status" role="status"></p><div class="feature-access-actions"><button type="button" data-close>Done</button></div>';
  const list=dialog.querySelector('.feature-access-list'),statusLine=dialog.querySelector('[role=status]');let busy=false;
  for(const [feature,label,description]of [['microphone','Microphone','Voice notes and calls'],['camera','Camera','Camera photos and video calls'],['notifications','Message alerts','Optional notifications for new messages']]){
    const row=document.createElement('div'),text=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small'),button=document.createElement('button');row.className='feature-access-row';strong.textContent=label;small.textContent=description;text.append(strong,small);button.type='button';button.textContent='Set up';
    button.onclick=async()=>{if(busy)return;busy=true;button.disabled=true;statusLine.textContent='Opening '+label.toLowerCase()+'…';try{
      if(feature==='notifications'){
        if(typeof window.RekhaDevice?.showAlertSettings==='function'){window.RekhaDevice.showAlertSettings();statusLine.textContent='Choose Enable in the message alert settings.';}
        else if('Notification'in window){const value=await Notification.requestPermission();statusLine.textContent=value==='granted'?'Browser notification permission allowed. This preview does not provide background web push.':'Notifications were not allowed.';}
        else statusLine.textContent='Message alerts are available in the Android app.';
      }else{const stream=await getFeatureMedia(feature,feature==='microphone'?{audio:true}:{video:true});stream.getTracks().forEach(track=>track.stop());button.textContent='Allowed';statusLine.textContent=label+' is ready.';}
    }catch(error){statusLine.textContent=error.message;}finally{busy=false;if(button.isConnected)button.disabled=false;}};
    row.append(text,button);list.append(row);
  }
  const files=document.createElement('p');files.className='feature-access-note';files.textContent='Photos, videos and documents: tap Attach in chat to open your phone’s picker. No full-gallery permission is needed.';list.append(files);
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();return dialog;
}
