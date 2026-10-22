import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/live-voice.js',import.meta.url),'utf8');
function fixture(voices){
  let currentVoices=voices;
  const nodes=new Map(), spoken=[], statuses=[], listeners=new Map();
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{value:'',textContent:'',innerHTML:''});return nodes.get(selector);};
  const window={speechSynthesis:{getVoices:()=>currentVoices,speak:u=>spoken.push(u),cancel(){},addEventListener(){}},SpeechSynthesisUtterance:class{constructor(text){this.text=text;}},HexiGridLiveCall:{selectedAgent:()=>({id:'a'}),setStatus:(...args)=>statuses.push(args)}};
  vm.runInNewContext(source,{window,SpeechSynthesisUtterance:window.SpeechSynthesisUtterance,document:{querySelector:node,addEventListener:(name,fn)=>listeners.set(name,fn)}});
  return {voice:window.HexiGridLiveVoice,spoken,statuses,node,listeners,replace:voices=>{currentVoices=voices;}};
}
const local={name:'Local device',lang:'en-US',localService:true}, remote={name:'Remote default',lang:'en-US',localService:false,default:true};
test('free output excludes remote voices and assigns an explicit local voice even for default selection',()=>{
  const ui=fixture([remote,local,{name:'Unknown service',lang:'en'}]);ui.voice.refreshVoices();
  assert.doesNotMatch(ui.node('#liveVoiceSelect').innerHTML,/Remote default|Unknown service/);
  assert.match(ui.node('#liveVoiceSupport').textContent,/1 local voice/);
  assert.equal(ui.voice.speak('Private reply'),true);assert.equal(ui.spoken[0].voice,local);
});
test('saved remote or removed voice cannot send text to a remote service',()=>{
  const ui=fixture([remote,local]);assert.equal(ui.voice.speak('Reply',{voiceProfile:{voiceName:remote.name,pitch:0,volume:0}}),false);
  assert.equal(ui.spoken.length,0,'never substitute an unrelated voice for a missing chosen voice');
  assert.match(ui.statuses.at(-1)[0],/chosen voice is unavailable/);
  assert.equal(ui.voice.speak('Reply',{voiceProfile:{voiceName:local.name,pitch:0,volume:0}}),true);
  assert.equal(ui.spoken[0].voice,local);assert.equal(ui.spoken[0].pitch,0);assert.equal(ui.spoken[0].volume,0);
  ui.replace([remote]);assert.equal(ui.voice.speak('Must remain text'),false);assert.equal(ui.spoken.length,1);
  assert.match(ui.statuses.at(-1)[0],/No local speech voice/);
});
test('stopped and replaced voice callbacks cannot overwrite the current status',()=>{
  const ui=fixture([local]);ui.voice.speak('Old');const old=ui.spoken[0];ui.voice.speak('New');const next=ui.spoken[1];
  next.onstart();const count=ui.statuses.length;old.onend();old.onerror();assert.equal(ui.statuses.length,count);
  ui.voice.stop();next.onstart();next.onend();assert.equal(ui.statuses.length,count);
  ui.voice.speak('Third');ui.listeners.get('change')({target:{matches:s=>s==='#liveAgentSelect'}});
  ui.spoken[2].onend();assert.equal(ui.statuses.length,count);
});
