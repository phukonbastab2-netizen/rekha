const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.floor(value):0;
const countFormat=new Intl.NumberFormat(),dateFormat=new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'});
const actionLabels={
  page_view:'Visited a page',screen_view:'Viewed a screen',app_open:'Opened the Android app',first_app_open:'First shared Android app open',
  download_start:'Started an Android download',button_click:'Tapped a button',link_click:'Opened a link',input_click:'Selected a field',page_click:'Tapped the page',
  language_select:'Changed language',install_help:'Viewed install help',privacy_open:'Viewed privacy choices',
  chat_send:'Sent a message',chat_attach:'Opened attachments',chat_voice:'Selected voice message',chat_call:'Selected audio call',chat_video_call:'Selected video call',chat_menu:'Opened chat settings',
  profile_send:'Sent birth details',donate_interest:'Selected donation interest',yes_choice:'Selected Yes',media_play:'Played shared media',media_ended:'Finished shared media',
  install_home:'Selected Home Screen install',open_app:'Selected Open app',download_app:'Selected Android download',
  language_hi:'Selected Hindi',language_en:'Selected English',platform_android:'Selected Android',platform_ios:'Selected iPhone / iPad',
  privacy_policy:'Opened privacy policy',terms:'Opened terms',support:'Opened support',contact:'Opened contact',policies:'Opened policies',delete_data:'Opened data deletion',about:'Opened About',disclaimer:'Opened disclaimer',refunds:'Opened refund policy',delivery:'Opened delivery policy',
  details_submit:'Sent birth details',intro_play:'Played introduction video',intro_pause:'Paused introduction video',intro_end:'Finished introduction video',
  send_message:'Sent a message',open_settings:'Opened chat settings',attachment_menu:'Opened attachments',attachment_open:'Opened a shared attachment',
  voice_record:'Selected voice recording',call_audio:'Selected audio call',call_video:'Selected video call',media_pause:'Paused shared media',media_end:'Finished shared media',media_open:'Opened shared media',
  kundli_open:'Opened the kundli image',yes_reply:'Selected Yes',back_chat:'Returned to chat',consent_accept:'Enabled activity sharing',consent_decline:'Disabled activity sharing',
  profile_name:'Selected the name field',profile_dob:'Selected the birth date field',intro_retry:'Retried the introduction video',chat_input:'Selected the message field',
  chat_camera:'Selected the camera',chat_emoji:'Opened emoji choices',chat_cancel_context:'Cancelled a quoted reply',voice_cancel:'Cancelled voice recording',voice_stop:'Finished voice recording',
  chat_search:'Searched the conversation',chat_starred:'Viewed starred messages',chat_media:'Viewed shared media',chat_export:'Selected chat export',feature_access:'Opened feature permissions',
  message_alerts:'Opened message alerts',chat_sounds:'Changed chat sounds',privacy_save:'Saved privacy choices',chat_delete:'Selected chat deletion',dialog_close:'Closed a dialog',
  delete_cancel:'Cancelled deletion',delete_confirm:'Confirmed deletion',activity_settings:'Opened activity sharing choices',chat_retry:'Retried a message',chat_latest:'Jumped to latest messages',
  chat_history:'Loaded earlier messages',chat_unlock:'Selected the chat offer',app_retry:'Retried opening the app',chat_reopen:'Reopened the conversation',
  call_answer:'Selected answer call',call_mute:'Changed microphone mute',call_end:'Ended the call',call_audio_enable:'Enabled call audio',
  message_reply:'Quoted a message',message_star:'Changed a message star',message_copy:'Copied a message',message_edit:'Selected message edit',message_delete:'Selected message deletion',message_react:'Reacted to a message',
  chat_emoji_insert:'Selected an emoji',attachment_remove:'Removed a pending attachment',chat_result_open:'Opened a search result',message_options:'Opened message actions',message_quote_open:'Opened a quoted message',
  attachment_gallery:'Selected photo or video attachment',attachment_document:'Selected document attachment',camera_capture:'Selected camera capture',camera_cancel:'Cancelled camera capture',chat_prompt:'Selected a suggested question'
};
const screenLabels={website:'Website',splash:'Welcome',language:'Language selection',profile:'Birth details',details:'Birth details',permissions:'Privacy choices',kundli_loading:'Kundli loading',chat:'Private chat',privacy:'Privacy choices',install_help:'Install help',download:'Download page',install:'Home Screen install',intro:'Introduction video',policy:'Policy page',offline:'Offline screen'};
const pageLabels={'/':'Home','/download.html':'Download page','/astrorani':'Download page','/astrorani/':'Download page','/install':'Home Screen install','/install/':'Home Screen install','/home-install.html':'Home Screen install','/privacy-policy.html':'Privacy policy','/terms-and-conditions.html':'Terms','/support.html':'Support','/contact.html':'Contact','/data-deletion.html':'Data deletion','/about.html':'About','/disclaimer.html':'Disclaimer','/refund-cancellation.html':'Refund policy','/shipping-policy.html':'Delivery policy'};
let activeActivity=null,dialogSerial=0;
function dateValue(value){if(value==null||value==='')return null;const numeric=typeof value==='number'||/^\d+$/.test(String(value))?Number(value):Date.parse(value);return Number.isFinite(numeric)&&Number.isFinite(new Date(numeric).getTime())?numeric:null;}
function localDate(value){const at=dateValue(value);return at===null?'Time unavailable':dateFormat.format(at);}
function labelForAction(event){return actionLabels[event.action]||actionLabels[event.type]||(event.surface==='website'?'Website activity':'App activity');}
function labelForScreen(event){return screenLabels[event.screen]||pageLabels[event.page]||(event.surface==='website'?'Website':'Customer app');}
function eventKey(event){return String(event.id??`${event.sessionId}:${event.received}:${event.action}`);}
function mergeEvents(before,next){const found=new Map(before.map(event=>[eventKey(event),event]));for(const event of next)found.set(eventKey(event),event);return [...found.values()].sort((a,b)=>(dateValue(b.received)??0)-(dateValue(a.received)??0)||String(b.id).localeCompare(String(a.id),undefined,{numeric:true}));}
export function closeCustomerActivity(){activeActivity?.close();}

