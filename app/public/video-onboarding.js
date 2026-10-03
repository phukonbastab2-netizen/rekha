const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// A client playback gate records continuous visible playback. It is a UI
// requirement, not proof that a person paid attention or an OS restriction.
export function createWatchProgress(initial={}){
  let until=Math.max(0,Number(initial.until)||0),complete=initial.complete===true,last=null;
  return {
    observe({time,duration,playing,visible=true,seeking=false,ended=false},now){
      if(complete)return this.state(duration);
      if(!Number.isFinite(time)||!Number.isFinite(duration)||duration<=0||!Number.isFinite(now))return this.state(duration);
      const active=visible&&!seeking&&(playing||ended&&last?.active);
      const elapsed=last?Math.max(0,(now-last.wall)/1000):0;
      const delta=last?time-last.time:0;
      if(active&&last?.active&&delta>=0&&delta<=elapsed+0.65&&last.time<=until+0.35&&time<=until+elapsed+0.65)until=Math.max(until,Math.min(time,duration));
      last={time,wall:now,active:visible&&!seeking&&playing};
      // Only a real end after covered playback unlocks. Seeking to the end or
      // merely firing an ended event does not create played coverage.
      if(ended&&visible&&!seeking&&until>=duration-0.35)complete=true;
      return this.state(duration);
    },
    state(duration=0){return{until,complete,percent:complete?100:Number.isFinite(duration)&&duration>0?Math.min(99,Math.floor(until/duration*100)):0};},
    seekLimit(time){return complete?time:Math.max(0,Math.min(Number(time)||0,until));},
  };
}

export function bindVideoGate(video,{initial,onState=()=>{},onError=()=>{},visible=()=>!document.hidden,now=()=>performance.now()}={}){
  const progress=createWatchProgress(initial),controller=new AbortController(),options={signal:controller.signal};
  const publish=()=>onState(progress.state(video.duration));
  const observe=()=>{onState(progress.observe({time:video.currentTime,duration:video.duration,playing:!video.paused&&!video.ended,visible:visible(),seeking:video.seeking,ended:video.ended},now()));};
  const seek=()=>{const state=progress.state(video.duration);if(!state.complete&&video.currentTime>state.until+0.35){video.currentTime=progress.seekLimit(video.currentTime);onState({...state,seekBlocked:true});}observe();};
  for(const event of ['play','pause','timeupdate','ended','loadedmetadata','seeked','waiting','playing'])video.addEventListener(event,observe,options);
  video.addEventListener('seeking',seek,options);
  video.addEventListener('ratechange',()=>{if(video.playbackRate!==1)video.playbackRate=1;},options);
  video.addEventListener('error',()=>onError(),options);
  document.addEventListener('visibilitychange',()=>{if(!visible())video.pause();observe();},options);
  publish();
  return{state:()=>progress.state(video.duration),dispose:()=>{controller.abort();video.pause();}};
}

export function validSignupDraft({name,dob},now=new Date()){
  if(typeof name!=='string'||!name.trim()||name.trim().length>60||typeof dob!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(dob)||dob<'1900-01-01')return false;
  const date=new Date(dob+'T00:00:00Z'),cutoff=new Date(now);cutoff.setUTCFullYear(cutoff.getUTCFullYear()-18);
  return Number.isFinite(+date)&&date.toISOString().slice(0,10)===dob&&date<=cutoff;
}

export async function waitForPreparation(started,{now=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),minimumMs=5000}={}){
  const remaining=Math.max(0,minimumMs-(now()-started));if(remaining)await wait(remaining);
}

