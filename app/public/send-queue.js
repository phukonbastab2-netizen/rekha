// Customer outbox. A transport timeout is not proof that a message was unsaved.
// Keep its clientId until a private server view confirms that same message.
export function mergeServerChat(previous,next){
  if(!next||!Array.isArray(next.messages)||previous&&next.id!==previous.id)return previous;
  const version=Number(next.version)||0,previousVersion=Number(previous?.version)||0,updated=Number(next.updated)||0,previousUpdated=Number(previous?.updated)||0,newest=next.messages.reduce((id,m)=>Math.max(id,Number(m.id)||0),0),previousNewest=(previous?.messages||[]).reduce((id,m)=>Math.max(id,Number(m.id)||0),0),stale=previous&&(version<previousVersion||version===previousVersion&&(updated<previousUpdated||updated===previousUpdated&&newest<previousNewest)),incoming=new Map(next.messages.map(m=>[m.id,m]));
  for(const message of previous?.messages||[]){
    const fresh=incoming.get(message.id);
    if(stale||!fresh)incoming.set(message.id,fresh?.readByOther===true&&message.readByOther!==true?{...message,readByOther:true}:message);
    // A private read cursor only advances. Its writes do not change version,
    // so an equal-version view may be older than the receipt already displayed.
    else if(message.readByOther===true&&fresh.readByOther!==true)incoming.set(message.id,{...fresh,readByOther:true});
  }
  return{...(stale?previous:next),messages:[...incoming.values()].sort((a,b)=>a.id-b.id)};
}
export function createSendQueue({send,onChange=()=>{},onAck=()=>{},onConfirmed=()=>{},onError=()=>{},online=()=>true,now=()=>Date.now()}){
  const records=new Map();let active=null,paused=false,scheduled=false;
  const changed=()=>onChange();
  function schedule(){if(scheduled||paused)return;scheduled=true;queueMicrotask(()=>{scheduled=false;void pump();});}
  function confirm(record){if(!records.has(record.clientId))return;records.delete(record.clientId);record.confirmed=true;record.controller?.abort();onConfirmed(record);changed();}
  function reconcile(view){
    if(!view||!Array.isArray(view.messages))return;
    const byClient=new Map(view.messages.filter(m=>m.role==='user'&&m.clientId).map(m=>[m.clientId,m]));
    for(const record of [...records.values()]){
      if(view.id!==record.conversationId)continue;
      if(record.snapshot.editId){const message=view.messages.find(m=>m.id===record.snapshot.editId);if(message&&!message.deleted&&message.body.trim()===record.snapshot.body.trim()&&Number(view.version)>=record.baseVersion)confirm(record);}
      else if(byClient.has(record.clientId))confirm(record);
    }
    schedule();
  }
  async function pump(){
    if(active||paused||!online())return;
    const record=[...records.values()].find(r=>r.state==='queued');if(!record)return;
    active=record;record.state='sending';record.error='';record.attempts++;record.controller=new AbortController();changed();
    try{
      const view=await send(record,{signal:record.controller.signal});
      if(!records.has(record.clientId))return;
      onAck(view,record);reconcile(view);
      if(records.has(record.clientId)){record.state='failed';record.uncertain=true;record.error='Delivery is not confirmed. Retry uses the same message.';changed();}
    }catch(error){
      if(!records.has(record.clientId))return;
      if(paused){record.state='queued';record.error='';}
      else{record.state='failed';record.uncertain=!error.status||error.status>=500;record.error=error.message||'Could not confirm delivery. Retry safely.';onError(error,record);}
      changed();
    }finally{record.controller=null;if(active===record)active=null;schedule();}
  }
  return{
    enqueue({snapshot,conversationId,baseVersion=0,created=now(),prepare,finish}){
      if(!snapshot?.clientId||!conversationId)throw new Error('A private chat and message ID are required.');
      if(records.has(snapshot.clientId))return records.get(snapshot.clientId);
      const record={snapshot,conversationId,baseVersion,created,prepare,finish,clientId:snapshot.clientId,state:'queued',error:'',uncertain:false,attempts:0};records.set(record.clientId,record);changed();schedule();return record;
    },
    list:()=>[...records.values()],
    reconcile,
    retry(clientId){const record=records.get(clientId);if(!record||record.state==='sending')return false;record.state='queued';record.error='';record.uncertain=false;changed();schedule();return true;},
    resume({retryUncertain=false}={}){paused=false;if(retryUncertain)for(const record of records.values())if(record.state==='failed'&&record.uncertain){record.state='queued';record.error='';}changed();schedule();},
    pause({abort=false}={}){paused=true;if(abort)active?.controller?.abort();},
    clear(){paused=true;for(const record of records.values()){record.controller?.abort();record.finish?.(record.snapshot);}records.clear();changed();},
    cancel(clientId){const record=records.get(clientId);if(!record||record.attempts)return false;records.delete(clientId);record.finish?.(record.snapshot);changed();return true;},
    isPending:()=>records.size>0,
  };
}
