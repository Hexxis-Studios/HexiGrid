import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

test('external-first group waits for actual context before local model and Stop skips the later responder',async()=>{
  const source=await readFile(new URL('../public/chat-ui.js',import.meta.url),'utf8');
  for(const stop of [false,true]){
    const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{value:'',focus(){}});return nodes.get(id);};
    const people=[{id:'paired',name:'External',transport:'agent-link'},{id:'local',name:'Local',transport:'local-opencode'}];
    const room={id:'qa',agentIds:people.map(item=>item.id),messages:[]},state={data:{agents:people,rooms:[room]},activeRoomId:room.id};
    let release,waitingStarted;const waiting=new Promise(resolve=>{waitingStarted=resolve;});const calls=[];
    const context=vm.createContext({state,$,AbortController,DOMException,crypto:{randomUUID},activeRoom:()=>room,agent:id=>people.find(item=>item.id===id),modelInfo:()=>null,notify(){},
      api:async(url,options={})=>{
        calls.push(url);
        if(url.endsWith('/messages/user')){room.messages.push({id:'owner',role:'user',content:'Harmless QA'});return {room};}
        if(url.endsWith('/messages')){
          const id=JSON.parse(options.body).agentIds[0];
          if(id==='paired'){const queued={id:'pending',linkedTurn:{eventId:'external-event',status:'queued'}};room.messages.push(queued);return {room,replies:[queued]};}
          assert.equal(room.messages.at(-1).content,'Actual external reply');return {room};
        }
        if(url.includes('/wait?'))return new Promise((resolve,reject)=>{release=()=>{room.messages.push({role:'agent',content:'Actual external reply'});resolve({room});};options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true});waitingStarted();});
        if(url.endsWith('/stop'))return {stopped:true};
        if(url==='/api/rooms')return {rooms:[room]};
        throw new Error('Unexpected route');
      }});
    vm.runInContext(source,context);vm.runInContext('renderRooms=()=>{};renderAll=()=>{};',context);
    $('#chatInput').value='Harmless QA';const sending=context.sendChat({preventDefault(){}});await waiting;
    assert.equal(calls.filter(url=>url.endsWith('/messages')).length,1,'local generation must wait');
    assert.equal(state.chatTurn.waitingFor,'External');
    stop ? await context.stopChat() : release();await sending;
    assert.equal(calls.filter(url=>url.endsWith('/messages')).length,stop?1:2);
    assert.equal(state.chatTurn,null);
  }
});

test('responder selection preserves existing order and appends newly selected agents',async()=>{
  const source=await readFile(new URL('../public/chat-ui.js',import.meta.url),'utf8');
  const room={id:'qa',agentIds:['external'],messages:[]};let saved;
  const context=vm.createContext({activeRoom:()=>room,$$:()=>[{dataset:{agentToggle:'local'}},{dataset:{agentToggle:'external'}}],notify(){},api:async(_url,options)=>{saved=JSON.parse(options.body);return {room:{...room,agentIds:saved.agentIds}};}});
  vm.runInContext(source,context);vm.runInContext('renderRooms=()=>{};',context);await context.updateRoomAgents();
  assert.deepEqual(saved.agentIds,['external','local']);
});
