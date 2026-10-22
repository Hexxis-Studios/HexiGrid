import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRoomEvents} from '../lib/room-events.mjs';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

function response(){const res=new EventEmitter();res.chunks=[];res.writeHead=()=>{};res.write=value=>{res.chunks.push(value);return true;};res.end=()=>{res.ended=true;res.emit('close');};return res;}
test('room stream sends only invalidation and stops immediately when session is revoked',()=>{
 let allowed=true; const events=createRoomEvents({authorized:()=>allowed,headers:()=>({})});
 const res=response(); assert.equal(events.subscribe({},res),true);events.publish();
 assert.deepEqual(res.chunks,['retry: 3000\n\n','event: rooms-changed\ndata: {}\n\n']);
 allowed=false;events.publish(); assert.equal(res.ended,true);assert.equal(res.chunks.length,2);
 const denied=response();assert.equal(events.subscribe({},denied),false);assert.equal(denied.chunks.length,0);
});
test('closed and slow views are cleaned without buffering conversation events',()=>{
 const events=createRoomEvents({authorized:()=>true,headers:()=>({})});const res=response();events.subscribe({},res);res.emit('close');events.publish();assert.equal(res.chunks.length,1);
 const slow=response();events.subscribe({},slow);slow.write=()=>false;events.publish();assert.equal(slow.ended,true);
});
test('browser push waits for an active turn and coalesces invalidations without model calls',async()=>{
 const source=await readFile(new URL('../public/chat-ui.js',import.meta.url),'utf8');
 const state={data:{rooms:[]},chatTurn:{}};const handlers={};let calls=0, renders=0;
 const context=vm.createContext({state,isStandaloneBrowser:()=>false,window:{addEventListener(){}},
  EventSource:class {addEventListener(name,handler){handlers[name]=handler;}},
  api:async url=>{assert.equal(url,'/api/rooms');calls++;return {rooms:['saved-reply']};}});
 vm.runInContext(source,context);context.renderRooms=()=>{renders++;};context.startRoomEvents();
 handlers['rooms-changed']();handlers['rooms-changed']();assert.equal(calls,0);
 state.chatTurn=null;await context.applyRoomEvents();assert.equal(calls,1);assert.equal(renders,1);assert.deepEqual(state.data.rooms,['saved-reply']);
});
test('an arriving refresh cannot replace room state after a new send starts',async()=>{
 const source=await readFile(new URL('../public/chat-ui.js',import.meta.url),'utf8');
 const state={data:{rooms:['owner-turn']},chatTurn:null};let release;let calls=0;
 const context=vm.createContext({state,api:async()=>{calls++;if(calls===1)await new Promise(resolve=>release=resolve);return {rooms:['saved']};}});
 vm.runInContext(source,context);context.renderRooms=()=>{};vm.runInContext('roomRefreshPending=true',context);
 const running=context.applyRoomEvents();state.chatTurn={};release();await running;
 assert.deepEqual(state.data.rooms,['owner-turn']);state.chatTurn=null;await context.applyRoomEvents();assert.deepEqual(state.data.rooms,['saved']);
});
