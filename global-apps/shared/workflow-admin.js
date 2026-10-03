const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mediaFields=[['firstVideo','Instruction video','video'],['testimonials','Testimonials video','video'],['kundli','Example kundli image','image'],['solution','Guidance image','image'],['puja','Puja materials image','image'],['voice','Voice message','audio']];
const textFields=[['greeting','First greeting'],['firstCaption','Instruction caption'],['testimonialsCaption','Testimonials caption'],['final','Details request'],['reminder','Follow-up reply'],['kundliCaption','Example kundli caption'],['solutionCaption','Guidance caption'],['pujaCaption','Puja caption']];
const languages=[['hi','हिन्दी'],['en','English'],['hinglish','Hinglish']];
const timingFields=[['firstDelayMs','Instruction video after the greeting',1000],['itemGapMs','Gap between sequence items',1000],['reminderDelayMs','Follow-up after a customer reply',1000],['mediaDelayMs','Images and voice after a customer upload',60000]];
const maximumDelay=7*86400000;
const archived=item=>item.archived===true||item.archived===1||item.archived==='1';
const dateLabel=value=>value!=null&&Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString():'No item scheduled';
let modalCount=0;

function modal(title,canClose=()=>true){
  const dialog=document.createElement('dialog'),titleId='workflow-dialog-title-'+(++modalCount);dialog.className='workflow-dialog';dialog.setAttribute('aria-labelledby',titleId);
  dialog.innerHTML=`<header><h2 id="${titleId}">${esc(title)}</h2><button type="button" data-close aria-label="Close">✕</button></header><div class="workflow-body"><p role="status">Loading…</p></div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-close]').onclick=()=>{if(canClose())dialog.close();};
  dialog.addEventListener('cancel',event=>{if(!canClose())event.preventDefault();});
  dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();return dialog;
}

function confirmRestart(customerName){
  return new Promise(resolve=>{
    const confirmation=modal('Restart this sequence?');let approved=false;
    confirmation.querySelector('.workflow-body').innerHTML=`<p>Restart for <strong>${esc(customerName)}</strong> using your latest wording, files and timing?</p><p class="workflow-note">Already sent messages stay in the chat. Queued items from the previous sequence are cancelled, and the introduction starts again.</p><footer><button type="button" data-confirm-restart class="primary">Restart now</button><button type="button" data-cancel-restart>Cancel</button></footer>`;
    confirmation.querySelector('[data-confirm-restart]').onclick=()=>{approved=true;confirmation.close();};
    confirmation.querySelector('[data-cancel-restart]').onclick=()=>confirmation.close();
    confirmation.addEventListener('close',()=>resolve(approved),{once:true});
  });
}

function selectOptions(items,key,type,current){
  const available=items.filter(item=>item.type===type&&!archived(item));
  const missing=current&&!available.some(item=>item.id===current);
  const old=items.find(item=>item.id===current);
  return `<option value="">Choose from your library</option>${missing?`<option value="${esc(current)}" selected>${esc(old?.title||'Previously selected file')} — unavailable</option>`:''}${available.map(item=>`<option value="${esc(item.id)}" ${current===item.id?'selected':''}>${esc(item.title)}</option>`).join('')}`;
}

export async function openWorkflowSettings({api,notice}){
  let saving=false;
  const dialog=modal('Replies & video flow',()=>!saving);
  async function load(){
    try{
      const [response,library]=await Promise.all([api('/api/admin/workflow/settings'),api('/api/admin/library')]);
      if(!dialog.isConnected)return;
      const config=response.config||response,items=Array.isArray(library)?library:library.items||[];
      dialog.querySelector('.workflow-body').innerHTML=`<p class="workflow-note">Send your introduction, testimonials and follow-ups inside each private chat.</p><form id="workflow-settings" novalidate><label class="workflow-check"><input type="checkbox" name="enabled" ${config.enabled?'checked':''}><span>Enable flow<small>Automatically start for new customers</small></span></label><p class="workflow-note">Turning this off holds queued messages in every chat. Existing chats require <strong>Start</strong> explicitly. Wording, media and timing changes apply to future flows or chats you restart.</p><h3>Videos and shared material</h3><div class="workflow-fields">${mediaFields.map(([key,label,type])=>`<label>${label}<select name="asset-${key}">${selectOptions(items,key,type,config.assets?.[key])}</select><small class="workflow-field-hint">${type==='audio'?'Uploaded voice or audio file':type==='video'?'Uploaded video file':'Uploaded image'}</small></label>`).join('')}</div><p class="workflow-note">Choose all six files before enabling. Archived or unavailable files need a replacement. The payment QR stays inactive during preview; its saved wording is preserved. Example kundli material is labelled as an illustration.</p><h3>Timing</h3><p class="workflow-note">The greeting sends first. Each delay can be from 0 to 7 days.</p><div class="workflow-timings">${timingFields.map(([key,label,unit])=>`<label>${label}<span class="workflow-number"><input type="number" name="time-${key}" required min="0" max="${maximumDelay/unit}" step="any" value="${esc((config.timings?.[key]??0)/unit)}"><small>${unit===1000?'seconds':'minutes'}</small></span></label>`).join('')}</div><h3>Reply wording</h3><p class="workflow-note">Customers receive the wording saved for their chosen language. Missing translations start with the Hindi wording shown here. Review and edit all three languages before saving.</p><nav class="workflow-languages" aria-label="Edit reply language">${languages.map(([key,label],index)=>`<button type="button" data-language="${key}" aria-pressed="${index===0}">${label}</button>`).join('')}</nav>${languages.map(([language],index)=>`<section data-reply-language="${language}" ${index?'hidden':''}>${textFields.map(([key,label])=>`<label>${label}<textarea name="text-${language}-${key}" required maxlength="4000" rows="3">${esc(language==='hi'?config.content?.[key]:config.translations?.[language]?.[key]||config.content?.[key])}</textarea></label>`).join('')}</section>`).join('')}<p id="workflow-error" class="workflow-error" role="alert"></p><footer><button class="primary" type="submit">Save flow</button><button type="button" id="workflow-cancel">Cancel</button></footer></form>`;
      const form=dialog.querySelector('form');
      function showLanguage(language){
        for(const button of dialog.querySelectorAll('[data-language]'))button.setAttribute('aria-pressed',String(button.dataset.language===language));
        for(const section of dialog.querySelectorAll('[data-reply-language]'))section.hidden=section.dataset.replyLanguage!==language;
      }
      for(const button of dialog.querySelectorAll('[data-language]'))button.onclick=()=>showLanguage(button.dataset.language);
      dialog.querySelector('#workflow-cancel').onclick=()=>{if(!saving)dialog.close();};
      form.oninput=event=>event.target.setCustomValidity?.('');
      form.onsubmit=async event=>{
        event.preventDefault();if(saving)return;
        const values=new FormData(form),errorNode=dialog.querySelector('#workflow-error');errorNode.textContent='';
        for(const input of form.querySelectorAll('input,select,textarea'))input.setCustomValidity('');
        const next={enabled:values.get('enabled')==='on',paymentEnabled:false,assets:{...config.assets},timings:{...config.timings},content:{...config.content},translations:{en:{...config.translations?.en},hinglish:{...config.translations?.hinglish}}};
        let invalid=null,validationMessage='';
        for(const [key,label,type]of mediaFields){
          const id=String(values.get('asset-'+key)||'');next.assets[key]=id||null;
          if(next.enabled&&!items.some(item=>item.id===id&&item.type===type&&!archived(item))&&!invalid){invalid=form.elements.namedItem('asset-'+key);validationMessage=`Choose an available ${label.toLowerCase()} from your library.`;}
        }
        for(const [key,label,unit]of timingFields){
          const input=form.elements.namedItem('time-'+key),raw=String(values.get('time-'+key)||''),amount=Number(raw);
          next.timings[key]=Math.round(amount*unit);
          if((!raw.trim()||!Number.isFinite(amount)||amount<0||amount>maximumDelay/unit||!Number.isSafeInteger(next.timings[key]))&&!invalid){invalid=input;validationMessage=`${label} must be between 0 and ${maximumDelay/unit} ${unit===1000?'seconds':'minutes'}.`;}
        }
        for(const [key,label]of textFields)for(const [language,languageLabel]of languages){
          const value=String(values.get(`text-${language}-${key}`)||'').trim();
          if(language==='hi')next.content[key]=value;else next.translations[language][key]=value;
          if((!value||value.length>4000)&&!invalid){showLanguage(language);invalid=form.elements.namedItem(`text-${language}-${key}`);validationMessage=`${languageLabel}: ${label.toLowerCase()} needs 1–4,000 characters.`;}
        }
        if(invalid){errorNode.textContent=validationMessage;invalid.setCustomValidity(validationMessage);invalid.reportValidity();invalid.focus();return;}
        saving=true;dialog.setAttribute('aria-busy','true');
        const controls=[...dialog.querySelectorAll('button,input,select,textarea')];for(const control of controls)control.disabled=true;
        const submit=form.querySelector('[type="submit"]');submit.textContent='Saving…';
        try{await api('/api/admin/workflow/settings','PATCH',next);notice('Reply and video flow saved.');dialog.close();}
        catch(error){errorNode.textContent=error.message||'Could not save. Your edits are still here.';errorNode.scrollIntoView({block:'nearest'});}
        finally{saving=false;dialog.removeAttribute('aria-busy');for(const control of controls)control.disabled=false;submit.textContent='Save flow';if(dialog.isConnected)submit.focus({preventScroll:true});}
      };
    }catch(error){
      if(!dialog.isConnected)return;
      dialog.querySelector('.workflow-body').innerHTML=`<p class="workflow-error" role="alert">${esc(error.message||'Could not load flow settings.')}</p><button type="button" data-retry>Try again</button>`;
      dialog.querySelector('[data-retry]').onclick=load;
    }
  }
  await load();
}

const stageLabels={NEW:'Ready for the first customer message',FIRST_SEQUENCE:'Introduction sequence',WAITING_FOR_DETAILS:'Waiting for customer details',REMINDER_SCHEDULED:'Follow-up scheduled',REMINDER_SENT:'Follow-up sent'};
const pauseReasons={
  'global-disabled':'The global flow is off. Queued messages are held in every chat.',
  'customer-blocked':'This customer is blocked. Scheduled messages are held.',
  'owner-paused':'You paused this customer’s flow.',
  'reply-mode-assist':'AI assisted reply mode holds scheduled messages. Switch this chat to automatic reply mode to send them.',
  'reply-mode-manual':'Personal reply mode holds scheduled messages. Switch this chat to automatic reply mode to send them.'
};
const campaignLabels={NONE:'Waiting for a customer upload',SCHEDULED:'Scheduled',SENT:'Sent'};
const jobLabels={first:'Introduction',reminder:'Follow-up',media:'Images and voice'};
const jobStatuses={pending:'Queued',processing:'Sending',failed:'Needs retry',done:'Sent',cancelled:'Cancelled'};

export async function openChatWorkflow({api,notice,conversationId,customerName}){
  let busy=false,confirming=false,loading=false,timer,data=null,globalConfig=null,actionError='',refreshError='';
  const dialog=modal('Video flow · '+customerName,()=>!busy&&!confirming),route=`/api/admin/conversations/${conversationId}/workflow`;
  dialog.addEventListener('close',()=>clearInterval(timer));
  function render(){
    if(!dialog.isConnected)return;
    const scroll=dialog.scrollTop,focusedAction=document.activeElement?.dataset?.action;
    if(!data){
      dialog.querySelector('.workflow-body').innerHTML=`<p class="workflow-error" role="alert">${esc(refreshError||'Could not load this customer’s flow.')}</p><button type="button" data-refresh>Try again</button>`;
    }else{
      const globalEnabled=globalConfig?.enabled===true,reason=data.pauseReason||(!globalEnabled&&data.enrolled?'global-disabled':null);
      const status=!data.enrolled?'Not started':data.status==='paused'?'Paused':reason?'On hold':data.status==='armed'?'Ready':'Active';
      dialog.querySelector('.workflow-body').innerHTML=`<p class="workflow-note">Replies and media from this sequence stay inside this private conversation.</p><dl class="workflow-state"><dt>Flow</dt><dd><span class="workflow-status ${reason||data.status==='paused'?'is-held':''}">${esc(status)}</span></dd><dt>Stage</dt><dd>${esc(stageLabels[data.stage]||data.stage||'—')}</dd><dt>Next item</dt><dd>${esc(dateLabel(data.nextDue))}${reason&&data.nextDue!=null?'<small>Held until the flow can send again</small>':''}</dd><dt>Media follow-up</dt><dd>${esc(campaignLabels[data.campaign]||data.campaign||'Waiting for a customer upload')}</dd></dl>${reason?`<p class="workflow-note workflow-hold" role="status">${esc(pauseReasons[reason]||'Scheduled messages are currently held.')}</p>`:''}${!globalEnabled?'<p class="workflow-note">Enable the global flow and choose its six files in <strong>Replies & video flow</strong> before starting or restarting this customer.</p>':''}<div class="workflow-actions">${!data.enrolled?`<button type="button" data-action="start" class="primary" ${globalEnabled?'':'disabled'}>Start for this customer</button>`:data.status==='paused'?'<button type="button" data-action="resume" class="primary">Resume flow</button>':'<button type="button" data-action="pause">Pause flow</button>'}${data.enrolled?`<button type="button" data-action="restart" ${globalEnabled?'':'disabled'}>Restart sequence…</button>`:''}<button type="button" data-refresh>Refresh</button></div><p class="workflow-note">The sequence sends only in automatic reply mode. AI assisted and personal reply modes hold scheduled items. Start sends the greeting first; Restart uses your latest wording, files and timing.</p><p id="workflow-error" class="workflow-error" role="alert">${esc(actionError||refreshError)}</p><h3>Queue</h3><ol class="workflow-queue">${(Array.isArray(data.jobs)?data.jobs:[]).map(job=>`<li><strong>${esc(jobLabels[job.kind]||job.label||job.kind||'Follow-up')}</strong><small>${esc(jobStatuses[job.status]||job.status||'Queued')}${Number.isInteger(job.step)?` · Item ${job.step+1}`:''} · ${esc(dateLabel(job.due))}</small></li>`).join('')||'<li>No queued messages.</li>'}</ol>`;
      for(const button of dialog.querySelectorAll('[data-action]'))button.onclick=()=>act(button.dataset.action);
    }
    dialog.querySelector('[data-refresh]').onclick=()=>refresh();
    dialog.scrollTop=scroll;
    if(focusedAction)dialog.querySelector(`[data-action="${focusedAction}"]`)?.focus({preventScroll:true});
  }
  async function refresh(){
    if(busy||loading||!dialog.isConnected)return;loading=true;
    try{
      const [view,settings]=await Promise.all([api(route),api('/api/admin/workflow/settings')]);
      if(!dialog.isConnected||busy)return;data=view;globalConfig=settings.config||settings;refreshError='';render();
    }catch(error){refreshError=error.message||'Could not refresh. The last loaded state is shown.';if(dialog.isConnected&&!busy)render();}
    finally{loading=false;}
  }
  async function act(action){
    if(busy||confirming)return;
    if(action==='restart'){confirming=true;const approved=await confirmRestart(customerName);confirming=false;if(!approved||!dialog.isConnected)return;}
    busy=true;actionError='';dialog.setAttribute('aria-busy','true');
    for(const button of dialog.querySelectorAll('button'))button.disabled=true;
    try{
      data=await api(route,'PATCH',{action});
      const held=data.pauseReason&&data.pauseReason!=='owner-paused';
      notice(action==='pause'?'Customer flow paused.':held?'Flow updated. Scheduled messages are still held.':action==='restart'?'Customer sequence restarted.':action==='start'?'Customer sequence started.':'Customer flow resumed.');
    }catch(error){actionError=error.message||'Could not update this customer’s flow.';}
    finally{busy=false;dialog.removeAttribute('aria-busy');dialog.querySelector('[data-close]').disabled=false;render();await refresh();}
  }
  await refresh();if(dialog.isConnected)timer=setInterval(()=>refresh(),4500);
}
