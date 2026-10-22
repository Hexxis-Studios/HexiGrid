import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Optional development orchestration, not a background service or a core paid dependency.
export function workerCapacity(accounts, settings, requested, jobs, existingKeys = []) {
  if (!Number.isSafeInteger(requested) || requested < 1) throw Error('Choose a positive integer worker count.');
  const eligible = accounts.filter(a => a.planType === 'free' && a.status === 'active' && Number.isFinite(a.creditsBalance) && a.creditsBalance > 0);
  const create = settings.proxyAccountResponseCreateLimit;
  const streams = settings.proxyAccountStreamLimit;
  const reserve = settings.proxyAccountStreamRecoveryReserve;
  if (![create, streams, reserve].every(v => Number.isSafeInteger(v) && v >= 0)) throw Error('Pool concurrency metadata unavailable.');
  const perAccount = Math.min(create || Infinity, streams ? Math.max(0, streams - reserve) : Infinity);
  const reserved = new Map(eligible.map(a => [a.accountId, 0]));
  for (const key of existingKeys) {
    if (!key.name?.startsWith('HexiGrid worker ') || !key.accountAssignmentScopeEnabled || key.assignedAccountIds?.length !== 1) continue;
    const account = key.assignedAccountIds[0];
    if (reserved.has(account)) reserved.set(account, reserved.get(account) + 1);
  }
  const available = eligible.reduce((total, a) => total + Math.max(0, perAccount - reserved.get(a.accountId)), 0);
  const parallel = Math.min(requested, jobs, available);
  return { eligible, perAccount, reserved, parallel: Number.isFinite(parallel) ? parallel : Math.min(requested, jobs) };
}

