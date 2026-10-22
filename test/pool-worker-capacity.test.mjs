import test from 'node:test';
import assert from 'node:assert/strict';
import {workerCapacity} from '../scripts/run-pool-workers.mjs';
const accounts=Array.from({length:5},(_,i)=>({accountId:String(i),planType:'free',status:'active',creditsBalance:500}));
const settings={proxyAccountResponseCreateLimit:4,proxyAccountStreamLimit:8,proxyAccountStreamRecoveryReserve:1};
test('20 useful jobs can be admitted across five funded Free accounts without an arbitrary six-worker cap',()=>{
 assert.equal(workerCapacity(accounts,settings,20,30).parallel,20);
 assert.equal(workerCapacity(accounts,settings,30,30).parallel,20);
 assert.equal(workerCapacity(accounts,settings,20,3).parallel,3);
});
test('unknown credits, subscriptions and rate-limited accounts cannot silently fund the Free-credit batch',()=>{
 const candidates=[...accounts,{accountId:'paid',planType:'plus',status:'active',creditsBalance:500},{accountId:'limited',planType:'free',status:'rate_limited',creditsBalance:500},{accountId:'unknown',planType:'free',status:'active',creditsBalance:null}];
 assert.equal(workerCapacity(candidates,settings,20,30).eligible.length,5);
 assert.throws(()=>workerCapacity(accounts,{},20,30),/metadata unavailable/);
 assert.equal(workerCapacity(accounts,{...settings,proxyAccountStreamLimit:1},20,30).parallel,0);
});
test('fresh batches account for existing singleton worker keys without counting unrelated clients',()=>{
 const existing=[...Array.from({length:4},(_,i)=>({name:`HexiGrid worker old-${i}`,accountAssignmentScopeEnabled:true,assignedAccountIds:['0']})),{name:'ordinary client',accountAssignmentScopeEnabled:true,assignedAccountIds:['1']}];
 const capacity=workerCapacity(accounts,settings,20,30,existing);
 assert.equal(capacity.parallel,16);
 assert.equal(capacity.reserved.get('0'),4);
 assert.equal(capacity.reserved.get('1'),0);
 assert.equal(workerCapacity(accounts,settings,20,30,accounts.flatMap(a=>Array.from({length:4},(_,i)=>({name:`HexiGrid worker ${a.accountId}-${i}`,accountAssignmentScopeEnabled:true,assignedAccountIds:[a.accountId]})))).parallel,0);
});
