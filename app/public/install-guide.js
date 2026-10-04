const customerAppUrl='https://astrorani.rekhaastrology.in/';
const copy={
  hi:{pageTitle:'Rekha Astrology — ऐप डाउनलोड करें',skip:'मुख्य सामग्री पर जाएँ',title:'Rekha से बात करें',intro:'अपने Android फोन में ऐप लगाएँ। बस 3 आसान कदम।',download:'ऐप डाउनलोड करें',meta:'Android 8 या नया · छोटा डाउनलोड · इंटरनेट ज़रूरी',guideTitle:'ऐप कैसे लगाएँ?',step1Title:'ऊपर वाला हरा बटन दबाएँ',step1Text:'डाउनलोड पूरा होने तक थोड़ा रुकें।',step2Title:'डाउनलोड हुई फ़ाइल खोलें',step2Text:'फोन में डाउनलोड का संदेश दबाएँ। फ़ाइल का नाम है:',step3Title:'दबाएँ, फिर',step3Text:'ऐप खुल जाए तो अपनी भाषा चुनें और शुरू करें।',fileHelpTitle:'फ़ाइल नहीं मिल रही?',fileHelpText:'फोन में Files या My Files खोलें → Downloads पर जाएँ → RekhaAstrology.apk दबाएँ।',permissionTitle:'फोन इंस्टॉल की अनुमति माँगे तो?',permissionText:'Settings दबाएँ → इसी ब्राउज़र के लिए Allow from this source चालू करें → वापस आएँ → Install दबाएँ। बटन का नाम आपके फोन में थोड़ा अलग हो सकता है।',permissionNote:'Play Protect चालू रखें। ऐप लगने के बाद इस ब्राउज़र की इंस्टॉल अनुमति बंद कर सकते हैं।',browserHint:'अभी डाउनलोड नहीं करना?',browser:'बिना डाउनलोड चैट खोलें →',preview:'अभी यह preview है। उत्तर नमूने हैं। ₹49 unlock का परीक्षण मुफ़्त है; कोई असली भुगतान नहीं लिया जाता।',eligibility:'18 साल या अधिक उम्र के लिए · इंटरनेट ज़रूरी',about:'हमारे बारे में',help:'ऐप की मदद',deletion:'अपना डेटा मिटाएँ',contact:'मदद / संपर्क',privacy:'गोपनीयता',terms:'नियम',disclaimer:'ज़रूरी जानकारी',refund:'रिफंड और रद्द करना',shipping:'डिलीवरी नीति',checksum:'डाउनलोड की तकनीकी जाँच',requested:'फोन में डाउनलोड का संदेश देखें। फ़ाइल तैयार होने पर उसे खोलें। डाउनलोड नहीं शुरू हुआ तो हरा बटन फिर दबाएँ।',desktop:'यह ऐप Android फोन के लिए है। फोन में यह पेज खोलें, या नीचे ब्राउज़र में चैट करें।',ios:'iPhone पर डाउनलोड की ज़रूरत नहीं। नीचे वाला बटन दबाकर चैट खोलें।',iosIntro:'अपने iPhone या iPad पर सीधे चैट करें।',iosHint:'शुरू करने के लिए यह बटन दबाएँ।',languageLabel:'पेज की भाषा'},
  en:{pageTitle:'Rekha Astrology — Download the app',skip:'Skip to main content',title:'Talk with Rekha',intro:'Get the app on your Android phone. Just 3 easy steps.',download:'Download the app',meta:'Android 8 or newer · Small download · Internet needed',guideTitle:'How to install',step1Title:'Tap the green button above',step1Text:'Wait a little for the download to finish.',step2Title:'Open the downloaded file',step2Text:"Tap your phone's download notice. Look for this name:",step3Title:'then tap',step3Text:'When the app opens, choose your language and begin.',fileHelpTitle:'Cannot find the file?',fileHelpText:'Open Files or My Files on your phone → Downloads → tap RekhaAstrology.apk.',permissionTitle:'Your phone asks for install permission?',permissionText:'Tap Settings → turn on Allow from this source for this browser → go back → tap Install. Button names may vary on your phone.',permissionNote:"Keep Play Protect on. After installing, you can turn this browser's install permission off again.",browserHint:'Prefer to skip the download?',browser:'Open chat without downloading →',preview:'This is a preview with sample replies. The ₹49 unlock is a free test; no real payment is collected.',eligibility:'For ages 18 and over · Internet needed',about:'About us',help:'App help',deletion:'Delete your data',contact:'Help / Contact',privacy:'Privacy',terms:'Terms',disclaimer:'Important information',refund:'Refunds & cancellation',shipping:'Delivery policy',checksum:'Technical download check',requested:"Check your phone's download notice. Open the file when it is ready. If the download does not start, tap the green button again.",desktop:'This app is for Android phones. Open this page on your phone, or use the browser chat below.',ios:'On iPhone, no download is needed. Tap the button below to open chat.',iosIntro:'Chat directly on your iPhone or iPad.',iosHint:'Tap this button to begin.',languageLabel:'Page language'}
};
Object.assign(copy.hi,{
  preview:'ऐप लगाना मुफ़्त है। चैट में अभी कोई भुगतान नहीं लिया जाता।',
  ios:'iPhone और iPad में Safari से ऐप का आइकन Home Screen पर जोड़ें।',
  iosIntro:'अपने iPhone या iPad की Home Screen पर Rekha का ऐप जोड़ें।',
  iosHint:'पहले Safari में ग्राहक ऐप खोलें, फिर नीचे दिए कदम पूरे करें।',
  iosOpen:'iPhone / iPad ऐप खोलें →',iosGuideTitle:'iPhone या iPad में ऐप कैसे जोड़ें?',
  iosStep1Title:'Safari में ग्राहक ऐप खोलें',iosStep1Text:'ऊपर वाला हरा बटन दबाएँ। दूसरे ऐप में पेज खुला हो तो Safari खोलकर यह पता डालें:',
  iosStep2Title:'Share दबाएँ',iosStep2Text:'ऊपर की ओर तीर वाला बटन दबाएँ। Share नहीं दिखे तो Safari का मेन्यू खोलें और Share दबाएँ। iPad में View More भी दबाना पड़ सकता है।',
  iosStep3Title:'Add to Home Screen दबाएँ',iosStep3Text:'Share की सूची में नीचे जाएँ। यह विकल्प न मिले तो Edit Actions में Add to Home Screen जोड़ें।',
  iosStep4Title:'Open as Web App चालू करें',iosStep4Text:'यह विकल्प दिखाई दे तो इसे चालू रखें। कुछ iPhone या iPad में यह विकल्प अलग से नहीं दिखता।',
  iosStep5Title:'Add दबाएँ, फिर ऐप खोलें',iosStep5Text:'नाम Rekha Astrology रखें और Add दबाएँ। अब Home Screen पर Rekha के आइकन से ऐप खोलें।',
  iosSource:'Apple की सहायता: iPhone',ipadSource:'iPad',
  iosReminder:'इन कदमों को ग्राहक ऐप खुलने के बाद करें। इस डाउनलोड पेज को Home Screen पर न जोड़ें।',
  iosStatus:'Home Screen पर जोड़ने के लिए Safari का Share बटन इस्तेमाल करें। यह पेज अपने आप इंस्टॉल नहीं कर सकता।',
  iosInstalled:'ऐप पहले से Home Screen से खुला है। चैट शुरू करने के लिए हरा बटन दबाएँ।',
  iosOtherBrowser:'Safari खोलें और नीचे वाला ग्राहक ऐप पता डालें। फिर Share से Home Screen पर जोड़ें।'
});
Object.assign(copy.en,{
  preview:'The app is free to install. No payment is collected in chat at present.',
  ios:'On iPhone and iPad, add the app to your Home Screen from Safari.',
  iosIntro:'Add Rekha to the Home Screen on your iPhone or iPad.',
  iosHint:'First open the customer app in Safari, then follow the steps below.',
  iosOpen:'Open the iPhone / iPad app →',iosGuideTitle:'Add the app on iPhone or iPad',
  iosStep1Title:'Open the customer app in Safari',iosStep1Text:'Tap the green button above. If this page is inside another app, open Safari and enter this address:',
  iosStep2Title:'Tap Share',iosStep2Text:'Use the button with an upward arrow. If it is hidden, open the Safari menu and choose Share. On iPad, you may also need View More.',
  iosStep3Title:'Choose Add to Home Screen',iosStep3Text:'Scroll through the Share options. If it is missing, use Edit Actions to add this option.',
  iosStep4Title:'Turn on Open as Web App',iosStep4Text:'Keep this option on if it appears. Some iPhone or iPad versions do not show it separately.',
  iosStep5Title:'Tap Add, then open the app',iosStep5Text:'Use the name Rekha Astrology and tap Add. Open the new Rekha icon on your Home Screen.',
  iosSource:'Apple help: iPhone',ipadSource:'iPad',
  iosReminder:'Do these steps after opening the customer app. Add the customer app, not this download page.',
  iosStatus:'Use Safari’s Share button to add the app to your Home Screen. This page cannot install it automatically.',
  iosInstalled:'This window is already open from your Home Screen. Tap the green button to start chatting.',
  iosOtherBrowser:'Open Safari and enter the customer app address below. Then use Share to add it to your Home Screen.'
});
const userAgent=navigator.userAgent||'',ios=/iPhone|iPad|iPod/i.test(userAgent)||/Macintosh/i.test(userAgent)&&navigator.maxTouchPoints>1,android=/Android/i.test(userAgent);
const standalone=navigator.standalone===true||globalThis.matchMedia?.('(display-mode: standalone)').matches===true;
const otherIosBrowser=ios&&(/CriOS|FxiOS|EdgiOS|OPiOS|GSA|FBAN|FBAV|Instagram/i.test(userAgent)||!/Safari/i.test(userAgent));
let language='hi',requested=false;
try{const saved=localStorage.getItem('rekha:install-language');if(Object.hasOwn(copy,saved))language=saved;}catch{}
function render(){
  const words=copy[language];document.documentElement.lang=language;document.title=words.pageTitle;
  for(const node of document.querySelectorAll('[data-copy]')){const key=node.dataset.copy;if(Object.hasOwn(words,key))node.textContent=words[key];}
  for(const button of document.querySelectorAll('[data-language]'))button.setAttribute('aria-pressed',String(button.dataset.language===language));
  document.querySelector('#language-controls').setAttribute('aria-label',words.languageLabel);
  const note=document.querySelector('#device-note');note.hidden=android;note.textContent=ios?(standalone?words.iosInstalled:otherIosBrowser?words.iosOtherBrowser:words.ios):words.desktop;
  document.body.classList.toggle('ios',ios);document.querySelector('#download-app').hidden=ios;document.querySelector('#download-meta').hidden=ios;document.querySelector('#android-guide').hidden=ios;
  document.querySelector('#ios-guide').hidden=!ios;
  document.querySelector('.technical').hidden=ios;
  const browserLink=document.querySelector('#browser-chat');browserLink.href=customerAppUrl;
  if(ios){document.querySelector('[data-copy="intro"]').textContent=words.iosIntro;document.querySelector('#browser-hint').textContent=words.iosHint;browserLink.textContent=words.iosOpen;}
  const status=document.querySelector('#download-status');status.hidden=!requested;status.textContent=requested?words.requested:'';
}
for(const button of document.querySelectorAll('[data-language]'))button.addEventListener('click',()=>{language=button.dataset.language;try{localStorage.setItem('rekha:install-language',language);}catch{}render();});
document.querySelector('#download-app').addEventListener('click',()=>{requested=true;render();});
render();document.querySelector('#language-controls').hidden=false;
