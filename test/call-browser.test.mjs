import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CallBrowserBridge, callChatAuthorized, validateCallChatSelection } from '../lib/call-browser.mjs';
import { handleCallBrowserRequest } from '../lib/call-browser-routes.mjs';

const selection = { provider:'muse',url:'https://muse.ai/thread/5a082d36-0552-453a-b317-f310f24799cc',title:'Muse',linkId:'one',label:'Calls' };
const event = text => ({type:'speech.transcript.final',text,metadata:{source:'owner-microphone',callId:'call-one'}});
test('owner-selected side chat is preserved; arbitrary hosts, secrets and unfinished chats are refused',()=>{
  assert.deepEqual(validateCallChatSelection(selection),selection);
  for (const url of ['https://evil.example/','https://muse.ai/thread/new','https://muse.ai/?token=secret','https://user:password@muse.ai/']) {
    assert.throws(()=>validateCallChatSelection({...selection,url}));
  }
  assert.equal(validateCallChatSelection({...selection,url:'https://muse.ai/',title:'Chat — Agent'}).url,'https://muse.ai/');
});
test('call text is pushed once to its selected connection, claimed once and cleared after receipt',()=>{
  const receipts=[]; const bridge=new CallBrowserBridge({authorize:(_b,id)=>id==='call-one',receipt:(...r)=>receipts.push(r)});
  const client=new EventEmitter();let written='';client.write=s=>{written+=s;return true;};client.end=()=>{};
  const binding={...selection,id:'binding-one',enabled:true};bridge.subscribe(binding,client);
  assert.equal(bridge.publish(binding,{id:'call-one'},event('harmless hello')),true);
  const offered=JSON.parse(written.split('data: ')[1].trim());
  const turn=bridge.claim(binding,offered.id); assert.equal(turn.text,'harmless hello');
  assert.throws(()=>bridge.claim(binding,offered.id));
  assert.throws(()=>bridge.claim({...binding,id:'other'},offered.id));
  bridge.report(binding,offered.id,'submitted');assert.equal(bridge.turns.get(offered.id).text,'');
  assert.equal(receipts[0][1],'completed');assert.ok(!JSON.stringify(receipts).includes('harmless hello'));
  assert.throws(()=>bridge.report(binding,offered.id,'submitted'));
});
test('end, mute, scope revocation, replacement and expiry prevent dispatch; failures are not retried',()=>{
  let allowed=true,now=0;const bridge=new CallBrowserBridge({authorize:()=>allowed,clock:()=>now});
  const binding={...selection,id:'binding',enabled:true}; const client=new EventEmitter();let raw='';client.write=s=>{raw=s;return true;};client.end=()=>{};
  bridge.subscribe(binding,client);bridge.publish(binding,{id:'call-one'},event('test'));
  const id=JSON.parse(raw.split('data: ')[1]).id;allowed=false;assert.throws(()=>bridge.claim(binding,id));
  assert.equal(bridge.turns.size,0);allowed=true;bridge.publish(binding,{id:'call-one'},event('test'));
  now=60001;bridge.prune();assert.equal(bridge.turns.size,0);
  assert.equal(bridge.publish(binding,{id:'different'},event('test')),false);
  assert.equal(bridge.publish(binding,{id:'call-one'},{...event('test'),type:'speech.transcript.partial'}),false);
  bridge.disconnect(binding.id);assert.equal(bridge.publish(binding,{id:'call-one'},event('test')),false);
});
test('native route rejects remote/browser and wrong credentials before exposing links',async()=>{
  for(const [host,origin,secret,expected] of [[false,null,'yes',403],[true,'https://muse.ai','yes',403],[true,null,'wrong',401]]) {
    let result; await handleCallBrowserRequest({headers:{authorization:`Bearer ${secret}`,...(origin?{origin}:{})}}, {}, {
      pathname:'/api/call-browser/v1/links',method:'GET',url:new URL('http://localhost/'),secret:'yes',isHostRequest:()=>host,
      safeEqual:(a,b)=>a===b,json:(_r,status)=>{result=status;},state:()=>{throw new Error('must not read state');}
    }); assert.equal(result,expected);
  }
});

