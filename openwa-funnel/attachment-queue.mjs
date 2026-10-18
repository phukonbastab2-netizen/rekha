export function canAttachMedia(current,original){
 return current?.kind==='message'&&!current.sensitive&&!current.revoked&&current.peer===original.peer&&(current.editedAt||0)===(original.editedAt||0);
}
export function createAttachmentQueue({run,eligible=()=>true,concurrency=2,maxPending=250}){
 const pending=new Map(),active=new Set();let closed=false;
 function drain(){
  while(!closed&&active.size<concurrency&&pending.size){
   const [key,value]=pending.entries().next().value;pending.delete(key);
   if(!eligible(key))continue;
   active.add(key);
   void Promise.resolve().then(()=>run(value,key)).catch(()=>{}).finally(()=>{active.delete(key);drain();});
  }
 }
 return{
  get active(){return active.size;},get pending(){return pending.size;},
  offer(value,key){
   if(closed||!eligible(key)||active.has(key))return false;
   if(!pending.has(key)&&pending.size>=maxPending)return false;
   pending.set(key,value);drain();return true;
  },
  close(){closed=true;pending.clear();}
 };
}
