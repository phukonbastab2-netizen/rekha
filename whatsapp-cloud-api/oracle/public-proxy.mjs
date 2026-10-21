// A separate route only; never handles the existing website or WhatsApp webhook.
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.hostname!=='rekhaastrology.in'||!/^\/manual-inbox(?:\/|$)/.test(url.pathname))return new Response('Not found',{status:404});
 if(url.protocol!=='https:')return Response.redirect('https://rekhaastrology.in'+url.pathname+url.search,308);
 if(url.pathname==='/manual-inbox')return Response.redirect('https://rekhaastrology.in/manual-inbox/',308);
 if(!/^https:\/\/inbox-origin\.rekhaastrology\.in$/.test(env.ORACLE_INBOX_ORIGIN||''))return new Response('Inbox connection is being prepared.',{status:503});
 if(!['GET','POST','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
 const target=new URL(url.pathname+url.search,env.ORACLE_INBOX_ORIGIN),headers=new Headers(request.headers);
 headers.delete('host');headers.delete('x-forwarded-host');headers.delete('x-forwarded-proto');
 try{const response=await fetch(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'});
  const result=new Response(response.body,response);result.headers.set('x-robots-tag','noindex, nofollow');result.headers.set('referrer-policy','no-referrer');result.headers.set('cache-control','no-store');return result;
 }catch{return new Response('Inbox temporarily unavailable. Please try again.',{status:503,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});}
}};