test('switching away and back invalidates a queued turn even when the call ID is unchanged',()=>{
  let epoch=0;const bridge=new CallBrowserBridge({authorize:(_binding,_call,expected)=>expected===epoch});
  const binding={...selection,id:'b',enabled:true};const client=new EventEmitter();let raw='';client.write=s=>{raw=s;return true;};client.end=()=>{};
  bridge.subscribe(binding,client);bridge.publish(binding,{id:'call-one',mediaEpoch:0},event('Before hold'));
  const old=JSON.parse(raw.split('data: ')[1]);epoch=2;
  assert.throws(()=>bridge.claim(binding,old.id));assert.equal(bridge.turns.size,0);
  bridge.publish(binding,{id:'call-one',mediaEpoch:2},event('After resume'));
  const fresh=bridge.claim(binding,JSON.parse(raw.split('data: ')[1]).id);assert.equal(fresh.mediaEpoch,2);
});
test('installed helpers can check a claimed wake without new client fields; unclaimed or completed turns are denied',async()=>{
  let allowed=true;
  const bridge=new CallBrowserBridge({authorize:(_b,_c,_e,kind)=>allowed && kind==='wake'});
  const binding={...selection,id:'binding',enabled:true};const client=new EventEmitter();let raw='';
  client.end=()=>{};client.write=s=>{raw=s;return true};bridge.subscribe(binding,client);
  bridge.wake(binding,{id:'call-one',status:'offered',mediaEpoch:0});const id=JSON.parse(raw.split('data: ')[1]).id;
  assert.equal(bridge.canDispatch(binding,'call-one',0),false);bridge.claim(binding,id);
  let result;await handleCallBrowserRequest({headers:{authorization:'Bearer test'}},{},{
    pathname:'/api/call-browser/v1/check',method:'POST',url:new URL('http://localhost/'),secret:'test',isHostRequest:()=>true,
    safeEqual:(a,b)=>a===b,json:(_r,_s,body)=>{result=body},readBody:async()=>({bindingId:binding.id,callId:'call-one',mediaEpoch:0}),
    state:()=>({settings:{callBrowserBindings:[binding]}}),bridge
  });
  assert.equal(result.active,true);assert.equal(bridge.canDispatch(binding,'call-one',1),false);
  bridge.report(binding,id,'submitted');assert.equal(bridge.canDispatch(binding,'call-one',0),false);
  bridge.wake(binding,{id:'call-two',status:'offered',mediaEpoch:0});bridge.claim(binding,JSON.parse(raw.split('data: ')[1]).id);
  allowed=false;assert.equal(bridge.canDispatch(binding,'call-two',0),false);
});
test('actual dispatch authority intersects selection, Link, both media grants, device, policy and exact call',()=>{
  const fixture=()=>({state:{settings:{callBrowserBindings:[{id:'b',enabled:true,linkId:'one'}],desktopBridge:{enabled:true,ownerApproved:true,linkId:'one'}},
    agentLinks:[{id:'one',status:'connected',capabilities:['microphone-listen','speaker-output']}]},
    selection:{id:'b',callId:'c'},call:{id:'c',linkId:'one',status:'active',ownerMuted:false},
    media:{linkId:'one',microphoneGranted:true,speakerGranted:true},policyDenied:false});
  assert.equal(callChatAuthorized(fixture()),true);
  for(const change of [x=>x.call.ownerMuted=true,x=>x.call.status='ended',x=>x.call.id='new',
    x=>x.media.microphoneGranted=false,x=>x.media.speakerGranted=false,x=>x.media.linkId='other',
    x=>x.state.agentLinks[0].capabilities=['speaker-output'],x=>x.state.agentLinks[0].status='revoked',
    x=>x.state.settings.desktopBridge.enabled=false,x=>x.state.settings.desktopBridge.ownerApproved=false,
    x=>x.state.settings.callBrowserBindings[0].enabled=false,x=>x.selection.id='other',x=>x.policyDenied=true]) {
    const value=fixture();change(value);assert.equal(callChatAuthorized(value),false);
  }
  const independentControl = fixture(); independentControl.state.settings.desktopBridge.linkId='other';
  assert.equal(callChatAuthorized(independentControl),true); // Exact selected call/media still belongs to this binding.
  independentControl.call.mediaEpoch=2;
  assert.equal(callChatAuthorized(independentControl),false); // An older helper must not submit after a switch.
  independentControl.selection.mediaEpoch=2;
  assert.equal(callChatAuthorized(independentControl),true);
  independentControl.selection.mediaEpoch=0;
  assert.equal(callChatAuthorized(independentControl),false);
});
