import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {monitorEventLoopDelay} from 'node:perf_hooks';

async function sizeOf(directory){
  let bytes=0,files=0,partial=false;
  async function walk(dir){
    try{for await(const e of await fs.promises.opendir(dir)){
      if(files>=100000){partial=true;return;}
      const file=path.join(dir,e.name);
      if(e.isDirectory())await walk(file);
      else if(e.isFile()){try{bytes+=(await fs.promises.stat(file)).size;files++;}catch{}}
    }}catch{}
  }
  await walk(directory);return{bytes,files,partial};
}
export function createMonitor({engine,data,profile,cloudStatus}){
  const delay=monitorEventLoopDelay({resolution:20});delay.enable();
  let folders={checkedAt:null,media:{bytes:0,files:0,partial:false},profile:{bytes:0,files:0,partial:false}},scanning=false;
  async function scan(){if(scanning)return;scanning=true;try{const[media,browser]=await Promise.all([sizeOf(path.join(data,'media')),sizeOf(profile)]);folders={checkedAt:Date.now(),media,profile:browser};}finally{scanning=false;}}
  void scan();const timer=setInterval(()=>void scan(),60000);timer.unref();
  function snapshot(){
    const stat=fs.statfsSync(data),page=engine.db.prepare('PRAGMA page_count').get().page_count,pageSize=engine.db.prepare('PRAGMA page_size').get().page_size,freePages=engine.db.prepare('PRAGMA freelist_count').get().freelist_count;
    const disk={total:stat.blocks*stat.bsize,free:stat.bavail*stat.bsize};
    const counts=engine.stats(),cloud=cloudStatus();
    const dates=['manual',...(engine.settings().enabled?['auto']:[])].map(lane=>engine.db.prepare('SELECT due_at FROM dispatch_heads WHERE lane=? ORDER BY due_at,peer LIMIT 1').get(lane)?.due_at).filter(Number.isFinite);
    const oldest=dates.length?Math.min(...dates):null;
    const warnings=[];
    if(disk.free<2*1024**3)warnings.push('Server disk has less than 2 GB free. Clear old chat content or increase storage.');
    if(counts.backupPending>5000)warnings.push('Cloud backup is falling behind. Local data is still authoritative.');
    if(oldest&&Date.now()-oldest>60000)warnings.push('Some messages are waiting over one minute. This sender cannot keep up with the current queue.');
    if(counts.uncertain)warnings.push('Uncertain sends need your review before those customers can continue.');
    if(cloud.databaseBytes>8*1000**3)warnings.push('Cloud database is approaching its 10 GB limit. Sharding is needed before it fills.');
    return{checkedAt:Date.now(),counts,disk,database:{bytes:page*pageSize,reusableBytes:freePages*pageSize,walBytes:fs.existsSync(path.join(data,'funnel.sqlite-wal'))?fs.statSync(path.join(data,'funnel.sqlite-wal')).size:0},folders,
      memory:{serverUsed:os.totalmem()-os.freemem(),serverTotal:os.totalmem(),gatewayRss:process.memoryUsage().rss},load:os.loadavg(),cpuCores:os.availableParallelism(),uptime:process.uptime(),eventLoopP99Ms:Math.round(delay.percentile(99)/1e6),oldestReadyAt:oldest||null,
      cloud:{...cloud,storageScope:'Shared D1 database, not only this funnel',d1MaxBytes:10*1000**3,providerUsage:'Request/operation bills and full R2 usage are in the provider dashboard; no guessed totals.'},
      limits:{targetStoredCustomers:1000000,simultaneousSends:2,gapPerCustomerMs:5000,maxAttachmentBytes:25*1024**2,attachmentDiskReserveBytes:2*1024**3,retentionDays:90,backupBatch:50},warnings,
      capacityStatus:'One million stored customers is a storage target. WhatsApp delivery capacity is limited by the linked account and single browser; no million-per-day claim.'};
  }
  return{snapshot,scan,close(){clearInterval(timer);delay.disable();}};
}
