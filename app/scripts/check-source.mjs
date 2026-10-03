import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const directories=['public','cloudflare','src','tests','scripts'];let checked=0;
for(const directory of directories){for(const name of await fs.readdir(directory)){if(!/\.(?:js|mjs)$/.test(name)||name==='worker-bundle.mjs')continue;execFileSync(process.execPath,['--check',path.join(directory,name)],{stdio:'inherit'});checked++;}}
console.log(`Syntax checked ${checked} source and test modules.`);