export function openCustomerActivity({api,notice=()=>{},conversationId=null,customerName='',currentCustomerOnly=false,onOpenConversation}={}){
  closeCustomerActivity();
  const currentId=uuid(conversationId)?conversationId:null,titleId='activity-title-'+(++dialogSerial),dialog=document.createElement('dialog');
  let events=[],summary=null,topActions=[],cursor=null,budget=null,surface='all',hours=24,onlyCurrent=currentCustomerOnly&&!!currentId,visitorId=null;
  let controller=null,requestVersion=0,timer=null,disposed=false,busy=false,authFailed=false,lastUpdated=null,historyLoaded=false;
  dialog.className='activity-dialog';dialog.setAttribute('aria-labelledby',titleId);
  dialog.innerHTML=`<header class="activity-header"><div><p class="activity-eyebrow">PRIVATE OWNER VIEW</p><h2 id="${titleId}">Customer activity</h2><p>Website visits and activity customers choose to share.</p></div><button type="button" data-activity-close aria-label="Close customer activity">✕</button></header><div class="activity-content"><div class="activity-toolbar"><nav class="activity-surfaces" aria-label="Activity surface"><button type="button" data-activity-surface="all" aria-pressed="true">All</button><button type="button" data-activity-surface="website" aria-pressed="false">Website</button><button type="button" data-activity-surface="customer" aria-pressed="false">Customer app</button></nav><div class="activity-refresh-controls"><label>Period<select id="activity-period" aria-label="Activity period"><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option></select></label><button type="button" id="activity-refresh">Refresh</button></div></div>${currentId?`<label class="activity-customer-filter"><input type="checkbox" id="activity-current-customer" ${onlyCurrent?'checked':''}><span>Only ${esc(customerName||'this customer')}</span></label>`:''}<div class="activity-summary" id="activity-summary" aria-label="Activity totals"></div><div class="activity-recording" id="activity-recording" hidden></div><p class="activity-period-note" id="activity-period-note"></p><p class="activity-error" id="activity-error" role="alert" hidden></p><section class="activity-top" id="activity-top" hidden><h3>Most used actions</h3><div id="activity-top-actions"></div></section><section class="activity-recent"><div class="activity-section-heading"><h3>Recent activity</h3><p id="activity-updated" role="status" aria-live="polite">Loading activity…</p></div><ol class="activity-timeline" id="activity-timeline"></ol><div class="activity-history"><button type="button" id="activity-older" hidden>Load older activity</button><span id="activity-loaded"></span></div></section><footer class="activity-footnote">Shared activity only. Download starts do not confirm installation. Android first opens confirm the app ran; phones that do not share activity are not counted.</footer></div>`;
  const visitorFilter=document.createElement('div');visitorFilter.id='activity-visitor-filter';visitorFilter.className='activity-visitor-filter';visitorFilter.hidden=true;
  visitorFilter.innerHTML='<span id="activity-visitor-label"></span><button type="button" id="activity-clear-visitor" aria-label="Clear visitor activity filter">Clear visitor ✕</button>';
  dialog.querySelector('#activity-summary').before(visitorFilter);
  document.body.append(dialog);dialog.showModal();
  const close=()=>{if(dialog.open)dialog.close();cleanup();};activeActivity={close};
  function cleanup(){if(disposed)return;disposed=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visibilityChanged);if(activeActivity?.close===close)activeActivity=null;dialog.remove();}
  function schedule(){clearTimeout(timer);if(!disposed&&dialog.open&&!document.hidden&&!authFailed)timer=setTimeout(()=>load({automatic:true}),15000);}
  function visibilityChanged(){clearTimeout(timer);if(document.hidden)controller?.abort();else if(!authFailed)load({automatic:true});}
  dialog.addEventListener('close',cleanup,{once:true});document.addEventListener('visibilitychange',visibilityChanged);
  dialog.querySelector('[data-activity-close]').onclick=close;
  function setStatus(message){dialog.querySelector('#activity-updated').textContent=message;}
  function drawSummary(){
    const tiles=[['visitors','Visitors','Shared visitors'],['clicks','Clicks','Shared button and page taps'],['downloadStarts','Download starts','File served; not installed'],['appOpens','App opens','Shared Android app sessions'],['firstAppOpens','Android first opens','First shared run on this device'],['events','Shared events','Activity in this period']];
    dialog.querySelector('#activity-summary').innerHTML=tiles.map(([key,label,note])=>`<article class="activity-stat ${key==='firstAppOpens'?'activity-stat-highlight':''}"><span>${label}</span><strong>${summary===null?'—':summary[key]===null?'—':countFormat.format(number(summary[key]))}</strong><small>${summary?.[key]===null&&key==='downloadStarts'?'Not available for this filter':note}</small></article>`).join('');
    const period=hours===24?'Last 24 hours':hours===168?'Last 7 days':'Last 30 days',downloadDays=number(summary?.downloadWindowDays);
    const notes=[period];if(summary?.sampled)notes.push('shared totals use the latest 10,000 events');if(downloadDays&&summary?.downloadStarts!==null)notes.push('download totals cover the UTC days in this period');
    dialog.querySelector('#activity-period-note').textContent=notes.join(' · ');
    const recording=dialog.querySelector('#activity-recording');recording.hidden=!budget;
    if(budget){const used=number(budget.used),limit=number(budget.limit);recording.classList.toggle('paused',budget.paused===true);recording.innerHTML=`<span class="activity-recording-dot" aria-hidden="true"></span><span>${budget.paused?'Activity recording paused for today':'Recording budget'}${limit?` · ${countFormat.format(used)} / ${countFormat.format(limit)} used today`:''}</span>${budget.paused?`<small>Existing activity stays available.${dateValue(budget.resetAt)!==null?` Resets ${esc(localDate(budget.resetAt))}.`:''}</small>`:''}`;}
  }
  function drawTopActions(){
    const list=topActions.filter(item=>item&&typeof item.action==='string').slice(0,6),section=dialog.querySelector('#activity-top');section.hidden=!list.length;
    dialog.querySelector('#activity-top-actions').innerHTML=list.map(item=>`<span>${esc(actionLabels[item.action]||'Other activity')}<strong>${countFormat.format(number(item.count))}</strong></span>`).join('');
  }
  function drawTimeline(){
    const timeline=dialog.querySelector('#activity-timeline');
    if(!events.length){timeline.innerHTML=`<li class="activity-empty"><span aria-hidden="true">◷</span><h4>${busy?'Loading shared activity…':'No shared activity yet'}</h4><p>${busy?'Your recent activity will appear here.':'Events appear when visitors or customers choose to share activity. Try a different period or filter.'}</p></li>`;}
    else timeline.innerHTML=events.map(event=>{
      const validConversation=uuid(event.conversationId),name=event.customerName?String(event.customerName).slice(0,160):null,session=uuid(event.sessionId)?event.sessionId.slice(0,8):'unknown',identity=name||(validConversation?'Customer':'Anonymous visitor'),surfaceLabel=event.surface==='website'?'Website':'Customer app',date=dateValue(event.at??event.received);
      return `<li class="activity-event"><div class="activity-event-time"><time${date===null?'':` datetime="${new Date(date).toISOString()}"`}>${esc(localDate(event.at??event.received))}</time><span class="activity-surface ${event.surface==='website'?'website':'customer'}">${surfaceLabel}</span></div><div class="activity-event-person">${validConversation&&typeof onOpenConversation==='function'?`<button class="activity-customer-link" type="button" data-activity-chat="${esc(event.conversationId)}" aria-label="${esc('Open chat with '+identity)}">${esc(identity)} <span aria-hidden="true">↗</span></button>`:`<strong>${esc(identity)}</strong>`}<small>${validConversation?'Private customer chat':`Session ${esc(session)}`}</small></div><div class="activity-event-detail"><strong>${esc(labelForAction(event))}</strong><span>${esc(labelForScreen(event))}</span></div></li>`;
    }).join('');
    for(const [index,row]of [...timeline.querySelectorAll('.activity-event')].entries()){
      const id=events[index]?.visitorId;if(!uuid(id))continue;
      const button=document.createElement('button');button.type='button';button.className='activity-visitor-link';button.dataset.activityVisitor=id;button.textContent='View visitor · '+id.slice(0,8);button.setAttribute('aria-pressed',String(visitorId===id));button.setAttribute('aria-label','View shared activity for visitor '+id.slice(0,8));row.querySelector('.activity-event-person').append(button);
    }
    dialog.querySelector('#activity-older').hidden=!cursor;dialog.querySelector('#activity-older').disabled=busy;
    dialog.querySelector('#activity-older').textContent=busy?'Loading…':'Load older activity';
    dialog.querySelector('#activity-loaded').textContent=events.length?`${countFormat.format(events.length)} recent events shown`:'';
    dialog.querySelector('#activity-refresh').disabled=busy;
  }
  function draw(){visitorFilter.hidden=!visitorId;dialog.querySelector('#activity-visitor-label').textContent=visitorId?'Visitor '+visitorId.slice(0,8):'';drawSummary();drawTopActions();drawTimeline();}
  function resetFilter(){events=[];summary=null;topActions=[];cursor=null;budget=null;lastUpdated=null;historyLoaded=false;authFailed=false;draw();load({clear:true});}
  for(const button of dialog.querySelectorAll('[data-activity-surface]'))button.onclick=()=>{if(surface===button.dataset.activitySurface)return;surface=button.dataset.activitySurface;for(const option of dialog.querySelectorAll('[data-activity-surface]'))option.setAttribute('aria-pressed',String(option===button));resetFilter();};
  dialog.querySelector('#activity-period').onchange=event=>{hours=Number(event.target.value);resetFilter();};
  const customerFilter=dialog.querySelector('#activity-current-customer');if(customerFilter)customerFilter.onchange=()=>{onlyCurrent=customerFilter.checked;resetFilter();};
  dialog.querySelector('#activity-clear-visitor').onclick=()=>{visitorId=null;resetFilter();};
  dialog.querySelector('#activity-refresh').onclick=()=>load();dialog.querySelector('#activity-older').onclick=()=>load({older:true});
  dialog.querySelector('#activity-timeline').onclick=event=>{
    const visitorButton=event.target.closest('[data-activity-visitor]');if(visitorButton&&uuid(visitorButton.dataset.activityVisitor)){if(visitorId===visitorButton.dataset.activityVisitor)return;visitorId=visitorButton.dataset.activityVisitor;resetFilter();dialog.scrollTo({top:0,behavior:'instant'});return;}
    const button=event.target.closest('[data-activity-chat]');if(!button||!uuid(button.dataset.activityChat)||typeof onOpenConversation!=='function')return;const id=button.dataset.activityChat;close();Promise.resolve().then(()=>onOpenConversation(id)).catch(()=>notice('Could not open this customer chat. Please try from the inbox.'));
  };
  async function load({older=false,automatic=false,clear=false}={}){
    if(disposed||!dialog.open||automatic&&document.hidden)return;
    if(busy&&(automatic||older))return;
    if(older&&!cursor)return;
    clearTimeout(timer);controller?.abort();const nextController=new AbortController(),version=++requestVersion;controller=nextController;busy=true;
    if(clear)events=[];
    const errorLabel=dialog.querySelector('#activity-error');errorLabel.hidden=true;setStatus(older?'Loading older activity…':'Updating activity…');drawTimeline();
    const query=new URLSearchParams({hours:String(hours)});if(surface!=='all')query.set('surface',surface);if(onlyCurrent&&currentId)query.set('conversationId',currentId);if(visitorId)query.set('visitorId',visitorId);if(older&&cursor)query.set('before',cursor);
    try{
      const response=await api('/api/admin/activity?'+query,'GET',undefined,{signal:nextController.signal});
      if(disposed||version!==requestVersion||nextController.signal.aborted)return;
      if(!response||!Array.isArray(response.events)||!response.summary||!Array.isArray(response.topActions))throw Error('Activity could not be read. Please refresh.');
      const next=response.events.filter(event=>event&&typeof event==='object'&&['website','customer'].includes(event.surface));
      events=mergeEvents(events,next);summary=response.summary;topActions=response.topActions;budget=response.budget||response.collection||null;
      if(older||!historyLoaded)cursor=typeof response.nextCursor==='string'&&response.nextCursor?response.nextCursor:null;
      if(older)historyLoaded=true;lastUpdated=Date.now();authFailed=false;draw();setStatus('Updated '+localDate(lastUpdated));
    }catch(error){
      if(disposed||version!==requestVersion||nextController.signal.aborted)return;
      authFailed=error.status===401||error.status===403;
      if(authFailed){events=[];summary=null;topActions=[];cursor=null;budget=null;draw();}
      errorLabel.textContent=authFailed?'Your owner session expired. Close this view and sign in again.':navigator.onLine===false?'You are offline. Connect and refresh to load activity.':'Could not update activity. Your loaded events stay here. Please refresh.';errorLabel.hidden=false;setStatus(authFailed?'Owner sign-in required':lastUpdated?'Showing the last successful update':'Activity unavailable');
    }finally{
      if(!disposed&&version===requestVersion){controller=null;busy=false;dialog.querySelector('#activity-refresh').disabled=false;dialog.querySelector('#activity-older').disabled=false;dialog.querySelector('#activity-older').textContent='Load older activity';schedule();}
    }
  }
  draw();load();return dialog;
}
