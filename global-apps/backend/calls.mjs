// Private foreground call signaling. Media travels between the two devices.
export async function callsRoutes(ctx){
  const {request,env,route,method,stmt,one,all,result,body,get,customer,owner,fail,rate}=ctx;
  const prefix=route.startsWith('/api/admin/calls')?'/api/admin/calls':route.startsWith('/api/calls')?'/api/calls':null;
  if(!prefix)return null;
  const actor=prefix.includes('/admin/')?'admin':'customer';let chat;
  if(actor==='admin')await owner();else chat=await customer();
  const callQuery='SELECT calls.*,(SELECT name FROM conversations c WHERE c.id=calls.conversation_id) AS customer_name FROM calls';
  const view=c=>({id:c.id,conversationId:c.conversation_id,caller:c.caller,type:c.type,status:c.status,created:c.created,updated:c.updated,reason:c.reason,...(actor==='admin'?{customerName:c.customer_name}:{})});
  await stmt("UPDATE calls SET status='ended',reason='expired',updated=? WHERE expires<? AND status!='ended'",Date.now(),Date.now()).run();
  await stmt("UPDATE calls SET status='ended',reason='blocked',updated=? WHERE status!='ended' AND conversation_id IN (SELECT conversation_id FROM chat_messaging WHERE blocked=1)",Date.now()).run();
  await stmt("DELETE FROM call_signals WHERE call_id IN (SELECT id FROM calls WHERE status='ended')").run();
  if(route===prefix+'/config'&&method==='GET'){
    let iceServers=[{urls:'stun:stun.l.google.com:19302'}];
    if(env.CALL_ICE_SERVERS){try{const parsed=JSON.parse(env.CALL_ICE_SERVERS);if(Array.isArray(parsed)&&parsed.length&&parsed.length<=6&&parsed.every(s=>s&&typeof s==='object'&&!Array.isArray(s)&&(typeof s.urls==='string'||Array.isArray(s.urls))&&[s.urls].flat().length<=6&&[s.urls].flat().every(u=>typeof u==='string'&&u.length<=512&&/^(stun|stuns|turn|turns):[^\s]+$/.test(u))&&(s.username==null||(typeof s.username==='string'&&s.username.length<=256))&&(s.credential==null||(typeof s.credential==='string'&&s.credential.length<=1024))))iceServers=parsed.map(s=>({urls:s.urls,...(s.username!=null?{username:s.username}:{}),...(s.credential!=null?{credential:s.credential}:{})}));}catch{}}
    return result({enabled:true,iceServers,relayConfigured:iceServers.some(s=>[s.urls].flat().some(u=>/^turns?:/.test(u))),foregroundOnly:true});
  }
  if(route===prefix&&method==='GET'){
    const list=actor==='admin'?await all(callQuery+" WHERE status!='ended' ORDER BY created DESC LIMIT 20"):await all(callQuery+" WHERE conversation_id=? AND status!='ended' ORDER BY created DESC LIMIT 5",chat.id);
    return result({calls:list.map(view)});
  }
  if(route===prefix&&method==='POST'){
    const data=await body();if(actor==='admin'){if(typeof data.conversationId!=='string'||!/^[a-f0-9-]{36}$/.test(data.conversationId))throw fail(400,'Choose a conversation.');chat=await get(data.conversationId);}
    if(!chat)throw fail(404,'Conversation not found.');
    const settings=await one('SELECT blocked FROM chat_messaging WHERE conversation_id=?',chat.id);if(settings?.blocked)throw fail(403,'Calls are unavailable for this conversation.');
    if(!['voice','video'].includes(data.type))throw fail(400,'Choose voice or video.');
    await rate('call:'+actor+':'+chat.id,3,60000);
    const id=crypto.randomUUID(),now=Date.now();
    const insert=await stmt("INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires) SELECT ?,?,?,?,'ringing',?,?,? WHERE NOT EXISTS(SELECT 1 FROM calls WHERE conversation_id=? AND status!='ended') AND NOT EXISTS(SELECT 1 FROM calls WHERE status='active') AND NOT EXISTS(SELECT 1 FROM chat_messaging WHERE conversation_id=? AND blocked=1)",id,chat.id,actor,data.type,now,now,now+60000,chat.id,chat.id).run();
    if(!insert.meta.changes)throw fail(409,'A call is already in progress.');
    return result(view(await one(callQuery+' WHERE id=?',id)),201);
  }
  const match=route.slice(prefix.length).match(/^\/([a-f0-9-]{36})(?:\/(accept|end|signals))?$/);
  if(!match)throw fail(404,'Call not found.');
  const call=await one(callQuery+' WHERE id=?',match[1]);if(!call||actor==='customer'&&call.conversation_id!==chat.id)throw fail(404,'Call not found.');
  if(!match[2]&&method==='GET')return result(view(call));
  if(match[2]==='accept'&&method==='POST'){
    if(call.caller===actor)throw fail(403,'Only the recipient can accept.');
    if((await one('SELECT blocked FROM chat_messaging WHERE conversation_id=?',call.conversation_id))?.blocked)throw fail(403,'Calls are unavailable for this conversation.');
    if(call.status!=='ringing')throw fail(409,'This call is no longer ringing.');
    const update=await stmt("UPDATE calls SET status='active',updated=?,expires=? WHERE id=? AND status='ringing' AND NOT EXISTS(SELECT 1 FROM calls WHERE status='active' AND id!=?) AND NOT EXISTS(SELECT 1 FROM chat_messaging WHERE conversation_id=? AND blocked=1)",Date.now(),Date.now()+3600000,call.id,call.id,call.conversation_id).run();
    if(!update.meta.changes)throw fail(409,'Another call is active.');
    return result(view(await one(callQuery+' WHERE id=?',call.id)));
  }
  if(match[2]==='end'&&method==='POST'){
    const data=await body(),reason=['declined','cancelled','completed','connection-failed'].includes(data.reason)?data.reason:'completed';
    await stmt("UPDATE calls SET status='ended',reason=?,updated=?,expires=? WHERE id=?",reason,Date.now(),Date.now(),call.id).run();await stmt('DELETE FROM call_signals WHERE call_id=?',call.id).run();return result({ok:true});
  }
  if(match[2]==='signals'&&method==='GET'){
    const after=Number(new URL(request.url).searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw fail(400,'Invalid cursor.');
    const signals=await all('SELECT id,kind,payload FROM call_signals WHERE call_id=? AND actor!=? AND id>? ORDER BY id LIMIT 150',call.id,actor,after);
    return result({call:view(call),signals:signals.map(s=>({...s,payload:JSON.parse(s.payload)}))});
  }
  if(match[2]==='signals'&&method==='POST'){
    if(call.status==='ended')throw fail(409,'The call has ended.');const data=await body();
    if(!['offer','answer','ice'].includes(data.kind)||!data.payload||typeof data.payload!=='object'||Array.isArray(data.payload))throw fail(400,'Invalid call signal.');
    if((data.kind==='offer'&&call.caller!==actor)||(data.kind==='answer'&&(call.caller===actor||call.status!=='active')))throw fail(403,'Invalid signaling role.');
    let payload;
    if(data.kind==='offer'||data.kind==='answer'){
      if(typeof data.payload.sdp!=='string'||!data.payload.sdp.startsWith('v=0')||data.payload.sdp.length>14000||data.payload.type!==data.kind)throw fail(400,'Invalid call description.');
      payload={type:data.kind,sdp:data.payload.sdp};
    }else{
      if(typeof data.payload.candidate!=='string'||data.payload.candidate.length>2000||(data.payload.sdpMid!=null&&(typeof data.payload.sdpMid!=='string'||data.payload.sdpMid.length>100))||(data.payload.sdpMLineIndex!=null&&(!Number.isSafeInteger(data.payload.sdpMLineIndex)||data.payload.sdpMLineIndex<0||data.payload.sdpMLineIndex>100))||(data.payload.usernameFragment!=null&&(typeof data.payload.usernameFragment!=='string'||data.payload.usernameFragment.length>256)))throw fail(400,'Invalid ICE candidate.');
      payload={candidate:data.payload.candidate,sdpMid:data.payload.sdpMid??null,sdpMLineIndex:data.payload.sdpMLineIndex??null,...(data.payload.usernameFragment!=null?{usernameFragment:data.payload.usernameFragment}:{})};
    }
    const serialized=JSON.stringify(payload);
    if(data.kind!=='ice'){const existing=await one('SELECT payload FROM call_signals WHERE call_id=? AND actor=? AND kind=?',call.id,actor,data.kind);if(existing){if(existing.payload!==serialized)throw fail(409,'The call description was already sent.');return result({ok:true});}}
    const inserted=await stmt("INSERT INTO call_signals(call_id,actor,kind,payload,created) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM calls WHERE id=? AND status!='ended' AND expires>?) AND (SELECT COUNT(*) FROM call_signals WHERE call_id=?)<250 AND (?='ice' OR NOT EXISTS(SELECT 1 FROM call_signals WHERE call_id=? AND actor=? AND kind=?))",call.id,actor,data.kind,serialized,Date.now(),call.id,Date.now(),call.id,data.kind,call.id,actor,data.kind).run();
    if(!inserted.meta.changes)throw fail(409,'The call changed or its signal limit was reached.');return result({ok:true},201);
  }
  throw fail(404,'Call endpoint not found.');
}
