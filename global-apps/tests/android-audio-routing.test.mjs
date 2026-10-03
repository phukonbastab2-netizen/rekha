import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'android/src/in/rekha/global/MainActivity.java'),'utf8');
// Native verification requires JDK 17 (JAVA_HOME) and Android SDK 36 (ANDROID_HOME).
const jdk=process.env.JAVA_HOME,sdk=process.env.ANDROID_HOME;
const executable=name=>path.join(jdk||'','bin',name+(process.platform==='win32'?'.exe':''));
let temporary;
const java=String.raw`
import java.util.UUID;
public final class RoutingHarness {
  __CORE__
  static final String ORIGIN="https://rekha-luna-harbor.phukonbastab2.workers.dev";
  static final String CALL="12345678-1234-1234-1234-123456789abc",OTHER="abcdefab-1234-1234-1234-123456789abc";
  static final class Fake implements AudioPort {
    int mode=0,focusRequests=0,focusAbandons=0,selections=0,clears=0,legacySets=0;
    boolean modern=true,speaker=false,grantsFocus=true,hasSpeaker=true,throwsMode=false,throwsLegacy=false,throwsClear=false;
    public int mode(){return mode;} public void mode(int value){mode=value;if(throwsMode&&value==3)throw new IllegalStateException();}
    public boolean speaker(){return speaker;} public boolean modern(){return modern;}
    public void legacySpeaker(boolean enabled){legacySets++;speaker=enabled;if(throwsLegacy)throw new IllegalStateException();}
    public boolean selectSpeaker(){selections++;if(!hasSpeaker)return false;speaker=true;return true;}
    public void clearSelection(){clears++;speaker=false;if(throwsClear)throw new IllegalStateException();}
    public boolean requestFocus(){focusRequests++;return grantsFocus;} public void abandonFocus(){focusAbandons++;}
  }
  static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
  static AudioReply call(RoutingSession session,String command,Boolean value){return session.request(ORIGIN,ORIGIN,command,session.nonce(),CALL,value,true,true);}
  public static void main(String[] args) {
    Fake audio=new Fake();RoutingSession session=new RoutingSession(audio);session.newPage(ORIGIN);
    switch(args[0]) {
      case "identity": {
        check(!session.request("https://foreign.example",ORIGIN,"capabilities",null,null,null,true,true).ok,"foreign frame got capability");
        check(!session.request(ORIGIN,"https://rekha-willow-moon.phukonbastab2.workers.dev","onCallState",session.nonce(),CALL,true,true,true).ok,"stale page affected routing");
        check(!session.request(ORIGIN,ORIGIN,"onCallState","wrong",CALL,true,true,true).ok,"invalid nonce started audio");
        check(!session.request(ORIGIN,ORIGIN,"onCallState",session.nonce(),"not-a-uuid",true,true,true).ok,"invalid call identity started audio");
        check(!call(session,"setSpeakerphone",true).ok&&audio.focusRequests==0,"inactive call selected speaker");
        String old=session.nonce();check(call(session,"onCallState",true).ok,"valid call did not start");
        check(!session.request(ORIGIN,ORIGIN,"onCallState",old,OTHER,false,true,true).ok&&session.active(),"stale hangup ended current call");
        session.newPage(ORIGIN);check(!old.equals(session.nonce())&&!session.active(),"navigation retained nonce or call");
        check(!session.request(ORIGIN,ORIGIN,"onCallState",old,CALL,true,true,true).ok,"cached nonce survived navigation");
        check(audio.mode==0&&audio.focusAbandons==1,"navigation did not restore audio");break;
      }
      case "modern": {
        check(call(session,"onCallState",true).ok&&audio.mode==3,"call did not enter communication mode");
        check(audio.selections==0&&audio.clears==0,"begin forced a route");
        check(call(session,"setSpeakerphone",true).speaker&&audio.selections==1,"speaker was not selected");
        check(call(session,"setSpeakerphone",false).ok&&!audio.speaker&&audio.clears==1,"Phone audio did not clear selection");
        check(call(session,"setSpeakerphone",true).ok,"second speaker request failed");
        check(call(session,"onCallState",false).ok&&audio.clears==2&&audio.mode==0&&audio.focusAbandons==1,"end did not restore mode/route/focus");
        session.end();check(audio.clears==2&&audio.focusAbandons==1,"cleanup was not idempotent");break;
      }
      case "legacy": {
        audio.modern=false;audio.speaker=true;check(call(session,"onCallState",true).ok,"legacy begin failed");
        check(call(session,"setSpeakerphone",false).ok&&!audio.speaker,"legacy Phone audio did not select system route");
        session.end();check(audio.speaker&&audio.mode==0&&audio.focusAbandons==1,"legacy route was not restored");break;
      }
      case "focus": {
        audio.grantsFocus=false;check(!call(session,"onCallState",true).ok&&!session.active(),"failed focus was reported active");
        check(audio.mode==0&&audio.focusAbandons==1&&audio.selections==0,"failed focus mutated routing");
        audio.grantsFocus=true;check(call(session,"onCallState",true).ok,"focus retry failed");session.end();
        check(audio.mode==0&&audio.focusAbandons==2&&!session.active(),"focus interruption cleanup failed");break;
      }
      case "unsupported": {
        audio.hasSpeaker=false;check(call(session,"onCallState",true).ok,"begin failed");
        AudioReply result=call(session,"setSpeakerphone",true);check(!result.ok&&!result.speaker&&result.active,"unavailable speaker was reported successful");
        session.end();check(audio.clears==1&&audio.mode==0&&audio.focusAbandons==1,"failed route leaked native state");break;
      }
      case "permission": {
        check(!session.request(ORIGIN,ORIGIN,"onCallState",session.nonce(),CALL,true,false,true).ok&&audio.focusRequests==0,"begin without microphone permission touched audio");
        check(call(session,"onCallState",true).ok&&call(session,"setSpeakerphone",true).ok,"begin failed");
        check(!session.request(ORIGIN,ORIGIN,"setSpeakerphone",session.nonce(),CALL,false,false,true).ok&&!session.active(),"permission loss kept routing active");
        check(audio.clears==1&&audio.mode==0&&audio.focusAbandons==1,"permission loss did not restore state");
        check(!session.request(ORIGIN,ORIGIN,"onCallState",session.nonce(),CALL,true,true,false).ok&&!session.active(),"background activity started routing");break;
      }
      case "failure": {
        audio.throwsMode=true;check(!call(session,"onCallState",true).ok&&audio.mode==0&&audio.focusAbandons==1,"partial mode failure leaked state");
        audio.throwsMode=false;check(call(session,"onCallState",true).ok,"retry failed");call(session,"setSpeakerphone",true);audio.throwsClear=true;
        session.end();check(audio.mode==0&&audio.focusAbandons==2&&!session.active(),"route exception prevented focus/mode cleanup");break;
      }
      case "newOwner": {
        check(call(session,"onCallState",true).ok,"begin failed");call(session,"setSpeakerphone",true);audio.mode=2;session.end();
        check(audio.mode==2&&audio.clears==1&&audio.focusAbandons==1,"cleanup clobbered another app's phone mode");break;
      }
      case "busyPhone": {
        for(int mode:new int[]{2,4}) {
          audio.mode=mode;AudioReply result=call(session,"onCallState",true);
          check(!result.ok&&!result.active&&audio.mode==mode,"a phone call or screening session was overridden");
          check(audio.focusRequests==0&&audio.focusAbandons==0&&audio.selections==0&&audio.legacySets==0,"busy phone audio was modified");
        }
        audio.mode=0;check(call(session,"onCallState",true).ok&&audio.focusRequests==1,"idle-phone retry failed");
        session.end();check(audio.mode==0&&audio.focusAbandons==1,"idle-phone retry did not restore its state");break;
      }
      default:throw new AssertionError("Unknown test");
    }
    System.out.println(args[0]+" passed");
  }
}`;

