const copy = {"greeting":"🙏 नमस्ते।\n\nयह मेरा international phone नंबर है। \n\nमेरे पास अलग-अलग देशों से client आते हैं।\nइसलिए मैंने international phone रखा है।\n\nआप इस नंबर पर सामान्य recharge से call नहीं कर पाएंगे।\n\nमैं आपको खुद call करूंगी और आपकी समस्या को ठीक करने में पूरी help करूंगी।\n\nलेकिन उसके लिए आपको मेरे बताए गए 3 चीज़ें भेजनी होंगी।\n\nबिना 3 चीज़ें मिले मैं आपको आपकी समस्या के बारे में कुछ भी सही तरीके से नहीं बता पाऊंगी और न ही मदद कर पाऊंगी।\n\nकृपया पहले मेरी बताई गई 3 चीज़ें भेजिए। 🙏","firstCaption":"मैं आपकी ज़रूर मदद करूंगी।\n\nपहले इस वीडियो में बताई गई 3 चीज़ें मुझे भेजिए।","testimonialsCaption":"Client Reviews\n\n7000+ clients till now","qrCaption":"कृपया दिए और धूप के लिए इस QR में 29 रुपये डोनेट कीजिए।\n\nमैं आपसे कोई भी extra fees नहीं लेने वाली।","final":"आपकी 3 चीज़ें मिलते ही मैं आपको सब कुछ बताऊंगी।\n\n1. जन्म तिथि\n2. पूरा नाम\n3. 29 रुपये donation का screenshot","reminder":"कृपया वीडियो में कही गई तीनों चीज़ें भेजिए।\n\nमैं आपको सब कुछ उसके बाद बताऊंगी।\n\n1. जन्म तिथि\n2. पूरा नाम\n3. 29 रुपये donation का screenshot","kundliCaption":"आपकी कुंडली 🔱\n\nआपकी कुंडली को ध्यान से देखिए।\n\nइसमें आपके जीवन से जुड़ी महत्वपूर्ण जानकारी छिपी होती है।","solutionCaption":"आपका समाधान 🙏\n\nआपकी समस्या के अनुसार समाधान की जानकारी यहाँ दी गई है।\n\nइसे ध्यान से देखिए।","pujaCaption":"पूजा की आवश्यक सामग्री 🪔\n\nपूजा के लिए आवश्यक सामग्री की पूरी जानकारी यहाँ दी गई है।\n\nऊपर दिए गए QR code में payment कीजिए और screenshot भेजिए।"};
const payment = {"qrUrl":"https://rekha-whatsapp-cloud-api.phukonbastab2.workers.dev/assets/qr-shahrukh-20261018.png"};
// Public media only. Authentication and WhatsApp session data never belong here.
const base = 'https://pub-e67cd25c4ce94bc38f1077c04b6cfd17.r2.dev/';
const media = (type, file, body) => ({ type, url: base + file, body });
export const GAP = 5000;
export const REMINDER_DELAY = 60000;
export const MEDIA_DELAY = 3600000;
export const firstSequence = [
  {type: "text", body: copy.greeting},
  media("video", "wp%20video%201.mp4", copy.firstCaption),
  media("video", "testimonials.mp4", copy.testimonialsCaption),
  {type:"image",url:payment.qrUrl,body:copy.qrCaption},
  {type: "text", body: copy.final}
];
export const reminder = {type: "text", body: copy.reminder};
export const mediaSequence = [
  media("image", "kundli.png", copy.kundliCaption),
  media("image", "prediction.jpg", copy.solutionCaption),
  media("image", "Shanidev%20Puja%20Essentials.png", copy.pujaCaption),
  media("audio", "d84qqgeq.mp3", "")
];
