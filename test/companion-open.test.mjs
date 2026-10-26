import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';
const resume={origin:'https://relay.example.test',inviteId:'synthetic-invite',deviceId:'synthetic-device'};

test('resume accepts the advertised companion endpoint without duplicating its path or changing identity',async()=>{
  for(const address of [resume.origin,resume.origin+'/',resume.origin+'/relay/v1/companion',resume.origin+'/relay/v1/companion/']){
    let calls=0;
    const c=new OutboundCompanionConnection({resume:{...resume,origin:address},automaticControl:false,fetchFn:async(url,init)=>{
      calls++;assert.equal(url,resume.origin+'/relay/v1/companion/open');
      const body=JSON.parse(init.body);assert.equal(body.inviteId,resume.inviteId);assert.equal(body.deviceId,resume.deviceId);
      return new Response(JSON.stringify({peerId:'synthetic-peer',token:'synthetic-session'}),{status:201});
    }});
    assert.equal((await c.openSession()).peerId,'synthetic-peer');assert.equal(calls,1);
  }
});

test('ambiguous or credential-bearing resume URLs fail before network access without echoing them',()=>{
  for(const origin of ['http://relay.example.test','ftp://relay.example.test','https://relay.example.test/private',
    'https://SECRET-MARKER@relay.example.test','https://relay.example.test?token=SECRET-MARKER','https://relay.example.test#SECRET-MARKER']){
    assert.throws(()=>new OutboundCompanionConnection({resume:{...resume,origin},fetchFn:()=>{throw Error('Must not fetch');}}),error=>{
      assert.doesNotMatch(error.message,/SECRET-MARKER/);return /relay origin|companion endpoint/.test(error.message);
    });
  }
});

test('a real nonresponding companion open is aborted within the configured handshake deadline',async()=>{
  const server=http.createServer(()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const c=new OutboundCompanionConnection({resume:{...resume,origin:'http://127.0.0.1:'+server.address().port+'/relay/v1/companion'},requestTimeoutMs:100});
    const start=Date.now();await assert.rejects(c.openSession(),error=>['TimeoutError','AbortError'].includes(error.name));
    assert.ok(Date.now()-start<2000,'Handshake must stop instead of waiting indefinitely');
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('real set-origin CLI refuses a credential-bearing URL before reading or changing saved configuration',()=>{
  const script=fileURLToPath(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,'set-origin','--connection','link-synthetic-unused','--origin','https://SECRET-MARKER@relay.example.test'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,1);assert.match(result.stderr,/without credentials/);
  assert.doesNotMatch(result.stdout+result.stderr,/SECRET-MARKER|ENOENT/);
});
test('real storage-status CLI reports unreadability as safe JSON without opening a companion',()=>{
  const script=fileURLToPath(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,'storage-status','--connection','link-public-synthetic-unconfigured'],{
    encoding:'utf8',windowsHide:true,env:{...process.env,HEXIGRID_LINK_SECRET_COMMAND:JSON.stringify([process.execPath,'-e','process.exit(1)'])}
  });
  assert.equal(result.status,0,result.stderr);const body=JSON.parse(result.stdout);
  assert.equal(body.code,'CONNECTION_STORAGE_UNREADABLE');assert.equal(body.credentialReadable,false);
  assert.equal(body.routingReadable,false);assert.equal(body.invitationUsed,false);
});
test('real storage-check identifies the failed protected operation without leaking helper output or consuming an invitation',()=>{
  const script=fileURLToPath(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,'storage-check','--ephemeral'],{
    encoding:'utf8',windowsHide:true,env:{...process.env,HEXIGRID_LINK_SECRET_COMMAND:JSON.stringify([process.execPath,'-e',"process.stderr.write('PRIVATE-PROVIDER-DIAGNOSTIC');process.exit(7)"])}
  });
  assert.equal(result.status,1);const body=JSON.parse(result.stdout);
  assert.equal(body.code,'SECRET_STORE_OPERATION_FAILED');assert.equal(body.stage,'credential-write');
  assert.equal(body.operation,'put');assert.equal(body.exitCode,7);assert.equal(body.invitationUsed,false);
  assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE-PROVIDER-DIAGNOSTIC/);
});

test('imported storage check retains the actual failed helper output privately without running the CLI',()=>{
  const script=new URL('../integrations/hexigrid-link/scripts/companion_client.mjs',import.meta.url).href;
  const code=`
    import assert from 'node:assert/strict';
    import {inspect} from 'node:util';
    const {checkStorage}=await import(process.argv[1]);
    try {await checkStorage({ephemeral:true});assert.fail('Expected helper failure');}
    catch(error){
      assert.equal(error.code,'SECRET_STORE_OPERATION_FAILED');
      assert.equal(error.stage,'credential-write');assert.equal(error.exitCode,7);
      assert.equal(error.providerDiagnostic.stderr,'PRIVATE-PROVIDER-DIAGNOSTIC');
      assert.equal(error.providerDiagnostic.stdout,'PRIVATE-HELPER-OUTPUT');
      assert.equal(Object.keys(error).includes('providerDiagnostic'),false);
      assert.doesNotMatch(JSON.stringify(error)+inspect(error),/PRIVATE-PROVIDER-DIAGNOSTIC|PRIVATE-HELPER-OUTPUT/);
    }`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code,script],{
    encoding:'utf8',windowsHide:true,env:{...process.env,HEXIGRID_LINK_SECRET_COMMAND:JSON.stringify([process.execPath,'-e',"process.stdout.write('PRIVATE-HELPER-OUTPUT');process.stderr.write('PRIVATE-PROVIDER-DIAGNOSTIC');process.exit(7)"])}
  });
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});
