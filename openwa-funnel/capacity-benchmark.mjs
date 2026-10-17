// Offline synthetic data only. Never connects to WhatsApp or production storage.
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {Engine} from './engine.mjs';
const count=Number(process.argv[2]||1000000),output=path.resolve(process.argv[3]||'.local/capacity-benchmark');
if(!Number.isSafeInteger(count)||count<1000||count>1000000)throw Error('Choose 1,000–1,000,000 synthetic customers');
fs.mkdirSync(output,{recursive:true});
const dbFile=path.join(output,'synthetic.sqlite'),reuse=process.argv[4]==='--reuse-synthetic';
if(fs.existsSync(dbFile)&&(!reuse||!JSON.parse(fs.readFileSync(path.join(output,'report.json'),'utf8')).syntheticOnly))throw Error('Use a new output folder; refusing to replace a database');
const engine=new Engine(dbFile),db=engine.db,start=performance.now();
db.exec('PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768;');
for(let offset=0;!reuse&&offset<count;offset+=10000){
  const end=Math.min(count,offset+10000);
  engine.transaction(()=>{
    db.prepare(`WITH RECURSIVE n(i) AS(SELECT ? UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO records SELECT 'contact:'||(800000000000+i)||'@c.us','contact',(800000000000+i)||'@c.us',1000000+i,
      json_object('key','contact:'||(800000000000+i)||'@c.us','kind','contact','peer',(800000000000+i)||'@c.us','name','Synthetic customer '||i,'firstStarted',json('true'),'stage','waiting_for_details','lastSentAt',0,'unread',1,'paused',json(CASE WHEN i%2=0 THEN 'true' ELSE 'false' END),'optedOut',json('false'),'preview','Synthetic capacity test only') FROM n`).run(offset,end-1);
    db.prepare(`WITH RECURSIVE n(i) AS(SELECT ? UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO records SELECT 'in:synthetic-'||i,'message',(800000000000+i)||'@c.us',1000000+i,
      json_object('key','in:synthetic-'||i,'kind','message','peer',(800000000000+i)||'@c.us','body','Synthetic history. No real customer data.','direction','in','type','text','at',1000000+i,'status','received') FROM n`).run(offset,end-1);
    db.prepare(`WITH RECURSIVE n(i) AS(SELECT ? UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO records SELECT 'job:'||(800000000000+i)||'@c.us:reminder:0','job',(800000000000+i)||'@c.us',1000000+i,
      json_object('key','job:'||(800000000000+i)||'@c.us:reminder:0','kind','job','peer',(800000000000+i)||'@c.us','phase','reminder','step',0,'dueAt',1000000+i,'state','queued','payload',json_object('type','text','body','Synthetic queued reminder')) FROM n`).run(offset,end-1);
    db.prepare(`WITH RECURSIVE n(i) AS(SELECT ? UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO due_jobs(key,peer,due_at,state,phase,step) SELECT 'job:'||(800000000000+i)||'@c.us:reminder:0',(800000000000+i)||'@c.us',1000000+i,'queued','reminder',0 FROM n`).run(offset,end-1);
    db.prepare(`WITH RECURSIVE n(i) AS(SELECT ? UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO dispatch_heads SELECT (800000000000+i)||'@c.us','auto','job:'||(800000000000+i)||'@c.us:reminder:0',1000000+i FROM n WHERE i%2=1`).run(offset,end-1);
  });
  if(end%100000===0)console.log(JSON.stringify({seeded:end,seconds:Math.round((performance.now()-start)/1000)}));
}
const seededMs=performance.now()-start;
engine.enable(true);
const measure=(fn,runs=100)=>{const ms=[];for(let i=0;i<runs;i++){const t=performance.now();fn(i);ms.push(performance.now()-t);}ms.sort((a,b)=>a-b);return{p50Ms:ms[Math.floor(ms.length*.5)],p95Ms:ms[Math.floor(ms.length*.95)],maxMs:ms.at(-1),runs};};
const stats=measure(()=>engine.stats());
const contacts=measure(()=>engine.list('contact'));
const oldestCursor=Buffer.from(JSON.stringify({stamp:1000000+Math.floor(count*.1),key:'\uffff'})).toString('base64url');
const deepPage=measure(()=>engine.list('contact','',oldestCursor));
const dispatch=measure(()=>{const j=engine.reserve();if(!j)throw Error('Expected synthetic queued job');engine.finish(j.key,'synthetic-'+j.key);},50);
engine.enable(false);
const runId=Date.now();
const newInbound=measure(i=>engine.inbound({peer:'990000000001@c.us',id:'synthetic-new-'+runId+'-'+i,body:'Synthetic incoming message'}));
const contact=engine.list('contact')[0];
const oneChat=measure(()=>engine.list('message',contact.peer));
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
const report={syntheticOnly:true,reusedDataset:reuse,customers:count,historyMessages:count,queuedJobsSeeded:count,seededMs,queries:{stats,contacts,deepPage,dispatch,newInbound,oneChat},databaseBytes:fs.statSync(dbFile).size,processRssBytes:process.memoryUsage().rss,limits:'Storage/query test on this development PC only; no WhatsApp throughput, Cloudflare quota, server hardware, delivery, attachments or million-per-day validation.'};
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));engine.close();console.log(JSON.stringify(report));
