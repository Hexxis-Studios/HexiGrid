import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {evaluatePolicy} from '../lib/policy.mjs';
import {readAgentLinkWorkspaceFile,writeAgentLinkWorkspaceFile} from '../lib/agent-link-workspace.mjs';

test('actual owner file handlers enforce mode, return saved digests and preserve changed bytes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hexigrid-owner-workspace-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
 const routes=source.slice(source.indexOf('  if (method === "GET" && pathname === "/api/workspace/file")'),source.indexOf('  if (method === "POST" && pathname === "/api/workspace/command")'));
 const receipts=[];let body;
 const ctx=vm.createContext({state:{settings:{approvalPolicy:'full',workMode:'connect'}},req:{},res:{},pathname:'/api/workspace/file',method:'PUT',Buffer,
  WORKSPACE_DIR:root,cleanString:value=>String(value || ''),readBody:async()=>body,evaluatePolicy,readAgentLinkWorkspaceFile,writeAgentLinkWorkspaceFile,
  safeWorkspacePath:value=>path.join(root,value.replace(/^\/+/,'')),relativeWorkspacePath:value=>'/'+path.relative(root,value).replace(/\\/g,'/'),
  addActivity(){},addReceipt:value=>receipts.push(value),saveState:async()=>{},json:(_res,status,value)=>({status,value})});
 const run=()=>vm.runInContext(`(async()=>{${routes}})()`,ctx);
 body={path:'/qa/test.txt',content:'first',createOnly:true};assert.equal((await run()).status,403);
 ctx.state.settings.workMode='build';const saved=await run();assert.equal(saved.status,200);assert.match(saved.value.sha256,/^[a-f0-9]{64}$/);
 ctx.method='GET';ctx.url=new URL('http://localhost/api/workspace/file?path=/qa/test.txt');const opened=await run();assert.equal(opened.value.sha256,saved.value.sha256);
 await writeAgentLinkWorkspaceFile(root,{path:'qa/test.txt',text:'agent edit',expectedSha256:saved.value.sha256});
 ctx.method='PUT';body={path:'/qa/test.txt',content:'stale',expectedSha256:saved.value.sha256};const conflict=await run();assert.equal(conflict.status,409);assert.equal(conflict.value.code,'workspace_file_changed');
 assert.equal(await readFile(path.join(root,'qa/test.txt'),'utf8'),'agent edit');assert.equal(receipts.length,1);
});
