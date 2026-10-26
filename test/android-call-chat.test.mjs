import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AndroidCallChat, loadAndroidCallProfiles } from '../lib/android-call-chat.mjs';
import { callChatAuthorized, CallBrowserBridge } from '../lib/call-browser.mjs';
import { EventEmitter } from 'node:events';
import { defaultDesktopBridge, startDesktopBridge } from '../lib/desktop-bridge.mjs';
import { startDesktopMedia, resetDesktopMediaForTests } from '../lib/desktop-media.mjs';
import { handleDesktopBridgeRequest, applyOwnerIncomingVoiceCallAction } from '../lib/desktop-bridge-routes.mjs';
import { publicVoiceCall, resetVoiceCallForTests, initiateVoiceCall } from '../lib/voice-call.mjs';

const profile = (id='a') => ({id,enabled:true,linkId:id});
const speech = (call, text) => ({call,event:{type:'speech.transcript.final',text,metadata:{source:'owner-microphone',callId:call.id}}});

test('Call wakes the exact native chat once; each final sentence follows it through the same serialized delivery', async () => {
  const sent=[],receipts=[],saved=[]; const p=profile();
  const runtime=new AndroidCallChat({profiles:[p],authorize:()=>true,prepare:async()=>({send:async turn=>{
    turn.check(); sent.push(turn); return {anchorResourceId:`timeline-message-${sent.length}`};
  }}),receipt:(_p,status)=>receipts.push(status),persist:async ps=>saved.push(ps[0].anchorResourceId)});
  const call={id:'c',linkId:'a',status:'offered',mediaEpoch:0};
  runtime.wake(call);runtime.wake(call);
  runtime.transcript(speech(call,'Hello, café 你好 👋'));runtime.transcript(speech(call,'Second sentence'));
  await runtime.idle();
  assert.equal(sent.length,3); assert.match(sent[0].text,/Your paired owner is calling/);
  assert.match(sent[0].text,/voice-call-answer/);assert.match(sent[1].text,/Hello, café 你好 👋/);
  assert.match(sent[2].text,/Second sentence/);assert.ok(sent.every(t=>t.text.includes('call c')));
  assert.deepEqual(receipts,['completed','completed','completed']);assert.equal(saved.length,3);
  assert.equal(runtime.transcript(speech({...call,linkId:'other'},'not authorized')),false);
});

test('end, mute, hold, policy or grant loss before submission stops the queued sentence; uncertain delivery is not retried', async () => {
  let allowed=true, release;const receipts=[],sent=[];const p=profile();
  const runtime=new AndroidCallChat({profiles:[p],authorize:()=>allowed,prepare:()=>new Promise(resolve=>{release=()=>resolve({send:async t=>{t.check();sent.push(t);return{anchorResourceId:'timeline-message-1'}}})}),receipt:(_p,s,d)=>receipts.push([s,d])});
  const call={id:'c',linkId:'a',mediaEpoch:0};runtime.transcript(speech(call,'old speech'));
  await new Promise(r=>setImmediate(r));allowed=false;release();await runtime.idle();assert.equal(sent.length,0);
  allowed=true;runtime.prepare=async()=>({send:async t=>{t.onSubmit();throw Error('unknown result')}});
  runtime.transcript(speech(call,'one attempt'));await runtime.idle();await runtime.idle();
  assert.equal(receipts.length,2);assert.match(receipts[1][1],/uncertain/);assert.ok(!JSON.stringify(receipts).includes('old speech'));
});

test('waking an offered owner call is permitted without permitting speech before answer',()=>{
  const p=profile(),state={settings:{desktopBridge:{enabled:true,ownerApproved:true}},agentLinks:[{id:'a',status:'connected',capabilities:['microphone-listen','speaker-output']}]};
  const args={state,bindings:[p],selection:{id:'a',callId:'c',mediaEpoch:0},call:{id:'c',linkId:'a',status:'offered',direction:'owner-to-agent'},media:{linkId:'a',microphoneGranted:true,speakerGranted:true}};
  assert.equal(callChatAuthorized({...args,kind:'wake'}),true);assert.equal(callChatAuthorized(args),false);
  for(const change of [x=>x.call.ownerMuted=true,x=>x.call.status='ended',x=>x.call.linkId='other',x=>x.call.mediaEpoch=2,x=>x.state.agentLinks[0].status='revoked',x=>x.media.microphoneGranted=false,x=>x.policyDenied=true]){
    const value=structuredClone(args);change(value);assert.equal(callChatAuthorized({...value,kind:'wake'}),false);
  }
});

