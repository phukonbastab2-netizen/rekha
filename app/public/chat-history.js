import {mergeServerChat} from './send-queue.js';
export const historyHeaders={'X-Rekha-History':'bounded-v1'};
export function applyReceiptCursors(messages,cursors){return messages.map(message=>['user','assistant'].includes(message.role)&&!message.readByOther&&Number(message.id)<=Number(cursors?.[message.role==='user'?'ownerRead':'customerRead'])?{...message,readByOther:true}:message);}
// A mutation acknowledgement is not a delta cursor: advancing it could skip a
// concurrent edit/reaction on an older loaded page. Only fetched deltas advance.
export function createChatHistory(){
  let id=null,revision=null,oldestId=null,hasOlder=false;
  const validRevision=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0;
  function reset(view=null){id=view?.id||null;revision=validRevision(view?.changeRevision)?Number(view.changeRevision):null;oldestId=view?.page?.oldestId??null;hasOlder=!!view?.page?.hasOlder;}
  function route(base,{older=false}={}){const query=new URLSearchParams();if(older&&oldestId)query.set('beforeId',oldestId);else if(revision!==null)query.set('afterRevision',revision);return base+(query.size?'?'+query:'');}
  function accept(previous,next,{kind='mutation'}={}){
    if(!next||!Array.isArray(next.messages)||previous&&previous.id!==next.id)return previous;
    if(id!==next.id)reset();id=next.id;
    const messages=next.acknowledgedMessage&&!next.messages.some(m=>m.id===next.acknowledgedMessage.id)?[...next.messages,next.acknowledgedMessage]:next.messages;
    // Older pages supply rows only. Their metadata was captured at request time
    // and must not rewind a newer live reply, entitlement or mode.
    let result;
    if(kind==='older'&&previous){const byId=new Map(previous.messages.map(m=>[m.id,m]));for(const message of messages)if(!byId.has(message.id))byId.set(message.id,message);result={...previous,messages:[...byId.values()].sort((a,b)=>a.id-b.id)};}
    else result=mergeServerChat(previous,{...next,messages});
    if(next.receiptCursors)result={...result,messages:applyReceiptCursors(result.messages,next.receiptCursors)};
    if(kind==='initial'||kind==='delta'){
      if(validRevision(next.changeRevision))revision=Math.max(revision??0,Number(next.changeRevision));
      if(next.page&&(oldestId===null||kind==='initial')){oldestId=next.page.oldestId??null;hasOlder=!!next.page.hasOlder;}
    }else if(kind==='older'&&next.page){oldestId=next.page.oldestId??oldestId;hasOlder=!!next.page.hasOlder;}
    return result;
  }
  return{reset,route,accept,state:()=>({id,revision,oldestId,hasOlder})};
}
// Preserve the visible message while a page is prepended, including when a
// retained image/video changes the thread height during layout.
export function captureThreadAnchor(scroller){
  const top=scroller.getBoundingClientRect().top,anchor=[...scroller.querySelectorAll('[data-message]')].find(node=>node.getBoundingClientRect().bottom>top);
  return{node:anchor,offset:anchor?anchor.getBoundingClientRect().top-top:0,height:scroller.scrollHeight,scroll:scroller.scrollTop};
}
export function restoreThreadAnchor(scroller,anchor){if(anchor?.node?.isConnected)scroller.scrollTop+=anchor.node.getBoundingClientRect().top-scroller.getBoundingClientRect().top-anchor.offset;else if(anchor)scroller.scrollTop=anchor.scroll+scroller.scrollHeight-anchor.height;}
