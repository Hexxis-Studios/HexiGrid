import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleHexiSpaceRequest } from '../lib/hexispace-routes.mjs';

const profileId='10000000-0000-4000-8000-000000000001';
const browserToken='disposable-browser-token';
const socialToken=`hss_${'a'.repeat(64)}`;
function fixture() {
  const target={linkId:'qa-browser',profileId,agentId:'qa-agent',agentLinkId:'qa-agent-link',vaultRef:'target-vault',supabaseUrl:'https://qa.supabase.co',anonKey:'sb_publishable_test',capabilities:['react']};
  const other={...target,linkId:'original-browser',vaultRef:'original-vault',capabilities:['manage_friends']};
  const state={hexispace:{links:[{id:'qa-browser',status:'connected',expiresAt:new Date(Date.now()+60000).toISOString(),scopes:['agent_reactions'],tokenHash:crypto.createHash('sha256').update(browserToken).digest('base64url')}],agentSocials:[other,target]}};
  const removed=[];let response;
  const ctx={state,pathname:'/api/hexispace/v1/agent-socials/detach',method:'POST',url:new URL('http://localhost/api/hexispace/v1/agent-socials/detach'),
    isTunnelRequest:()=>false,networkGate:()=>false,readBody:async()=>({profileId}),cleanString:s=>String(s||''),addReceipt:()=>{},saveState:async()=>{},
    credentialVault:{get:async ref=>{assert.equal(ref,'target-vault');return socialToken;},remove:async ref=>removed.push(ref)},json:(_res,status,body)=>{response={status,body};}};
  return {state,ctx,removed,result:()=>response};
}

test('browser social detach revokes only its token and preserves the other browser mapping',async()=>{
  const f=fixture(),originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    assert.equal(url,'https://qa.supabase.co/rest/v1/rpc/revoke_hexonaut_social_token_by_value');
    assert.deepEqual(JSON.parse(init.body),{p_token:socialToken});
    assert.deepEqual(f.removed,[]);
    return new Response('true');
  };
  try {
    await handleHexiSpaceRequest({headers:{authorization:`Bearer ${browserToken}`}}, {},f.ctx);
    assert.equal(f.result().status,200);assert.deepEqual(f.removed,['target-vault']);
    assert.equal(f.state.hexispace.agentSocials.length,1);
    assert.equal(f.state.hexispace.agentSocials[0].linkId,'original-browser');
  } finally {globalThis.fetch=originalFetch;}
});

test('failed remote social revocation retains the credential and mapping for a retry',async()=>{
  const f=fixture(),originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('{}',{status:503});
  try {
    await handleHexiSpaceRequest({headers:{authorization:`Bearer ${browserToken}`}}, {},f.ctx);
    assert.equal(f.result().status,400);assert.deepEqual(f.removed,[]);
    assert.equal(f.state.hexispace.agentSocials.length,2);
    assert.doesNotMatch(JSON.stringify(f.result()),new RegExp(socialToken));
  } finally {globalThis.fetch=originalFetch;}
});