const copy={
  en:{watch:'Watch the video, then send your details',note:'Please watch the complete video to open the form below.',done:'Video complete. Enter your name and date of birth.',name:'Your name',placeholder:'Enter your full name',dob:'Date of birth',send:'Send',retry:'Reload video',failed:'The video could not load. Reload it to continue.',privacy:'By tapping Send, you confirm you are 18 or older and agree to the Privacy Policy.',use:'Your name and birth date are saved for this private chat. The first kundli image is a shared reference from our existing flow.',preparing:'Preparing your kundli…',prepareNote:'Your conversation will open in a few seconds.',invalid:'Enter your name and a valid birth date. This app is for adults 18+.'},
  hi:{watch:'वीडियो देखिए, फिर अपनी जानकारी भेजिए',note:'नीचे दिए फ़ॉर्म को खोलने के लिए पूरा वीडियो देखिए।',done:'वीडियो पूरा हुआ। अपना नाम और जन्म तिथि भरिए।',name:'आपका नाम',placeholder:'अपना पूरा नाम लिखिए',dob:'जन्म तिथि',send:'भेजें',retry:'वीडियो फिर लोड करें',failed:'वीडियो लोड नहीं हुआ। आगे बढ़ने के लिए फिर लोड करें।',privacy:'भेजें दबाकर आप पुष्टि करते हैं कि आपकी उम्र 18 वर्ष या अधिक है और आप गोपनीयता नीति से सहमत हैं।',use:'आपका नाम और जन्म तिथि इस निजी बातचीत के लिए सहेजी जाएगी। पहली कुंडली तस्वीर हमारे मौजूदा फ़्लो की साझा संदर्भ तस्वीर है।',preparing:'आपकी कुंडली तैयार हो रही है…',prepareNote:'कुछ सेकंड में आपकी बातचीत खुल जाएगी।',invalid:'अपना नाम और सही जन्म तिथि भरिए। यह ऐप 18 वर्ष या अधिक आयु वालों के लिए है।'},
  hinglish:{watch:'Video dekhiye, phir apni details bhejiye',note:'Neeche ka form kholne ke liye poora video dekhiye.',done:'Video poora hua. Apna naam aur birth date bhariye.',name:'Aapka naam',placeholder:'Apna poora naam likhiye',dob:'Date of birth',send:'Send',retry:'Video dobara load karein',failed:'Video load nahi hua. Aage badhne ke liye dobara load karein.',privacy:'Send dabakar aap confirm karte hain ki aap 18+ hain aur Privacy Policy se agree karte hain.',use:'Naam aur birth date is private chat ke liye save honge. Pehli kundli photo hamare existing flow ka shared reference hai.',preparing:'Aapki kundli taiyar ho rahi hai…',prepareNote:'Kuch seconds mein aapki conversation khul jayegi.',invalid:'Apna naam aur sahi birth date bhariye. Yeh app adults 18+ ke liye hai.'},
};

