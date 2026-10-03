export function createInboxPages({limit=80}={}){
  let generation=0,query='',filter='all',items=[],loadedMore=false,nextCursor=null,hasMore=false;
  function reset(q='',f='all'){generation++;query=q.trim().slice(0,100);filter=f;items=[];loadedMore=false;nextCursor=null;hasMore=false;}
  function request({more=false}={}){const params=new URLSearchParams({limit:String(limit),q:query,filter});if(more&&nextCursor)params.set('cursor',nextCursor);return{generation,more,route:'/api/admin/conversations?'+params};}
  function accept(data,request){
    if(request.generation!==generation)return false;
    const page=Array.isArray(data)?{items:data,hasMore:false,nextCursor:null}:data;if(!Array.isArray(page?.items))throw new Error('The customer list could not be read.');
    const byId=new Map(items.map(item=>[item.id,item]));for(const item of page.items){
      const previous=byId.get(item.id);let merged=previous&&Number(item.version)<Number(previous.version)?{...previous}:item;
      // Inbox settings use an independent revision: a late core snapshot may
      // still carry a fresh pin/label change, and vice versa.
      if(previous){const settings=Number(item.inboxRevision)<Number(previous.inboxRevision)?previous:item;merged={...merged};for(const key of ['inboxRevision','pinned','archived','blocked','labels','notes'])if(key in settings)merged[key]=settings[key];}
      byId.set(item.id,merged);
    }
    if(request.more){loadedMore=true;items=[...byId.values()];nextCursor=page.nextCursor||null;hasMore=!!page.hasMore;}
    else{
      items=page.hasMore&&loadedMore?[...byId.values()]:page.items.map(item=>byId.get(item.id));
      // Refreshing the first page must not rewind the cursor after Load more.
      // A previously loaded first-page row may simply have moved below it;
      // absence is not evidence of deletion or a filter change.
      if(!loadedMore||!page.hasMore){nextCursor=page.nextCursor||null;hasMore=!!page.hasMore;}if(!page.hasMore)loadedMore=false;
    }
    return true;
  }
  return{reset,request,accept,remove(id){items=items.filter(item=>item.id!==id);},state:()=>({generation,query,filter,items,nextCursor,hasMore})};
}