async function main() {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--jobs') || !args.includes('--parallel')) throw Error('Use --jobs <local JSON file> --parallel <count> [--dry-run].');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const jobs = JSON.parse(await readFile(path.resolve(value('--jobs')), 'utf8'));
  if (!Array.isArray(jobs) || !jobs.length || jobs.some(j => !/^[a-z0-9-]{1,60}$/.test(j.name || '') || typeof j.prompt !== 'string' || !j.prompt.trim() || j.prompt.length > 16000)) throw Error('Jobs require unique short names and bounded technical prompts.');
  if (new Set(jobs.map(j=>j.name)).size !== jobs.length) throw Error('Job names must be unique.');
  const base = 'http://127.0.0.1:2455';
  const api = async (suffix, options={}) => { const r=await fetch(base+suffix,{...options,redirect:'error',signal:AbortSignal.timeout(10000)}); if(!r.ok)throw Error(`Pool request failed (${r.status}).`); return r.status===204 ? null : r.json(); };
  const [{accounts},settings,existingKeys] = await Promise.all([api('/api/accounts'),api('/api/settings'),api('/api/api-keys')]);
  const capacity = workerCapacity(accounts,settings,Number(value('--parallel')),jobs.length,existingKeys);
  console.log(JSON.stringify({eligibleFreeCreditAccounts:capacity.eligible.length,configuredWorkersPerAccount:capacity.perAccount,requested:Number(value('--parallel')),admitted:capacity.parallel}));
  if(args.includes('--dry-run')) return;
  if(!capacity.parallel)throw Error('No eligible Free-credit account capacity.');
  // Never send paid inference when a restarted original engine would ignore key assignments.
  const gate=await fetch(base+'/backend-api/codex/models',{headers:{'x-hexigrid-pool-worker':'1'},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(gate.status!==401)throw Error('Authenticated worker adapter is not loaded; refusing unpinned inference.');
  const out=path.join(root,'data','pool-workers',`${Date.now()}-${randomUUID().slice(0,8)}`);
  await mkdir(out,{recursive:true});
  const codex=path.join(process.env.LOCALAPPDATA,'Programs','OpenAI','Codex','bin','codex.exe');
  // Existing batches reserve slots conservatively for this batch's lifetime.
  // This is fairness accounting; upstream admission remains authoritative.
  const loads=new Map(capacity.reserved);
  const pending=[...jobs], active=new Set(), receipts=[];
  const rules='Work only in this disposable tracked-source copy. Follow AGENTS.md. Never access private data, credentials, environment secrets, live stores or other projects; never use the browser, network, install tools, commit/push, stop/start apps or services, or change real settings. Use only focused necessary tests, not blanket rescans. Stay within the explicitly assigned files. Return at most 200 words: changed files, test results, blockers. Completion means actual artifacts, not exit code. ';
  const run=async(job,account)=>{
    let key;
    try {
      const dir=path.join(out,job.name),archive=path.join(out,job.name+'.tar'); await mkdir(dir);
      for(const [command,a] of [['git',['archive','--format=tar','-o',archive,'HEAD']],['tar',['-xf',archive,'-C',dir]]]){
        const r=spawnSync(command,a,{cwd:root,windowsHide:true,stdio:'ignore'});if(r.status!==0)throw Error('Tracked source snapshot failed.');
      }
      key=await api('/api/api-keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'HexiGrid worker '+job.name,assignedAccountIds:[account.accountId],allowedModels:['gpt-6-luna'],enforcedModel:'gpt-6-luna',enforcedReasoningEffort:'max',expiresAt:new Date(Date.now()+3600000).toISOString()})});
      if(!key.accountAssignmentScopeEnabled || key.assignedAccountIds?.length!==1 || key.assignedAccountIds[0]!==account.accountId)throw Error('Worker account restriction not established.');
      const cli=['exec','--ignore-user-config','--ephemeral','--json','--dangerously-bypass-approvals-and-sandbox','--skip-git-repo-check','--model','gpt-6-luna','-c','model_reasoning_effort="max"','-c','model_provider="hexigrid_pool"','-c','model_providers.hexigrid_pool.name="openai"','-c',`model_providers.hexigrid_pool.base_url="${base}/backend-api/codex"`,'-c','model_providers.hexigrid_pool.wire_api="responses"','-c','model_providers.hexigrid_pool.env_key="HEXIGRID_WORKER_KEY"','-c','model_providers.hexigrid_pool.requires_openai_auth=false','-c','model_providers.hexigrid_pool.http_headers={"x-hexigrid-pool-worker"="1"}','-c','web_search="disabled"',rules+job.prompt];
      const child=spawn(codex,cli,{cwd:dir,windowsHide:true,env:{...process.env,HEXIGRID_WORKER_KEY:key.key},stdio:['ignore','pipe','ignore']});
      let buffer='',answer='',complete=false;
      child.stdout.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){try{const e=JSON.parse(line);if(e.type==='turn.completed')complete=true;if(e.type==='item.completed'&&e.item?.type==='agent_message')answer=e.item.text;}catch{}}if(buffer.length>2097152)buffer='';});
      console.log(JSON.stringify({worker:job.name,status:'started',accountRestricted:true,model:'gpt-6-luna',effort:'max'}));
      const timer=setTimeout(()=>child.kill(),20*60*1000); // Only this owned CLI process, never a process-name/tree kill.
      const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);}).finally(()=>clearTimeout(timer));
      const rows=await api('/api/api-keys'),usage=rows.find(k=>k.id===key.id)?.usageSummary;
      const receipt={worker:job.name,exit,turnCompleted:complete,accountRestricted:true,assignedCount:1,usage};
      receipts.push(receipt);await writeFile(path.join(dir,'WORKER-RESULT.txt'),answer,'utf8');console.log(JSON.stringify({worker:job.name,status:'exited',exit,turnCompleted:complete}));
    } catch(error) {receipts.push({worker:job.name,error:error.message}); console.log(JSON.stringify({worker:job.name,status:'failed',error:error.message}));}
    finally {
      if(key){try{await api('/api/api-keys/'+key.id,{method:'DELETE'});}catch{console.log(JSON.stringify({worker:job.name,status:'key-revocation-failed',expiresWithinOneHour:true}));}}
      loads.set(account.accountId,loads.get(account.accountId)-1);
      await writeFile(path.join(out,'RECEIPTS.json'),JSON.stringify(receipts,null,2),'utf8');
    }
  };
  while(pending.length||active.size){
    while(pending.length&&active.size<capacity.parallel){
      const account=capacity.eligible.filter(a=>loads.get(a.accountId)<capacity.perAccount).sort((a,b)=>loads.get(a.accountId)-loads.get(b.accountId))[0];if(!account)break;
      loads.set(account.accountId,loads.get(account.accountId)+1);const promise=run(pending.shift(),account).finally(()=>active.delete(promise));active.add(promise);
    }
    if(active.size)await Promise.race(active);else if(pending.length)throw Error('No usable worker slot.');
  }
  console.log(JSON.stringify({batch:'finished',jobs:receipts.length,results:path.relative(root,out),automaticIntegration:false}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
