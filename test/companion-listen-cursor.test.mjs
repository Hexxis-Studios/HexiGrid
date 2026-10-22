import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {OutboundCompanionConnection} from '../lib/companion-client.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('CLI status and workspace flag errors are actionable before opening a session', () => {
 const script = fileURLToPath(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs', import.meta.url));
 const bare = spawnSync(process.execPath, [script, 'status', '--connection'], {encoding:'utf8'});
 assert.equal(bare.status, 1); assert.match(bare.stderr, /Supply --connection <value>/);
 const write = spawnSync(process.execPath, [script, 'workspace-write', '--path', 'qa.txt', '--file', 'missing-qa-file.txt'], {encoding:'utf8'});
 assert.equal(write.status, 1); assert.match(write.stderr, /new file use --create-only/); assert.match(write.stderr, /workspace-read/);
 assert.doesNotMatch(write.stderr, /ENOENT|token|vault/i);
});

test('one-shot listen returns and acknowledges only the delivered event from a batch',async()=>{
 const source=await readFile(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs',import.meta.url),'utf8');
 const listenSource=source.slice(source.indexOf('async function listen(flags)'),source.indexOf('async function watch(flags)'));
 for(const ackOk of [true,false]) {
  const client=new OutboundCompanionConnection({resume:{origin:'https://relay.example.test',inviteId:'qa',deviceId:'qa'},automaticControl:false});
  let record={connectionId:'qa',lastSequence:0};const packets=[],acks=[];
  client.linkRequest=async(path,options)=>path.endsWith('/poll') ? {ok:true,body:{events:[{sequence:1,text:'first'},{sequence:2,text:'second'}]}} : (acks.push(options.body.through),{ok:ackOk,status:ackOk?200:503,body:{}});
  client.close=async()=>{};
  const context=vm.createContext({openSaved:async()=>({record,client}),readConfig:async()=>({...record}),writeConfig:async(value)=>{record=value;},output:value=>packets.push(value)});
  vm.runInContext(listenSource,context);await context.listen({timeout:1});
  assert.equal(packets.length,1);assert.equal(packets[0].events.length,1);assert.equal(packets[0].events[0].sequence,1);
  assert.equal(record.lastSequence,1);assert.equal(client.state.lastSequence,1);assert.deepEqual(acks,[1]);
  assert.equal(Boolean(packets[0].ackPending),!ackOk);
  // The next poll still delivers event two; it was never consumed invisibly.
  client.onEvent=null; const next=await client.pollEvents({waitMs:0,limit:1});
  if(ackOk) assert.equal(next.events[0].sequence,2);
  assert.equal(client.state.lastSequence,2);
 }
});

test('ordinary one-shot requests and explicit event-page reads never consume or acknowledge unrelated events', async () => {
 const source=await readFile(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs',import.meta.url),'utf8');
 const functions=source.slice(source.indexOf('async function command(flags'),source.indexOf('async function desktopFrame(flags)'));
 const calls=[],packets=[]; let closed=0,opened=0;
 const record={lastSequence:7};
 const client={linkRequest:async(path,options)=>{calls.push({path,options});return {ok:true,body:{events:[{sequence:8,text:'Unconsumed'}],nextAfter:8,hasMore:true}};},close:async()=>{closed++;}};
 const context=vm.createContext({openSaved:async(_flags,options)=>{opened++;assert.equal(options.automaticControl,false);return {record,client};},output:value=>packets.push(value)});
 vm.runInContext(functions,context);
 await context.command({connection:'qa'},'/agent-link/v1/identity',null,'GET');
 await context.events({connection:'qa'});
 assert.deepEqual(calls.map(item=>item.path),['/agent-link/v1/identity','/agent-link/v1/events/poll']);
 assert.equal(calls[1].options.body.after,7);assert.equal(calls[1].options.body.waitMs,0);
 assert.equal(record.lastSequence,7);assert.equal(closed,2);assert.equal(packets[1].result.nextAfter,8);assert.equal(packets[1].result.hasMore,true);
 for(const flags of [{after:-1},{after:'not-a-sequence'},{'wait-ms':25001}]) await assert.rejects(context.events(flags));
 assert.equal(opened,2,'Invalid input must fail before opening a credential-backed session');
});

test('direct HTTPS event command reads without saving or acknowledging and validates before credentials', () => {
 const script = String.raw`
import ast, json, sys
from pathlib import Path
from types import SimpleNamespace
tree=ast.parse(Path(sys.argv[1]).read_text(encoding='utf-8'))
function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='events')
calls=[]; opened=[]; record={'lastSequence':7}
def context(connection):
    opened.append(connection); return record,'test-only-token'
def request(origin,endpoint,method,token,body):
    calls.append((endpoint,method,body)); return {'events':[{'sequence':8}],'nextAfter':8,'hasMore':True}
namespace={'context':context,'request':request,'record_origin':lambda record:'http://127.0.0.1','json':json,'print':lambda value:None}
exec(compile(ast.Module(body=[function],type_ignores=[]),'<events>','exec'),namespace)
namespace['events'](SimpleNamespace(connection='qa',after=None,wait_ms=0))
assert calls==[('/agent-link/v1/events/poll','POST',{'after':7,'waitMs':0})]
assert record=={'lastSequence':7}
for after,wait in [(-1,0),(9007199254740992,0),(0,25001)]:
    try: namespace['events'](SimpleNamespace(connection='qa',after=after,wait_ms=wait))
    except RuntimeError: pass
    else: raise AssertionError('Invalid input accepted')
assert opened==['qa']
`;
 const result=spawnSync('python',['-c',script,fileURLToPath(new URL('../integrations/hexigrid-link/scripts/link_client.py',import.meta.url))],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);
});
