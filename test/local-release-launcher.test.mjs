import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, copyFile, realpath, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {registerLocalRelease, activateLocalRelease, rollbackLocalRelease} from '../lib/local-releases.mjs';

const sourceRoot=path.resolve(import.meta.dirname,'..');
const powershell=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function launch(root,port){return new Promise(resolve=>{const p=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',path.join(root,'Start-Control-Room.ps1'),'-NoBrowser','-StartupTimeoutSeconds','10'],{windowsHide:true,env:{...process.env,HEXIGRID_PORT:String(port),HEXIGRID_DATA_DIR:''}});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('close',code=>resolve({code,out,err}));});}

test('stable Windows launcher starts selected releases and rollback with the same data folder', {skip:process.platform!=='win32',timeout:60000},async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hexigrid release qa ')));
  let ownedPid;
  try{
    await mkdir(path.join(root,'scripts'));await mkdir(path.join(root,'lib'));await mkdir(path.join(root,'data'));
    await writeFile(path.join(root,'package.json'),JSON.stringify({name:'hexigrid',version:'0.0.1'}));
    await writeFile(path.join(root,'server.mjs'),'// manager stub, never executed');
    for(const f of ['Start-Control-Room.ps1','scripts/manage-local-releases.mjs','lib/local-releases.mjs','lib/runtime-source.mjs'])await copyFile(path.join(sourceRoot,f),path.join(root,f));
    await writeFile(path.join(root,'data','owner-sentinel'),'unchanged synthetic owner data');
    for(const [id,version] of [['qa-a','1.0.0'],['qa-b','1.0.1']]){
      const release=path.join(root,'releases',id);
      for(const d of ['lib','public','node_modules'])await mkdir(path.join(release,d),{recursive:true});
      await writeFile(path.join(release,'package.json'),JSON.stringify({name:'hexigrid',version,engines:{node:'>=22'}}));
      await writeFile(path.join(release,'package-lock.json'),'{}');
      await copyFile(path.join(sourceRoot,'Start-Control-Room.ps1'),path.join(release,'Start-Control-Room.ps1'));
      await copyFile(path.join(sourceRoot,'lib/runtime-source.mjs'),path.join(release,'lib/runtime-source.mjs'));
      await writeFile(path.join(release,'server.mjs'),`import http from 'node:http';import crypto from 'node:crypto';import {mkdir,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import {runtimeSourceDigest} from './lib/runtime-source.mjs';const root=import.meta.dirname,data=process.env.HEXIGRID_DATA_DIR;const identity={product:'hexigrid',version:JSON.parse(await readFile(path.join(root,'package.json'))).version,instanceId:crypto.randomUUID(),pid:process.pid,port:Number(process.env.HEXIGRID_PORT),scheme:'http',sourceDigest:await runtimeSourceDigest(root)};await mkdir(data,{recursive:true});await writeFile(path.join(data,'.runtime.json'),JSON.stringify(identity));const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(identity));});server.listen(identity.port,'127.0.0.1');`);
      await registerLocalRelease({root,id,source:release});
    }
    const port=await freePort();
    await activateLocalRelease({root,id:'qa-a',confirm:true});
    for(const [id,version] of [['qa-a','1.0.0'],['qa-b','1.0.1'],['qa-a','1.0.0']]){
      if(id==='qa-b')await activateLocalRelease({root,id,confirm:true});
      else if(ownedPid===null)await rollbackLocalRelease({root,confirm:true});
      const result=await launch(root,port);assert.equal(result.code,0,result.err);assert.match(result.out,/HexiGrid verified/);
      const identity=JSON.parse(await readFile(path.join(root,'data','.runtime.json'),'utf8'));ownedPid=identity.pid;
      assert.equal(identity.version,version);assert.equal(await readFile(path.join(root,'data','owner-sentinel'),'utf8'),'unchanged synthetic owner data');
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/system/identity`)).status,200);
      assert.equal(await readFile(path.join(root,'releases',id,'package.json'),'utf8').then(JSON.parse).then(x=>x.version),version);
      process.kill(ownedPid);ownedPid=null;
      for(let i=0;i<40;i++){try{await fetch(`http://127.0.0.1:${port}/api/system/identity`,{signal:AbortSignal.timeout(200)});await new Promise(r=>setTimeout(r,50));}catch{break;}}
    }
  }finally{
    if(ownedPid)try{process.kill(ownedPid);}catch{}
    const resolved=await realpath(root);assert.ok(resolved.startsWith(await realpath(os.tmpdir())) && path.basename(resolved).startsWith('hexigrid release qa '));
    await rm(resolved,{recursive:true,force:true});
  }
});
