import copy from "./funnel-copy.json" with { type: "json" };
import payment from "./payment-config.json" with { type: "json" };
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
