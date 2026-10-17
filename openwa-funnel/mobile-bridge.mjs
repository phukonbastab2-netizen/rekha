import {randomBytes,createHash} from 'node:crypto';
export function createMobileBridge({engine,source,request,status,removeMedia=()=>{},now=()=>Date.now()}){
  engine.db.exec('CREATE TABLE IF NOT EXISTS owner_commands(id TEXT PRIMARY KEY,result TEXT NOT NULL,processed_at INTEGER NOT NULL,synced INTEGER NOT NULL DEFAULT 0)');
  let busy=false,closed=false,polls=0,error='',lastPoll=null;
  async function execute(c){
    const old=engine.db.prepare('SELECT result FROM owner_commands WHERE id=?').get(c.id);if(old)return JSON.parse(old.result);
    return engine.transaction(()=>{
    let result;
    try{
      if(!/^[a-zA-Z0-9-]{10,80}$/.test(c.id)||!Number.isSafeInteger(c.expires)||c.expires<now())throw Error('Command expired');
      const p=c.payload||{};
      if(c.action==='send'){engine.manual(p.peer,p.body,c.id);result={ok:true};}
      else if(c.action==='enabled'){engine.enable(p.enabled);result={ok:true};}
      else if(!engine.contact(p.peer))throw Error('Unknown customer');
      else if(c.action==='pause'){engine.pauseContact(p.peer,p.paused);result={ok:true};}
      else if(c.action==='payment'){engine.verifyPayment(p.peer,p.verified);result={ok:true};}
      else if(c.action==='seen'){engine.markSeen(p.peer);result={ok:true};}
      else if(c.action==='resolve'){
        const j=engine.get(p.key);if(j?.peer!==p.peer)throw Error('Invalid job');
        // A crash after a successful resolution must never resolve or resend it twice.
        if(j.state==='unknown')engine.resolveUnknown(p.key,p.action);
        else if(j.ownerResolution!==p.action)throw Error('Job is no longer uncertain');
        result={ok:true};
      }else if(c.action==='delete'){
        if(p.confirm!=='DELETE CHAT CONTENT')throw Error('Confirmation required');
        const deleted=engine.deleteContent(p.peer);removeMedia(deleted.media);result={ok:true,more:deleted.more};
      }else throw Error('Unsupported action');
    }catch(e){result={ok:false,error:['Unknown customer','Customer has opted out','Invalid message','Invalid job','Job is no longer uncertain','Resolve active or uncertain sends first','Confirmation required','Command expired'].includes(e.message)?e.message:'Could not complete the command'};}
    engine.db.prepare('INSERT INTO owner_commands VALUES(?,?,?,0) ON CONFLICT(id) DO NOTHING').run(c.id,JSON.stringify(result),now());return result;
    });
  }
  async function poll(){
    if(busy||closed)return;busy=true;
    try{
      const results=engine.db.prepare('SELECT id,result FROM owner_commands WHERE synced=0 ORDER BY processed_at LIMIT 20').all().map(r=>({id:r.id,result:JSON.parse(r.result)}));
      const response=await request('/bridge/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,status:status(),results,cleanup:++polls%720===0})});
      const data=await response.json();
      for(const r of results)engine.db.prepare('UPDATE owner_commands SET synced=1 WHERE id=?').run(r.id);
      for(const c of (data.commands||[]).slice(0,10))await execute(c);
      if(polls%720===0)engine.db.prepare('DELETE FROM owner_commands WHERE synced=1 AND processed_at<?').run(now()-30*86400000);
      lastPoll=now();error='';
    }catch{error='Mobile connection retrying';}finally{busy=false;}
  }
  return{poll,execute,get status(){return{lastPoll,error};},
    async issueCode(){const code=randomBytes(10).toString('hex').toUpperCase(),expires=now()+600000;await request('/bridge/pairings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,hash:createHash('sha256').update(code).digest('hex'),expires})});return{code:code.match(/.{4}/g).join('-'),expires};},
    async revoke(){await request('/bridge/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source})});},
    close(){closed=true;},get busy(){return busy;}
  };
}
