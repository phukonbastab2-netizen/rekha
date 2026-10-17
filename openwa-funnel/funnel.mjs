// Public media only. Authentication and WhatsApp session data never belong here.
const base = 'https://pub-e67cd25c4ce94bc38f1077c04b6cfd17.r2.dev/';
const media = (type, file, body) => ({ type, url: base + file, body });
export const GAP = 5000;
export const REMINDER_DELAY = 60000;
export const MEDIA_DELAY = 3600000;
export const firstSequence = [
  { type: 'text', body: '🙏 नमस्ते। Rekha Astrology में आपका स्वागत है।\n\nकृपया वीडियो में बताई गई जानकारी भेजिए। जवाब हमारी टीम की उपलब्धता के अनुसार मिलेंगे।\n\nयह ज्योतिषीय मार्गदर्शन है; किसी परिणाम की गारंटी नहीं है। संदेश बंद करने के लिए STOP लिखें।' },
  media('video', 'wp%20video%201.mp4', 'पहले इस वीडियो में बताई गई 3 चीज़ें मुझे भेजिए।'),
  media('video', 'testimonials.mp4', 'Client Reviews — व्यक्तिगत अनुभव; सभी के परिणाम अलग हो सकते हैं।'),
  media('image', 'qr.jpg', 'कृपया दिए और धूप के लिए इस QR में ₹29 डोनेट कीजिए। भुगतान से पहले प्राप्तकर्ता और राशि जाँचें।\n\nस्क्रीनशॉट मिलने के बाद भुगतान की पुष्टि हमारी टीम करेगी।'),
  { type: 'text', body: 'कृपया ये 3 चीज़ें भेजिए:\n\n1. जन्म तिथि\n2. पूरा नाम\n3. ₹29 donation का screenshot\n\nकृपया OTP, PIN या कार्ड की जानकारी न भेजें।' }
];
export const reminder = { type: 'text', body: 'कृपया वीडियो में कही गई तीनों चीज़ें भेजिए।\n\n1. जन्म तिथि\n2. पूरा नाम\n3. ₹29 donation का screenshot\n\nभुगतान हमारी टीम की पुष्टि के बाद ही verified माना जाएगा।' };
export const mediaSequence = [
  media('image', 'kundli.png', 'कुंडली का संदर्भ चित्र 🔱\n\nयह साझा उदाहरण है, आपकी जन्म जानकारी से व्यक्तिगत रूप से गणना की गई कुंडली नहीं।'),
  media('image', 'prediction.jpg', 'ज्योतिषीय संदर्भ जानकारी 🙏\n\nयह सामान्य मार्गदर्शन है; व्यक्तिगत निष्कर्ष या परिणाम की गारंटी नहीं।'),
  media('image', 'Shanidev%20Puja%20Essentials.png', 'पूजा सामग्री का संदर्भ 🪔\n\nइस पुराने चित्र में दिखाई गई सामग्री या राशि ₹29 donation में शामिल नहीं है। कोई अतिरिक्त भुगतान करने से पहले टीम से पुष्टि करें।'),
  media('audio', 'd84qqgeq.mp3', 'साझा voice recording — सामान्य ज्योतिषीय संदर्भ; व्यक्तिगत भविष्यवाणी नहीं।')
];