export function mountVideoSignup(app,{brandName='Rekha Astrology',language='en',profile={},progress={},onLanguage=()=>{},onSubmit=()=>{}}={}){
  let lang=Object.hasOwn(copy,language)?language:'en',failed=false,submitting=false;
  const cutoff=new Date();cutoff.setUTCFullYear(cutoff.getUTCFullYear()-18);
  app.innerHTML=`<section class="screen kundli-onboarding"><header class="onboarding-heading"><strong>${escape(brandName)}</strong><label class="onboarding-language"><span class="sr-only">Language</span><select id="onboarding-language" aria-label="Language">${[['en','English'],['hi','हिन्दी'],['hinglish','Hinglish']].map(([id,title])=>`<option value="${id}" ${id===lang?'selected':''}>${title}</option>`).join('')}</select></label></header><h1 data-onboarding-copy="watch"></h1><video id="onboarding-video" class="onboarding-video" controls playsinline preload="metadata" controlslist="nodownload noplaybackrate" disablepictureinpicture poster="/onboarding-poster.jpg" src="/intro/onboarding.mp4" aria-label="Rekha Astrology introduction"></video><div class="onboarding-progress"><progress id="watch-progress" max="100" value="0" aria-label="Video watched"></progress><span id="watch-percent">0%</span></div><p id="watch-status" class="onboarding-status" role="status"></p><button id="reload-onboarding-video" type="button" class="secondary" hidden data-onboarding-copy="retry"></button><form id="kundli-signup"><fieldset id="signup-details" disabled><label class="field"><span data-onboarding-copy="name"></span><input id="signup-name" name="name" autocomplete="given-name" maxlength="60" required value="${escape(profile.name||'')}"></label><label class="field"><span data-onboarding-copy="dob"></span><input id="signup-dob" name="dob" type="date" required min="1900-01-01" max="${cutoff.toISOString().slice(0,10)}" value="${escape(profile.dob||'')}"></label></fieldset><p class="onboarding-use" data-onboarding-copy="use"></p><p class="error" id="signup-error" role="alert"></p><button class="primary" id="kundli-send" type="submit" disabled data-onboarding-copy="send"></button><p class="onboarding-consent"><span data-onboarding-copy="privacy"></span> <a href="https://rekhaastrology.in/astrorani/privacy-policy.html" target="_blank" rel="noopener noreferrer">Privacy Policy</a></p></form></section>`;
  const video=app.querySelector('#onboarding-video'),form=app.querySelector('#kundli-signup'),fieldset=app.querySelector('#signup-details'),button=app.querySelector('#kundli-send'),status=app.querySelector('#watch-status'),error=app.querySelector('#signup-error');
  const draft=()=>({name:form.elements.name.value.trim(),dob:form.elements.dob.value});
  let gate;
  const refresh=state=>{state??=gate?.state()||progress;fieldset.disabled=!state.complete||submitting;button.disabled=!state.complete||submitting||!validSignupDraft(draft());form.dataset.videoComplete=String(state.complete===true);app.querySelector('#watch-progress').value=state.percent||0;app.querySelector('#watch-percent').textContent=(state.percent||0)+'%';const label=copy[lang][failed?'failed':state.complete?'done':'note'];if(status.textContent!==label)status.textContent=label;};
  const translate=()=>{for(const node of app.querySelectorAll('[data-onboarding-copy]'))node.textContent=copy[lang][node.dataset.onboardingCopy];form.elements.name.placeholder=copy[lang].placeholder;refresh();};
  gate=bindVideoGate(video,{initial:progress,onState:refresh,onError:()=>{failed=true;app.querySelector('#reload-onboarding-video').hidden=false;refresh();}});
  translate();form.addEventListener('input',()=>{error.textContent='';refresh();});
  app.querySelector('#onboarding-language').onchange=event=>{lang=event.target.value;onLanguage(lang);translate();};
  app.querySelector('#reload-onboarding-video').onclick=()=>{failed=false;video.load();app.querySelector('#reload-onboarding-video').hidden=true;refresh();};
  form.onsubmit=event=>{event.preventDefault();if(submitting||!gate.state().complete)return;const values=draft();if(!validSignupDraft(values)){error.textContent=copy[lang].invalid;return;}submitting=true;video.pause();refresh();onSubmit({...values,language:lang,consent:true},gate.state());};
  return{draft,state:()=>gate.state(),setError:message=>{submitting=false;error.textContent=message;refresh();},dispose:()=>gate.dispose()};
}

export function renderKundliPreparation(app,language='en'){
  const text=copy[language]||copy.en;
  app.innerHTML=`<section class="kundli-preparation" role="status" aria-live="polite"><div class="kundli-wheel" aria-hidden="true"><svg viewBox="0 0 160 160"><circle cx="80" cy="80" r="72"/><circle cx="80" cy="80" r="54"/><path d="M80 26 134 80 80 134 26 80ZM26 26 134 134M134 26 26 134"/><circle cx="80" cy="80" r="8"/></svg></div><h1>${escape(text.preparing)}</h1><p>${escape(text.prepareNote)}</p><div class="kundli-progress" aria-hidden="true"><span></span></div></section>`;
}
