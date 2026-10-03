import fs from 'node:fs';import path from 'node:path';import{apps}from '../apps/catalog.mjs';import{namespaceSql}from '../backend/isolation.mjs';
const root=path.resolve(import.meta.dirname,'..');
const output=path.resolve(process.env.CONNECTED_OUTPUT||path.join(root,'connected'));
const schema=fs.readFileSync(path.join(root,'live',apps[0].id,'schema.sql'),'utf8');
const tables=[...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m=>m[1]);
const indexes=[...schema.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(m=>m[1]);
const adapter=fs.readFileSync(path.join(root,'backend/isolation.mjs'),'utf8').replace(/export function/g,'function');
const namespaces=apps.map((c,i)=>({id:c.id,prefix:'g'+String(i+1).padStart(2,'0')+'_'}));
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'schema.sql'),namespaces.map(c=>namespaceSql(schema,c.prefix,[...tables,...indexes])).join('\n'));
for(const c of namespaces){
  const dir=path.join(output,c.id);fs.mkdirSync(dir,{recursive:true});
  const original=fs.readFileSync(path.join(root,'live',c.id,'worker.mjs'),'utf8').replace('export default {','const connectedWorker = {');
  const worker=adapter+'\n'+original+`\nexport default {fetch(request,env){return connectedWorker.fetch(request,scopeEnvironment(env,${JSON.stringify(c.prefix)},${JSON.stringify(tables)}));},async scheduled(controller,env){const all=["g01_","g02_","g03_","g04_","g05_","g06_","g07_","g08_","g09_","g10_","g11_","g12_"];const time=controller.scheduledTime||Date.now(),date=new Date(time),offset=(Math.floor(time/60000)%6)*2;const cleanup=date.getUTCHours()===2&&date.getUTCMinutes()>=17&&date.getUTCMinutes()<=22;for(const prefix of all.slice(offset,offset+2))await connectedWorker.scheduled({...controller,cron:cleanup?'17 2 * * *':'* * * * *'},scopeEnvironment(env,prefix,${JSON.stringify(tables)}));}};\n`;
  fs.writeFileSync(path.join(dir,'worker.mjs'),worker);
  if(process.env.DEPLOY_DB_ID&&process.env.MEDIA_BUCKET){fs.writeFileSync(path.join(dir,'wrangler.json'),JSON.stringify({name:'rekha-'+c.id,main:'worker.mjs',account_id:process.env.DEPLOY_ACCOUNT_ID,compatibility_date:'2026-09-24',workers_dev:true,preview_urls:false,d1_databases:[{binding:'DB',database_name:'rekha-global-connected',database_id:process.env.DEPLOY_DB_ID}],r2_buckets:[{binding:'MEDIA',bucket_name:process.env.MEDIA_BUCKET}],vars:{AI_MODE:'manual',AD_REWARDS_ENABLED:'false'},...(c.id===namespaces[0].id?{triggers:{crons:['* * * * *']}}:{})},null,2));}
}
fs.writeFileSync(path.join(output,'namespaces.json'),JSON.stringify(namespaces,null,2));console.log('Prepared 12 connected workers with fixed database and storage namespaces.');
