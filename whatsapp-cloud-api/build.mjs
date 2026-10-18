import fs from 'node:fs';
const root=new URL('./',import.meta.url);
const copy=JSON.parse(fs.readFileSync(new URL('funnel-copy.json',root),'utf8'));
const payment=JSON.parse(fs.readFileSync(new URL('payment-config.json',root),'utf8'));
let source=fs.readFileSync(new URL('funnel.mjs',root),'utf8');
source=source.replace(/^const copy = .*;$/m,`const copy = ${JSON.stringify(copy)};`)
  .replace(/^const payment = .*;$/m,`const payment = ${JSON.stringify(payment)};`);
fs.writeFileSync(new URL('funnel.mjs',root),source);
fs.writeFileSync(new URL('qr-data.mjs',root),`// Encoded from the unchanged owner-supplied QR image. Regenerate with build.mjs.\nexport default ${JSON.stringify(fs.readFileSync(new URL('assets/qr-shahrukh-20261018.png',root)).toString('base64'))};\n`);
console.log('Built the separate funnel content and QR asset.');
