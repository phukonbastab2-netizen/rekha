import fs from 'node:fs';import path from 'node:path';import {spawnSync}from'node:child_process';import {fileURLToPath}from'node:url';import {apps}from'../apps/catalog.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const key of ['JAVA_HOME','ANDROID_HOME','GRADLE_BIN','SIGNING_DIR'])if(!process.env[key])throw Error(`Set ${key} first. See docs/ANDROID.md.`);
const sdk=process.env.ANDROID_HOME,jdk=process.env.JAVA_HOME,signing=process.env.SIGNING_DIR;
const ks=path.join(signing,'global-preview.jks'),pass=path.join(signing,'keystore-password.txt');if(!fs.existsSync(ks)||!fs.existsSync(pass))throw Error('Signing key is required. Never replace an existing update key.');
const run=(command,args)=>{const r=spawnSync(command,args,{cwd:root,stdio:'inherit',env:process.env,shell:process.platform==='win32'&&command.endsWith('.bat')});if(r.status!==0)throw Error(`Build step failed: ${path.basename(command)}`);};
fs.writeFileSync(path.join(root,'android/local.properties'),'sdk.dir='+sdk.replaceAll('\\','/')+'\n');
for(const c of apps){const dir=path.join(root,'android/flavors',c.id,'res/drawable');fs.mkdirSync(dir,{recursive:true});const icon=fs.readFileSync(path.join(root,'android/res/drawable/app_icon.xml'),'utf8').replace('#40565B',c.color).replace('#E5C78C',c.accent);fs.writeFileSync(path.join(dir,'app_icon.xml'),icon);}
run(process.env.GRADLE_BIN,['-p','android','--no-daemon','--console','plain','assembleRelease']);
fs.mkdirSync(path.join(root,'dist/apks'),{recursive:true});
const builds=[...apps.map(c=>({id:c.id,flavor:c.id.replaceAll('-','')})),{id:'rekha-global-admin',flavor:'owner'}];
for(const c of builds){const unsigned=path.join(root,'android/build/outputs/apk',c.flavor,'release',`RekhaGlobal-${c.flavor}-release-unsigned.apk`);const out=path.join(root,'dist/apks',c.id+'.apk');run(path.join(jdk,'bin',process.platform==='win32'?'java.exe':'java'),['-jar',path.join(sdk,'build-tools/35.0.0/lib/apksigner.jar'),'sign','--ks',ks,'--ks-key-alias','global-preview','--ks-pass','file:'+pass,'--out',out,unsigned]);run(path.join(jdk,'bin',process.platform==='win32'?'java.exe':'java'),['-jar',path.join(sdk,'build-tools/35.0.0/lib/apksigner.jar'),'verify','--verbose',out]);}
console.log(`Signed and verified ${apps.length} customer Android APKs and one admin APK.`);
