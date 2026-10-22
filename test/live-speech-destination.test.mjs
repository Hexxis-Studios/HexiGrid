import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/live-generated-voice.js',import.meta.url),'utf8');
function fixture(providers){
  const requests=[],statuses=[];
  const controls={'#generatedVoiceProvider':{value:'other'},'#generatedVoiceModel':{value:'other-model'}};
  const window={addEventListener(){},HexiGridLiveCall:{setStatus:message=>statuses.push(message)}};
  vm.runInNewContext(source,{window,state:{data:{providers}},document:{querySelector:s=>controls[s]||null,addEventListener(){}},
    api:async(path,request)=>{requests.push({path,body:JSON.parse(request.body)});return {media:{url:'https://synthetic.example/clip'}};},
    Audio:class{play(){return Promise.resolve();}pause(){}},URL, setTimeout(){},notify(){}});
  return {speech:window.HexiGridGeneratedVoice,requests,statuses,controls};
}
const provider=id=>({id,name:id,enabled:true,capabilities:['speech']});
const agent={voiceProfile:{engine:'provider',providerId:'saved',model:'saved-model',voiceId:'saved-voice'}};
test('unavailable or disabled saved provider cannot fall back to the selected provider',async()=>{
  for(const providers of [[provider('other')],[provider('other'),{...provider('saved'),enabled:false}]]){
    const ui=fixture(providers);await ui.speech.speakText('Synthetic private reply',agent);
    assert.equal(ui.requests.length,0);assert.match(ui.statuses.at(-1),/full reply remains in text/);
  }
});
test('reply speech binds the saved provider, model and voice without changing preview controls',async()=>{
  const ui=fixture([provider('other'),provider('saved')]);await ui.speech.speakText('Synthetic reply',agent);
  assert.deepEqual(ui.requests[0],{path:'/api/live/speech',body:{providerId:'saved',model:'saved-model',voice:'saved-voice',text:'Synthetic reply'}});
  assert.equal(ui.controls['#generatedVoiceProvider'].value,'other');assert.equal(ui.controls['#generatedVoiceModel'].value,'other-model');
  const missing=fixture([provider('other'),provider('saved')]);await missing.speech.speakText('No model',{voiceProfile:{...agent.voiceProfile,model:''}});
  assert.equal(missing.requests.length,0);
});
