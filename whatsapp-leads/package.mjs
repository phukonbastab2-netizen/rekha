import fs from 'node:fs';
const inbox=fs.readFileSync(new URL('./inbox.mjs',import.meta.url),'utf8').replaceAll('export async function','async function').replaceAll('export function','function');
const worker=fs.readFileSync(new URL('./worker.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
fs.writeFileSync(new URL('./worker-bundle.mjs',import.meta.url),inbox+'\n'+worker);
console.log('WhatsApp inbox and funnel bundled.');
