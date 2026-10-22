import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const freePort=()=>new Promise((resolve)=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const waitFor=async(url)=>{for(let count=0;count<80;count++){try{const response=await fetch(url);if(response.ok)return;}catch{}await new Promise((resolve)=>setTimeout(resolve,50));}throw new Error('Test server did not start.');};

test('a fresh install refuses an OpenCode shell shim and never connects it automatically',async(t)=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'hexigrid-harness-'));
  const port=await freePort();
  const fake=path.join(dataDir,process.platform==='win32'?'opencode.cmd':'opencode');
  const source=process.platform==='win32'
    ? '@echo off\r\nif "%1"=="--version" (\r\n echo opencode test\r\n exit /b 0\r\n)\r\nif "%1"=="auth" (\r\n echo Credentials\r\n echo test-provider oauth\r\n exit /b 0\r\n)\r\nif "%1"=="models" (\r\n echo test/current-free\r\n echo {\r\n echo "id":"current-free",\r\n echo "providerID":"test",\r\n echo "cost":{"input":0,"output":0}\r\n echo }\r\n exit /b 0\r\n)\r\n'
    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode test"; elif [ "$1" = "auth" ]; then printf "Credentials\\ntest-provider oauth\\n"; elif [ "$1" = "models" ]; then printf "test/current-free\\n{\\n\\"id\\":\\"current-free\\",\\n\\"providerID\\":\\"test\\",\\n\\"cost\\":{\\"input\\":0,\\"output\\":0}\\n}\\n"; fi\n';
  await fs.writeFile(fake,source,{mode:0o700});
  const missing=path.join(dataDir,'not-installed');
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,HEXIGRID_PORT:String(port),HEXIGRID_DATA_DIR:dataDir,OPENCODE_CLI:fake,CLAUDE_CLI:missing,CODEX_CLI:missing}});
  let startupError='';child.stderr.on('data',(chunk)=>{startupError+=chunk.toString();});
  t.after(async()=>{child.kill();await fs.rm(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;try{await waitFor(`${base}/`);}catch(error){throw new Error(`${error.message}: ${startupError.slice(0,1000)}`);}
  let state=await (await fetch(`${base}/api/bootstrap`)).json();
  assert.deepEqual(state.modelCatalog,[]);
  assert.deepEqual(state.harnessConnections,[]);
  assert.equal(state.harnesses.find((item)=>item.id==='opencode').installed,false,
    'a Windows npm shell shim is not accepted without the native OpenCode executable');
  assert.equal(state.harnesses.find((item)=>item.id==='opencode').authenticated,false);
  assert.equal(state.harnesses.find((item)=>item.id==='opencode').connected,false);

  const connected=await fetch(`${base}/api/harnesses/opencode`,{method:'POST'});
  assert.equal(connected.status,409);
  state=await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(state.harnesses.find((item)=>item.id==='opencode').connected,false);
  assert.deepEqual(state.modelCatalog,[]);
  assert.deepEqual(state.harnessConnections,[]);

  const disconnected=await fetch(`${base}/api/harnesses/opencode`,{method:'DELETE'});
  assert.equal(disconnected.status,404);
  state=await (await fetch(`${base}/api/bootstrap`)).json();
  assert.deepEqual(state.modelCatalog,[]);
  assert.deepEqual(state.harnessConnections,[]);
});