test('a denied wake is reported as denied and can be attempted after approved access returns',async()=>{
  let allowed=false;const receipts=[],sent=[];
  const runtime=new AndroidCallChat({profiles:[profile()],authorize:()=>allowed,receipt:(_p,status)=>receipts.push(status),
    prepare:async()=>({send:async t=>{sent.push(t);return{anchorResourceId:'timeline-message-1'}}})});
  const call={id:'c',linkId:'a',mediaEpoch:0};
  assert.equal(runtime.wake(call),false);assert.equal(runtime.transcript(speech(call,'denied')),false);
  assert.deepEqual(receipts,['failed','failed']);allowed=true;assert.equal(runtime.wake(call),true);
  await runtime.idle();assert.equal(sent.length,1);
});

test('the actual owner Call and incoming Accept routes invoke wake delivery, preserving call identities',async()=>{
  resetVoiceCallForTests();resetDesktopMediaForTests();
  try {
    const connection={id:'a',agentId:'agent-a',status:'connected',identity:{name:'Synthetic'},capabilities:['microphone-listen','speaker-output'],events:[],nextSequence:1};
    const state={settings:{desktopBridge:startDesktopBridge(defaultDesktopBridge(),{linkId:'a',viewGranted:true})},agentLinks:[connection]};
    startDesktopMedia({linkId:'a',microphoneGranted:true,speakerGranted:true});const sent=[];
    const runtime=new AndroidCallChat({profiles:[profile()],authorize:()=>true,prepare:async()=>({send:async t=>{sent.push(t.text);return{anchorResourceId:'timeline-message-1'}}})});
    let result;await handleDesktopBridgeRequest({}, {}, {state,pathname:'/api/desktop-bridge/voice-call/start',method:'POST',readBody:async()=>({linkId:'a',approved:true}),json:(_r,status,body)=>{result={status,body}},connectorPolicy:()=>null,addReceipt:()=>({}),addActivity:()=>{},saveState:async()=>{},onVoiceCallStarted:c=>runtime.wake(c)});
    await runtime.idle();assert.equal(result.status,201);assert.match(sent[0],new RegExp(result.body.voiceCall.id));
    resetVoiceCallForTests();const incoming=initiateVoiceCall({linkId:'a',callerName:'Synthetic',microphoneGranted:true,speakerGranted:true});
    await applyOwnerIncomingVoiceCallAction({state,callId:incoming.id,action:'accept',connectorPolicy:()=>null,addReceipt:()=>({}),saveState:async()=>{},onVoiceCallStarted:c=>runtime.wake(c)});
    await runtime.idle();assert.equal(sent.length,2);assert.match(sent[1],/owner accepted/);assert.equal(publicVoiceCall().status,'active');
  } finally {resetVoiceCallForTests();resetDesktopMediaForTests();}
});

test('the existing browser adapter also receives one initial wake, without a second call transport',()=>{
  const bridge=new CallBrowserBridge({authorize:()=>true});const b={id:'b',enabled:true},client=new EventEmitter();const messages=[];
  client.end=()=>{};client.write=s=>{messages.push(JSON.parse(s.split('data: ')[1]));return true};bridge.subscribe(b,client);
  const call={id:'c',status:'offered',mediaEpoch:0};assert.equal(bridge.wake(b,call),true);assert.equal(bridge.wake(b,call),false);
  assert.equal(messages[0].kind,'wake');assert.equal(bridge.claim(b,messages[0].id).kind,'wake');
});

test('profile routing rejects duplicate account bindings and nonlocal or arbitrary device identifiers',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'hexigrid-android-profile-'));const file=path.join(dir,'profiles.json');
  const p={id:'profile-a',enabled:true,linkId:'link-00000000-0000-0000-0000-000000000001',agentExternalId:'123',agentName:'Synthetic',anchorResourceId:'timeline-message-1',serial:'emulator-5586',adbServerPort:5041,uiPort:8205,adbPath:path.resolve('adb.exe'),launchScript:path.resolve('start.ps1')};
  try {await writeFile(file,JSON.stringify({version:1,profiles:[p]}));assert.equal((await loadAndroidCallProfiles(file)).length,1);
    for(const profiles of [[p,{...p,id:'profile-b'}],[p,{...p,id:'profile-b',linkId:'link-00000000-0000-0000-0000-000000000002',uiPort:8206}],[{...p,serial:'192.168.0.1:5555'}],[{...p,anchorResourceId:'unverified'}]]){
      await writeFile(file,JSON.stringify({version:1,profiles}));await assert.rejects(loadAndroidCallProfiles(file));
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
