import { readFileSync } from 'node:fs';
import { readFile,writeFile,mkdir,unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { ownerRoutes,mediaResponse } from '../cloudflare/owner.mjs';
export function localOwnerAdapter(db,config){
  db.exec(readFileSync(new URL('../cloudflare/migration-rewards.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../cloudflare/migration-owner.sql',import.meta.url),'utf8'));
  const mediaRoot=path.resolve(config.dataDir,'media');
  const location=key=>{if(!/^library\/[a-f0-9-]{36}$/.test(key))throw Error('Invalid object key');return path.join(mediaRoot,key.slice(8));};
  const stmt=(sql,...args)=>({run:()=>{const value=db.prepare(sql).run(...args);return{meta:{changes:Number(value.changes)}};}});
  const env={DB:{batch:async statements=>{db.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.run());db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}}},MEDIA:{
    put:async(key,bytes)=>{await mkdir(mediaRoot,{recursive:true});await writeFile(location(key),bytes,{mode:0o600});},
    get:async(key,options)=>{try{let buffer=await readFile(location(key));if(options?.range)buffer=buffer.subarray(options.range.offset,options.range.offset+options.range.length);return{body:buffer};}catch(error){if(error.code==='ENOENT')return null;throw error;}},
    delete:async key=>{try{await unlink(location(key));}catch(error){if(error.code!=='ENOENT')throw error;}},
  }};
  return async({req,res,url,readBody,...context})=>{
    const upload=url.pathname==='/api/admin/uploads'&&req.method==='POST';
    const request=new Request(url,{method:req.method,headers:req.headers,...(upload?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const ctx={...context,request,env,route:url.pathname,method:req.method,stmt,one:(sql,...args)=>db.prepare(sql).get(...args),all:(sql,...args)=>db.prepare(sql).all(...args),body:()=>readBody(req),result:(data,status=200)=>Response.json(data,{status})};
    const response=url.pathname.startsWith('/api/media/')?await mediaResponse(ctx):await ownerRoutes(ctx);
    if(!response)return false;
    for(const [key,value]of response.headers)res.setHeader(key,value);res.writeHead(response.status);
    if(response.body)for await(const chunk of response.body)res.write(chunk);
    res.end();return true;
  };
}
