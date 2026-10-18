// The WhatsApp message collection is a cache, not the complete local history.
// Read actual IndexedDB message identities, then let WhatsApp hydrate/decrypt
// them. Never interpret msgRowOpaqueData or manufacture text from stored bytes.
export async function readProviderJournalPage({cursor=null,limit=100,retryIds=[]}={},serialize) {
  const root=globalThis,limitNumber=Number(limit);
  const bound=Math.max(1,Math.min(100,Number.isSafeInteger(limitNumber)?limitNumber:100));
  if(typeof serialize!=='function')throw Error('Native message serializer unavailable');
  if(!root.indexedDB?.databases||!root.Store?.Msg)throw Error('Native message journal unavailable');
  const id=value=>typeof value==='string'?value:value?._serialized||'';
  const models=value=>Array.isArray(value)?value:typeof value?.getModelsArray==='function'?value.getModelsArray():Array.isArray(value?._models)?value._models:[];
  const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Native message journal read failed'));});
  const databases=(await root.indexedDB.databases()).filter(meta=>typeof meta.name==='string'&&meta.name);
  databases.sort((a,b)=>(a.name==='model-storage'?-1:b.name==='model-storage'?1:a.name.localeCompare(b.name)));
  let db;
  for(const meta of databases){
    const candidate=await new Promise((resolve,reject)=>{
      const r=root.indexedDB.open(meta.name);
      // A database may disappear after databases(). Do not create a substitute.
      r.onupgradeneeded=()=>r.transaction?.abort();
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Native message database unavailable'));
    });
    if(candidate.objectStoreNames.contains('message')){db=candidate;break;}
    candidate.close();
  }
  if(!db)throw Error('Native message table unavailable');
  try{
    const table=()=>db.transaction('message','readonly').objectStore('message');
    const schema=table(),rowIndex=[...schema.indexNames].includes('rowId')?schema.index('rowId'):null;
    const generation=JSON.stringify([db.name,db.version,schema.keyPath,rowIndex?.keyPath||null,rowIndex?.unique||false]);
    const storedRows=await request(table().count());
    let reset=!!cursor?.generation&&cursor.generation!==generation;
    let position=!reset&&typeof cursor?.position==='string'?cursor.position:null;
    if(position){
      const anchor=await request(table().get(position));
      if(!anchor||id(anchor.id)!==cursor.anchor?.id||cursor.anchor?.rowId!==undefined&&anchor.rowId!==cursor.anchor.rowId){reset=true;position=null;}
    }
    // Primary-key sweeps include every stored row, including older history
    // inserted below an existing rowId/timestamp watermark. Each completed pass
    // starts again, so unresolved decryptions and late old rows are revisited.
    const retries=[...new Set((Array.isArray(retryIds)?retryIds:[]).filter(v=>typeof v==='string'&&v&&v.length<=2048))].slice(0,Math.min(25,Math.floor(bound/4)));
    const priority=[];
    for(const key of retries){const row=await request(table().get(key));if(row)priority.push({row,primaryKey:key,priority:true});}
    const missingRetryIds=retries.filter(key=>!priority.some(item=>item.primaryKey===key));
    const pageLimit=Math.max(1,bound-priority.length);
    const range=position?root.IDBKeyRange.lowerBound(position,true):undefined;
    const page=await new Promise((resolve,reject)=>{
      const r=table().openCursor(range),out=[];
      r.onsuccess=()=>{const c=r.result;if(!c)return resolve({rows:out,complete:true});if(out.length===pageLimit)return resolve({rows:out,complete:false});out.push({row:c.value,primaryKey:c.primaryKey,priority:false});c.continue();};
      r.onerror=()=>reject(Error('Native message journal cursor failed'));
    });
    const selected=[...new Map([...priority,...page.rows].map(item=>[id(item.row.id)||String(item.primaryKey),item])).values()];
    const ignoredTypes=new Set(['e2e_notification','notification_template','notification','gp2','protocol','call_log','debug','sender_key_distribution_message','album']);
    const eligible=selected.filter(item=>!ignoredTypes.has(item.row.type));
    const ignored=selected.filter(item=>ignoredTypes.has(item.row.type)).map(item=>id(item.row.id));
    const byId=new Map(models(root.Store.Msg).map(model=>[id(model.id),model]));
    const wanted=eligible.map(item=>id(item.row.id)).filter(key=>key&&!byId.has(key));
    let hydrationError=false;
    if(wanted.length){
      if(typeof root.Store.Msg.getMessagesById!=='function')hydrationError=true;
      else try{
        let timer;
        const result=await Promise.race([
          root.Store.Msg.getMessagesById(wanted),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native message hydration timed out')),5000);})
        ]).finally(()=>clearTimeout(timer));
        for(const model of models(result?.messages||result))if(id(model.id))byId.set(id(model.id),model);
        for(const model of models(root.Store.Msg))if(id(model.id))byId.set(id(model.id),model);
      }catch{hydrationError=true;}
    }
    const messages=[],unresolved=[],resolvedIds=[];
    for(const item of eligible){
      const key=id(item.row.id),model=byId.get(key);
      if(!key||!model||(model.type==='chat'&&typeof model.body!=='string'&&typeof model.caption!=='string')){if(key)unresolved.push(key);continue;}
      try{
        const message=serialize(model);
        if(!message||id(message.id)!==key){unresolved.push(key);continue;}
        // This flag identifies an actual local record, not a received-now event.
        messages.push({...message,journal:{source:'native_indexeddb',rowId:Number.isSafeInteger(item.row.rowId)?item.row.rowId:null}});
        resolvedIds.push(key);
      }catch{unresolved.push(key);}
    }
    const last=page.rows.at(-1),cycle=Number.isSafeInteger(cursor?.cycle)&&!reset?cursor.cycle:0;
    const nextCursor={generation,position:page.complete?null:last?.primaryKey||position,anchor:page.complete?null:last?{id:id(last.row.id),...(Number.isSafeInteger(last.row.rowId)?{rowId:last.row.rowId}:{})}:cursor?.anchor||null,cycle:cycle+(page.complete?1:0)};
    const pageIds=new Set(page.rows.map(item=>id(item.row.id)));
    return{source:'native_indexeddb',storedRows,pageRows:page.rows.length,pageHydrated:resolvedIds.filter(key=>pageIds.has(key)).length,pageIgnored:ignored.filter(key=>pageIds.has(key)).length,pageUnresolved:unresolved.filter(key=>pageIds.has(key)).length,messages,resolvedIds,ignoredIds:ignored,unresolvedIds:[...new Set(unresolved)],missingRetryIds,hydrationError,complete:page.complete,reset,cursor:nextCursor};
  }finally{db.close();}
}

