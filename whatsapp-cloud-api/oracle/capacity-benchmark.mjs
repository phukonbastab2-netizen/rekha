import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {performance} from 'node:perf_hooks';import {RichInbox} from './rich-inbox.mjs';
// Isolated synthetic records. No API token, webhook or real recipient is used.
const count=Number(process.env.BENCH_CONTACTS||10000),per=10;
if(count<1000||count>100000)throw Error('benchmark_bound');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-capacity-')),file=path.join(dir,'bench.sqlite');
const inbox=new RichInbox(file,{SQLITE_PATH:file,WA_PHONE_NUMBER_ID:'1418201524705343'});
const db=inbox.db,start=performance.now(),now=Date.now();
db.exec('BEGIN IMMEDIATE');
const contact=db.prepare('INSERT INTO contacts(id,wa_id,last_at,data) VALUES(?,?,?,?)'),message=db.prepare('INSERT INTO messages(id,contact,at,direction,payload,provider_id) VALUES(?,?,?,?,?,?)');
const compact=JSON.stringify({lastInboundAt:now,firstReplies:5,pending:0,optedOut:false,restricted:false});
for(let n=0;n<10;n++)db.prepare('INSERT INTO templates VALUES(?,?)').run(String(n),JSON.stringify({type:'text',text:'Shared original funnel paragraph '.repeat(15)}));
for(let i=0;i<count;i++){const id=i.toString(16).padStart(64,'0');contact.run(id,'919'+String(i).padStart(9,'0'),now-i,compact);for(let n=0;n<per;n++){const provider='wamid.'+String(i*per+n).padStart(95,'0');message.run('auto:'+id+':first:'+n,id,now-i*100-n,'out',JSON.stringify({template:String(n),source:'funnel',delivery:'read',providerId:provider}),provider);}}
db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
const timings=[];for(let i=0;i<100;i++){const t=performance.now();const first=inbox.chatPage();inbox.chatPage({after:first.next});inbox.messagePage(i.toString(16).padStart(64,'0'));timings.push(performance.now()-t);}
timings.sort((a,b)=>a-b);const bytes=fs.statSync(file).size;
const report={synthetic:true,contacts:count,messages:count*per,buildSeconds:(performance.now()-start)/1000,sqliteBytes:bytes,bytesPerCustomerWithTenMessages:bytes/count,
 projectedTenMillionGiB:bytes/count*10000000/1024**3,queryP50ms:timings[50],queryP95ms:timings[95],queryP99ms:timings[99],
 contactQueryPlan:db.prepare("EXPLAIN QUERY PLAN SELECT id FROM contacts WHERE archived=0 ORDER BY pinned DESC,last_at DESC,id DESC LIMIT 50").all().map(x=>x.detail),
 tenMillionLoadTestPassed:false};
console.log(JSON.stringify(report,null,2));inbox.close();fs.rmSync(dir,{recursive:true,force:true});
