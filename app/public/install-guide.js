const customerAppUrl='https://astrorani.rekhaastrology.in/';
const copy={
  hi:{
    pageTitle:'Rekha Astrology — डाउनलोड',skip:'मुख्य सामग्री पर जाएँ',title:'Rekha से बात करें',intro:'आपकी निजी ज्योतिष चैट।',
    download:'ऐप डाउनलोड करें',meta:'Android 8+',iosOpen:'iPhone / iPad पर खोलें',
    guideTitle:'3 आसान कदम',step1Title:'डाउनलोड करें',step1Text:'ऊपर वाला बटन दबाएँ।',step2Title:'फ़ाइल खोलें',step2Text:'फोन के Downloads में जाएँ।',step3Title:'Install → Open',step3Text:'ऐप खोलकर शुरू करें।',
    fileHelpTitle:'फ़ाइल नहीं मिल रही?',fileHelpText:'Files → Downloads → RekhaAstrology.apk',
    permissionTitle:'इंस्टॉल की अनुमति?',permissionText:'अगर पूछा जाए: Settings → Allow from this source → Install',permissionNote:'Play Protect चालू रखें।',
    iosGuideTitle:'Home Screen पर जोड़ें',iosStep1Title:'Safari में खोलें',iosStep1Text:'ऊपर वाला बटन दबाएँ।',iosStep2Title:'Share दबाएँ',iosStep2Text:'↑ वाला बटन या Safari का मेन्यू।',iosStep3Title:'Add to Home Screen',iosStep3Text:'Open as Web App दिखे तो चालू रखें, फिर Add दबाएँ।',
    iosHelpTitle:'विकल्प नहीं दिख रहा?',iosHelpText:'Safari में ऐप खोलें। Share → Edit Actions में Add to Home Screen जोड़ें।',
    iosOtherBrowser:'इंस्टॉल करने के लिए Safari में खोलें।',requested:'Downloads में RekhaAstrology.apk खोलें।',
    privacy:'गोपनीयता',terms:'नियम',help:'मदद',contact:'संपर्क',deletion:'डेटा मिटाएँ',policies:'नीतियाँ',about:'हमारे बारे में',disclaimer:'ज़रूरी जानकारी',refund:'रिफंड',shipping:'डिलीवरी नीति',
    languageLabel:'भाषा',platformLabel:'अपना फोन चुनें'
  },
  en:{
    pageTitle:'Rekha Astrology — Download',skip:'Skip to content',title:'Talk with Rekha',intro:'Your private astrology chat.',
    download:'Download for Android',meta:'Android 8+',iosOpen:'Open for iPhone / iPad',
    guideTitle:'3 simple steps',step1Title:'Download',step1Text:'Tap the button above.',step2Title:'Open the file',step2Text:'Find it in Downloads.',step3Title:'Install → Open',step3Text:'Open the app to begin.',
    fileHelpTitle:'Cannot find the file?',fileHelpText:'Files → Downloads → RekhaAstrology.apk',
    permissionTitle:'Install permission?',permissionText:'If asked: Settings → Allow from this source → Install',permissionNote:'Keep Play Protect on.',
    iosGuideTitle:'Add to Home Screen',iosStep1Title:'Open in Safari',iosStep1Text:'Tap the button above.',iosStep2Title:'Tap Share',iosStep2Text:'Use ↑ or Safari’s menu.',iosStep3Title:'Add to Home Screen',iosStep3Text:'Enable Open as Web App if shown, then tap Add.',
    iosHelpTitle:'Need help?',iosHelpText:'Open the app in Safari. In Share → Edit Actions, add Add to Home Screen.',
    iosOtherBrowser:'Open in Safari to install.',requested:'Open RekhaAstrology.apk in Downloads.',
    privacy:'Privacy',terms:'Terms',help:'Help',contact:'Contact',deletion:'Delete data',policies:'Policies',about:'About',disclaimer:'Disclaimer',refund:'Refunds',shipping:'Delivery',
    languageLabel:'Language',platformLabel:'Choose your phone'
  }
};
const userAgent=navigator.userAgent||'';
const actualIos=/iPhone|iPad|iPod/i.test(userAgent)||/Macintosh/i.test(userAgent)&&navigator.maxTouchPoints>1;
const actualAndroid=/Android/i.test(userAgent),desktop=!actualIos&&!actualAndroid;
const otherIosBrowser=actualIos&&(/CriOS|FxiOS|EdgiOS|OPiOS|GSA|FBAN|FBAV|Instagram/i.test(userAgent)||!/Safari/i.test(userAgent));
let language='hi',platform=actualIos?'ios':'android',requested=false;
try{const saved=localStorage.getItem('rekha:install-language');if(Object.hasOwn(copy,saved))language=saved;}catch{}
function render(){
  const words=copy[language],ios=platform==='ios';
  document.documentElement.lang=language;document.title=words.pageTitle;
  for(const node of document.querySelectorAll('[data-copy]')){const value=words[node.dataset.copy];if(value!==undefined)node.textContent=value;}
  for(const button of document.querySelectorAll('[data-language]'))button.setAttribute('aria-pressed',String(button.dataset.language===language));
  for(const button of document.querySelectorAll('[data-platform]'))button.setAttribute('aria-pressed',String(button.dataset.platform===platform));
  document.querySelector('#language-controls')?.setAttribute('aria-label',words.languageLabel);
  const platformControls=document.querySelector('#platform-controls');if(platformControls){platformControls.hidden=!desktop;platformControls.setAttribute('aria-label',words.platformLabel);}
  document.body.classList.toggle('ios',ios);document.body.classList.toggle('android',!ios);document.body.classList.toggle('desktop',desktop);
  document.querySelector('#download-app').hidden=ios;
  document.querySelector('#download-meta').hidden=ios;
  document.querySelector('#android-guide').hidden=ios;
  document.querySelector('#ios-guide').hidden=!ios;
  const browserLink=document.querySelector('#browser-chat');browserLink.href=customerAppUrl;browserLink.hidden=!ios;
  const note=document.querySelector('#device-note');if(note){note.hidden=!(ios&&otherIosBrowser);note.textContent=words.iosOtherBrowser;}
  const status=document.querySelector('#download-status');status.hidden=!requested||ios;status.textContent=words.requested;
}
for(const button of document.querySelectorAll('[data-language]'))button.addEventListener('click',()=>{language=button.dataset.language;try{localStorage.setItem('rekha:install-language',language);}catch{}render();});
for(const button of document.querySelectorAll('[data-platform]'))button.addEventListener('click',()=>{platform=button.dataset.platform;requested=false;render();});
document.querySelector('#download-app').addEventListener('click',()=>{requested=true;render();});
render();document.querySelector('#language-controls').hidden=false;
