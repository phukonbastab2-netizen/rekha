import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
try{await fs.access('cloudflare/worker-bundle.mjs');}catch{execFileSync(process.execPath,['cloudflare/package-deployment.mjs'],{stdio:'inherit'});}
for(const file of ['test-messaging.mjs','test-calls.mjs','test-workflow.mjs','test-workflow-retry.mjs','test-workflow-cron.mjs','test-app-settings.mjs','editor-integration.mjs'])execFileSync(process.execPath,['tests/'+file],{stdio:'inherit',timeout:180000});
