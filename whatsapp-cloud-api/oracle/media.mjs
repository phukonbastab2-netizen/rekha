import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const MB=1024*1024;
const types={
 'image/jpeg':['image',5*MB], 'image/png':['image',5*MB], 'image/webp':['sticker',100*1024],
 'video/mp4':['video',16*MB], 'video/3gpp':['video',16*MB],
 'audio/aac':['audio',16*MB], 'audio/mp4':['audio',16*MB], 'audio/mpeg':['audio',16*MB], 'audio/amr':['audio',16*MB], 'audio/ogg':['audio',16*MB],
 'application/pdf':['document',100*MB], 'text/plain':['document',100*MB],
 'application/msword':['document',100*MB], 'application/vnd.ms-excel':['document',100*MB], 'application/vnd.ms-powerpoint':['document',100*MB],
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['document',100*MB],
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['document',100*MB],
 'application/vnd.openxmlformats-officedocument.presentationml.presentation':['document',100*MB],
};
const problem=message=>Object.assign(Error(message),{status:400});
export function classify(mime,size){
 const base=String(mime).split(';')[0].toLowerCase();const spec=types[base];
 if(!spec)throw problem('Use JPG, PNG, MP4, supported audio, PDF, Office or text files.');
 if(!size||size>spec[1])throw problem('This file exceeds the WhatsApp '+Math.round(spec[1]/MB)+' MB limit.');
 return {type:spec[0],mime:base,size};
}
export class OwnerMedia {
 constructor(env,fetchImpl=globalThis.fetch){this.env=env;this.fetchImpl=fetchImpl;this.urls=new Map();this.uploading=0;}
 async upload(file,{voice=false}={}){
  if(this.uploading>=2)throw Object.assign(Error('Two files are uploading. Please wait.'),{status:429});
  this.uploading++;let temp;
  try{
   let bytes=Buffer.from(await file.arrayBuffer()),mime=file.type,filename=String(file.name||'file').replace(/[\x00-\x1f/\\]/g,'_').slice(0,200);
   if(voice){
    if(bytes.length>16*MB||!['audio/webm','audio/ogg','audio/mp4'].includes(mime.split(';')[0]))throw problem('Record a shorter voice message.');
    const base=mime.split(';')[0],format=base==='audio/webm'?'matroska':base==='audio/ogg'?'ogg':'mov';
    const valid=base==='audio/webm'?bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])):base==='audio/ogg'?bytes.subarray(0,4).toString()==='OggS':bytes.subarray(4,8).toString()==='ftyp';
    if(!valid)throw problem('The recording format is not valid.');
    temp=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-voice-'));const input=path.join(temp,'input'),output=path.join(temp,'voice.ogg');fs.writeFileSync(input,bytes,{mode:0o600});
    await exec('/usr/bin/ffmpeg',['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-f',format,'-i',input,'-t','600','-vn','-ac','1','-c:a','libopus','-b:a','24000',output],{timeout:45000,maxBuffer:65536});
    bytes=fs.readFileSync(output);mime='audio/ogg; codecs=opus';filename='Voice message.ogg';
   }
   const info=classify(mime,bytes.length);const form=new FormData();form.set('messaging_product','whatsapp');form.set('type',mime);form.set('file',new Blob([bytes],{type:mime}),filename);
   const response=await this.fetchImpl('https://graph.facebook.com/'+this.env.GRAPH_VERSION+'/'+this.env.WA_PHONE_NUMBER_ID+'/media',{method:'POST',headers:{Authorization:'Bearer '+this.env.META_ACCESS_TOKEN},body:form,redirect:'error',signal:AbortSignal.timeout(90000)});
   const value=await response.json();if(!response.ok||!/^\d{1,32}$/.test(value.id||''))throw Object.assign(Error('WhatsApp could not accept this file. Check its format and try again.'),{status:502});
   return {id:randomUUID(),mediaId:value.id,...info,mime,filename,voice};
  }catch(error){if(error.status)throw error;throw Object.assign(Error('The file upload did not finish. No message was sent.'),{status:502});}
  finally{this.uploading--;if(temp)fs.rmSync(temp,{recursive:true,force:true});}
 }
 async download(mediaId,range){
  if(!/^\d{1,32}$/.test(mediaId||''))throw problem('Media is not available in this saved record.');
  let item=this.urls.get(mediaId);
  if(!item||item.until<Date.now()){
   const r=await this.fetchImpl('https://graph.facebook.com/'+this.env.GRAPH_VERSION+'/'+mediaId,{headers:{Authorization:'Bearer '+this.env.META_ACCESS_TOKEN},redirect:'error',signal:AbortSignal.timeout(20000)});
   const value=await r.json();if(!r.ok)throw Object.assign(Error('This media has expired or is not available from WhatsApp.'),{status:410});
   const url=new URL(value.url);if(url.protocol!=='https:'||url.username||url.password||!['lookaside.fbsbx.com'].includes(url.hostname)&&!url.hostname.endsWith('.fbcdn.net')&&!url.hostname.endsWith('.whatsapp.net'))throw Error('invalid_media_origin');
   if(Number(value.file_size)>100*MB)throw problem('This file is too large to preview.');
   item={url:url.href,until:Date.now()+4*60000};if(this.urls.size>=256)this.urls.delete(this.urls.keys().next().value);this.urls.set(mediaId,item);
  }
  const headers={Authorization:'Bearer '+this.env.META_ACCESS_TOKEN};if(range&&/^bytes=\d+-\d*$/.test(range))headers.Range=range;
  const r=await this.fetchImpl(item.url,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Object.assign(Error('Media download is temporarily unavailable.'),{status:502});return r;
 }
}