// Compile only trusted local function source in Node. The browser receives one
// self-contained function; it does not eval strings or import Node dependencies.
export function createProviderJournalReader(serializeNativeMessage){
  if(typeof serializeNativeMessage!=='function')throw Error('Native serializer is required');
  return Function('return async function readProviderJournal(args){const serialize=('+serializeNativeMessage.toString()+');return ('+readProviderJournalPage.toString()+')(args,serialize);}')();
}

export function createProviderJournal({engine,evaluate,onMessage,serializeNativeMessage,now=()=>Date.now(),limit=100}){
  if(!engine?.get||!engine?.put||typeof evaluate!=='function'||typeof onMessage!=='function')throw Error('Native journal dependencies unavailable');
  const reader=createProviderJournalReader(serializeNativeMessage),key='provider-journal-cursor';
  const status={running:false,checkedAt:null,storedRows:0,lastPageRows:0,lastPageHydrated:0,pendingHydration:0,completedPasses:0,lastCompleteAt:null,lastPass:null,resets:0,source:'native_indexeddb',mobileHistoryComplete:false,error:''};
  return{status,async scan(){
    if(status.running)return false;
    status.running=true;
    try{
      const saved=engine.get(key)||{},pending=Array.isArray(saved.pending)?saved.pending:[],at=now();
      const due=pending.filter(item=>item.nextAt<=at).sort((a,b)=>a.nextAt-b.nextAt).slice(0,25);
      const result=await evaluate(reader,{cursor:saved.cursor||null,limit,retryIds:due.map(item=>item.id)});
      if(!result||!result.cursor||!Array.isArray(result.messages)||!Array.isArray(result.unresolvedIds))throw Error('Native journal response unavailable');
      // Commit the cursor only after all real snapshots have been accepted by
      // the gateway. A callback failure replays the page through durable IDs.
      for(const message of result.messages)await onMessage(message,{source:'native_indexeddb',historical:true});
      const resolved=new Set([...(result.resolvedIds||[]),...(result.ignoredIds||[]),...(result.missingRetryIds||[])]);
      const pendingMap=new Map(pending.filter(item=>!resolved.has(item.id)).map(item=>[item.id,item]));
      for(const id of result.unresolvedIds){
        const previous=pendingMap.get(id),attempts=Math.min(20,(previous?.attempts||0)+1);
        pendingMap.set(id,{id,attempts,nextAt:at+Math.min(300000,5000*2**Math.min(6,attempts-1))});
      }
      // Overflow is still revisited by unconditional full sweeps. Bound the
      // priority retry record so a corrupt provider cannot grow it indefinitely.
      const nextPending=[];let pendingBytes=2;
      for(const item of [...pendingMap.values()].sort((a,b)=>a.nextAt-b.nextAt)){
        if(typeof item.id!=='string'||!item.id||item.id.length>2048)continue;
        const next={id:item.id,attempts:Math.max(1,Math.min(20,Number(item.attempts)||1)),nextAt:Number.isFinite(item.nextAt)?item.nextAt:at};
        const bytes=Buffer.byteLength(JSON.stringify(next),'utf8')+(nextPending.length?1:0);
        // Cloud backups cap individual record JSON at 30,000 characters. Keep
        // retry entries below 20 KB, leaving room for cursor/pass metadata.
        if(pendingBytes+bytes>20000)continue;
        nextPending.push(next);pendingBytes+=bytes;
        if(nextPending.length===100)break;
      }
      const pass=result.reset?{scanned:0,hydrated:0,ignored:0,unresolved:0}:saved.pass||{scanned:0,hydrated:0,ignored:0,unresolved:0};
      const progress={scanned:pass.scanned+result.pageRows,hydrated:pass.hydrated+result.pageHydrated,ignored:pass.ignored+result.pageIgnored,unresolved:pass.unresolved+result.pageUnresolved};
      const lastPass=result.complete?{...progress,storedRows:result.storedRows,at,localRowsCovered:progress.scanned>=result.storedRows&&progress.unresolved===0}:saved.lastPass||null;
      const record={key,kind:'settings',cursor:result.cursor,pending:nextPending,pass:result.complete?{scanned:0,hydrated:0,ignored:0,unresolved:0}:progress,lastPass,lastCompleteAt:result.complete?at:saved.lastCompleteAt||null,completedPasses:(saved.completedPasses||0)+(result.complete?1:0),resets:(saved.resets||0)+(result.reset?1:0)};
      engine.put(record);
      Object.assign(status,{checkedAt:at,storedRows:result.storedRows,lastPageRows:result.pageRows,lastPageHydrated:result.pageHydrated,pendingHydration:nextPending.length,completedPasses:record.completedPasses,lastCompleteAt:record.lastCompleteAt,lastPass,resets:record.resets,error:result.hydrationError||result.unresolvedIds.length?'Some stored WhatsApp messages are waiting to be decoded.':''});
      return true;
    }catch{status.error='Stored WhatsApp message sync failed; retrying without advancing.';return false;}
    finally{status.running=false;}
  }};
}
