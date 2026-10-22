import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
test('host sequence is submitted once, browser stops owning generation, and Stop uses recovered request',async()=>{
  const room={id:'qa',agentIds:['external','local'],messages:[]};
  const people=[{id:'external',transport:'agent-link'},{id:'local',transport:'local-opencode'}];
  const state={data:{rooms:[room],agents:people}};const input={value:'Harmless QA',focus(){}};const calls=[];
  const context=vm.createContext({state,$:()=>input,activeRoom:()=>room,agent:id=>people.find(item=>item.id===id),modelInfo:()=>null,isStandaloneBrowser:()=>false,AbortController,crypto:{randomUUID},notify(){},
    api:async(url,options={})=>{calls.push(url);if(url.endsWith('/turns')){const body=JSON.parse(options.body);assert.deepEqual(body.agentIds,['external','local']);return {room:{...room,replyChain:{requestId:body.requestId,status:'waiting',index:0,agentIds:body.agentIds}}};}if(url.endsWith('/stop')){assert.equal(JSON.parse(options.body).requestId,room.replyChain.requestId);room.replyChain.status='cancelled';return {stopped:true};}if(url==='/api/rooms')return {rooms:[room]};throw Error('Unexpected route');}});
  vm.runInContext(await readFile(new URL('../public/chat-ui.js',import.meta.url),'utf8'),context);vm.runInContext('renderRooms=()=>{};renderAll=()=>{};',context);
  await context.sendChat({preventDefault(){}});assert.equal(state.chatTurn,null);assert.equal(room.replyChain.status,'waiting');assert.equal(calls.length,1);
  await context.stopChat();assert.equal(room.replyChain.status,'cancelled');
});
