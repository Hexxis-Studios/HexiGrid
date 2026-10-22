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
