import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../public/live-call.js',import.meta.url),'utf8');

function fixture(local=true) {
  const nodes=new Map(), listeners=new Map(), instances=[], timers=[], requests=[];
  const node=selector=>{
    if(selector==='.main-content')return null;
    if(!nodes.has(selector))nodes.set(selector,{value:'',checked:false,textContent:'',classList:{toggle(){}},removeAttribute(){}});
    return nodes.get(selector);
  };
  class Recognition {
    constructor(){if(local)this.processLocally=false;this.starts=0;this.aborts=0;instances.push(this);}
    start(){this.starts++;}
    abort(){this.aborts++;}
  }
  const document={querySelector:node,visibilityState:'visible',hidden:false,addEventListener:(name,fn)=>listeners.set(name,fn)};
  node('#liveAgentSelect').value='a';node('#liveRoomSelect').value='r';
  const state={data:{agents:[{id:'a',name:'A'},{id:'b',name:'B'}],rooms:[{id:'r',agentIds:['a'],messages:[]}],settings:{}}};
  vm.runInNewContext(source,{window:{SpeechRecognition:Recognition,addEventListener(){}},document,
    navigator:{language:'en-US'},location:{search:''},URLSearchParams,AbortController,state,
    api:async(...args)=>{requests.push(args);return {room:state.data.rooms[0]};},
    modelInfo:()=>null,agentListLabel:agent=>agent.name,setTimeout:(fn,delay)=>{if(delay===250)timers.push(fn);}});
  const click=action=>listeners.get('click')({target:{closest:selector=>selector==='[data-live-action]'?{dataset:{liveAction:action}}:null}});
  const change=id=>listeners.get('change')({target:{matches:selectors=>selectors.split(',').map(s=>s.trim()).includes('#'+id)}});
  return {node,click,change,instances,timers,requests,document,listeners};
}
const result={resultIndex:0,results:[Object.assign([{transcript:'Synthetic fixture only'}],{isFinal:true})]};

test('legacy browser cannot start remote dictation without explicit consent',()=>{
  const ui=fixture(false);ui.click('listen');
  assert.equal(ui.instances[0].starts,0);assert.match(ui.node('#liveStatus').textContent,/On-device.*unavailable/);
  assert.equal(ui.requests.length,0);
  ui.node('#liveRemoteSpeech').checked=true;ui.click('listen');
  const active=ui.instances[1];assert.equal(active.starts,1);
  ui.node('#liveRemoteSpeech').checked=false;ui.change('liveRemoteSpeech');
  assert.equal(active.aborts,1);active.onresult(result);assert.equal(ui.requests.length,0);
});
test('native local mode is required and missing language support stays stopped',()=>{
  const ui=fixture();ui.click('listen');const active=ui.instances[0];
  assert.equal(active.processLocally,true);assert.equal(active.starts,1);
  active.onstart();assert.match(ui.node('#liveStatus').textContent,/on-device/);
  active.onerror({error:'language-not-supported'});active.onend();
  assert.match(ui.node('#liveStatus').textContent,/Local speech support/);
  assert.equal(ui.node('#liveListen').textContent,'Start listening');assert.equal(ui.timers.length,0);
});
test('agent changes and old restart callbacks cannot redirect dictation into another agent',()=>{
  const ui=fixture();ui.click('listen');const old=ui.instances[0];old.onstart();old.onend();
  assert.equal(ui.timers.length,1);
  ui.node('#liveAgentSelect').value='b';ui.change('liveAgentSelect');
  old.onresult(result);ui.timers[0]();assert.equal(old.starts,1);assert.equal(old.aborts,1);
  assert.equal(ui.requests.length,0);
  ui.click('listen');const next=ui.instances[1];next.onstart();
  old.onend();assert.equal(ui.node('#liveListen').textContent,'Stop listening');
  ui.click('stop-media');next.onresult(result);assert.equal(next.aborts,1);assert.equal(ui.requests.length,0);
});
test('room switch and hidden-page capture require a fresh explicit start',()=>{
  const ui=fixture();ui.click('listen');const old=ui.instances[0];
  ui.node('#liveRoomSelect').value='different';ui.change('liveRoomSelect');old.onresult(result);
  assert.equal(old.aborts,1);assert.equal(ui.requests.length,0);
  ui.click('listen');const next=ui.instances[1];ui.document.hidden=true;
  ui.listeners.get('visibilitychange')();next.onstart();next.onresult(result);
  assert.ok(next.aborts>=1);assert.equal(ui.requests.length,0);
  assert.equal(ui.node('#liveListen').textContent,'Start listening');
});
