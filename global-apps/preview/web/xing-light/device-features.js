import {createVoiceEffect,voiceChoices} from './voice-effects.js';
// Feature access stays optional and is initiated by the person using the device.
export function mountDeviceFeatures(container,notify,owner=false){
  const button=document.createElement('button');button.className='secondary';button.textContent='Voice & media setup';button.type='button';container.append(button);
  button.onclick=()=>{
    const dialog=document.createElement('dialog');dialog.innerHTML='<h2>Voice & media</h2><p>Choose the features you want to use. Your phone asks separately for microphone and camera access. Only files you select can be shared; SMS and the rest of your gallery stay private.</p><button data-mic>Test microphone</button><button data-camera>Test camera</button><label>Select a photo or file<input type="file" accept="image/*,audio/*,video/*,application/pdf"></label><p role="status"></p><audio controls hidden></audio><video autoplay playsinline muted hidden style="width:100%"></video><button data-close>Done</button>';
    document.body.append(dialog);dialog.showModal();let effect=null,stream=null,recorder=null,url=null,timer=null,closed=false,requesting=false;
    const status=dialog.querySelector('[role=status]');let choice='natural';if(owner){const select=document.createElement('select');select.setAttribute('aria-label','Voice effect');for(const [value,label]of voiceChoices)select.add(new Option(label,value));select.onchange=()=>{choice=select.value;effect?.set(choice);};dialog.querySelector('h2').after(select);const note=document.createElement('p');note.textContent='Live voice effects demo. This is not a voice clone or a call.';select.after(note);}
    const stop=()=>{clearTimeout(timer);if(recorder?.state==='recording')recorder.stop();stream?.getTracks().forEach(t=>t.stop());stream=null;effect?.close();effect=null;};
    async function test(video){
      if(requesting)return;requesting=true;stop();status.textContent='Waiting for permission…';
      try{const received=await navigator.mediaDevices.getUserMedia({audio:!video,video});if(closed){received.getTracks().forEach(t=>t.stop());return;}stream=received;
        if(video){const view=dialog.querySelector('video');view.hidden=false;view.srcObject=stream;status.textContent='Camera works. Tap Done to stop.';}
        else{const chunks=[];if(owner)effect=await createVoiceEffect(stream,choice);if(closed){stop();return;}recorder=new MediaRecorder(effect?new MediaStream([effect.track]):stream);const activeRecorder=recorder;recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onstop=()=>{if(closed)return;if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(new Blob(chunks,{type:activeRecorder.mimeType}));const audio=dialog.querySelector('audio');audio.hidden=false;audio.src=url;status.textContent='Microphone works. Play your 3-second local test. Nothing was uploaded.';};recorder.start();timer=setTimeout(stop,3000);status.textContent='Recording a 3-second local test…';}
      }catch(error){status.textContent=error.name==='NotAllowedError'?'Permission declined. Enable microphone or camera in your device app settings and try again.':error.message;}finally{requesting=false;}
    }
    dialog.querySelector('[data-mic]').onclick=()=>test(false);dialog.querySelector('[data-camera]').onclick=()=>test(true);
    dialog.querySelector('input').onchange=e=>{status.textContent=e.target.files[0]?`Selected: ${e.target.files[0].name}. This setup test does not upload the file.`:'No file selected.';};
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.onclose=()=>{closed=true;stop();if(url)URL.revokeObjectURL(url);dialog.remove();};
  };
}