before(()=>{
  assert.ok(jdk&&sdk,'Set JAVA_HOME to JDK 17 and ANDROID_HOME to an Android SDK containing platform android-36 before native verification.');
  assert.ok(fs.existsSync(executable('javac')),'JDK is required for native routing verification');
  const androidJar=path.join(sdk,'platforms/android-36/android.jar');assert.ok(fs.existsSync(androidJar),'Android SDK 36 is required for wrapper compilation');
  temporary=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-native-audio-'));
  const core=source.match(/\/\/ BEGIN TESTABLE AUDIO CORE[^\n]*\n([\s\S]*?)\/\/ END TESTABLE AUDIO CORE\./)?.[1];assert.ok(core,'native audio state machine is missing');
  fs.writeFileSync(path.join(temporary,'RoutingHarness.java'),java.replace('__CORE__',core));
  fs.writeFileSync(path.join(temporary,'BuildConfig.java'),'package in.rekha.global; public final class BuildConfig { public static final boolean IS_OWNER=false; public static final String LIVE_URL="https://rekha-luna-harbor.phukonbastab2.workers.dev/"; }');
  const result=spawnSync(executable('javac'),['-encoding','UTF-8','-cp',androidJar,'-d',path.join(temporary,'classes'),path.join(temporary,'RoutingHarness.java'),path.join(temporary,'BuildConfig.java'),path.join(root,'android/src/in/rekha/global/MainActivity.java')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
after(()=>{if(temporary&&path.dirname(temporary)===path.resolve(os.tmpdir())&&path.basename(temporary).startsWith('rekha-native-audio-'))fs.rmSync(temporary,{recursive:true,force:true});});

for(const [scenario,description]of [
  ['identity','native routing rejects foreign/current origin mismatches, invalid identity, stale nonce and stale hangup'],
  ['modern','modern speaker selection restores system route, mode and focus idempotently'],
  ['legacy','Android 26–30 speaker control restores the original legacy route'],
  ['focus','audio focus denial does not change routing and a later retry can cleanly end'],
  ['unsupported','unsupported speaker cannot be reported successful or leak native routing'],
  ['permission','microphone denial, permission loss and background state cannot retain phone routing'],
  ['failure','partial platform failures still restore mode and abandon owned focus'],
  ['newOwner','ending call releases its device request without clobbering a newer phone mode'],
  ['busyPhone','existing phone-call and call-screening modes reject routing without requesting focus, then allow idle retry']
])test(description,()=>{
  const result=spawnSync(executable('java'),['-cp',path.join(temporary,'classes'),'RoutingHarness',scenario],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('native prompt surface stays narrow and restores routing on navigation, foreground loss and destruction',()=>{
  assert.ok(!source.includes('addJavascriptInterface('),'an origin-blind frame bridge must not be exposed');
  assert.match(source,/if\(!AUDIO_BRIDGE\.equals\(message\)\) return false/);
  assert.match(source,/String source=audioOrigin\(Uri\.parse\(url\)\),current=/);
  assert.match(source,/value\.length\(\)>512/);
  assert.match(source,/result\.confirm\(audioReply\(reply\)\);return true/);
  assert.match(source,/onPageStarted[\s\S]*?callAudio\.newPage/);
  assert.match(source,/onStop\(\) \{ foreground=false;interruptCallAudio\(\)/);
  assert.match(source,/onDestroy\(\)[\s\S]*?callAudio\.end\(\)/);
  assert.match(source,/generation==focusGeneration/,'stale focus callbacks must not interrupt a newer call');
  assert.match(source,/document\.dispatchEvent\(new CustomEvent\('rekha-native-audio'/,'native interruption must reach the document listener');
  assert.match(source,/detail\.put\("callId",id\)/,'native interruption must retain exact call identity');
});
