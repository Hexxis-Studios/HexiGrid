import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { normalizeCompanionRelayOrigin } from '../lib/companion-client.mjs';

const source = await fs.readFile(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function validConnectionId('), source.indexOf('function output('));
const pair = source.slice(source.indexOf('async function pair('), source.indexOf('async function openSaved('));
const forget = source.slice(source.indexOf("  if (commandName === 'forget')"), source.indexOf("\n  output({ ok: false, error: 'Commands:"));
const token = 'p'.repeat(43); // Public synthetic fixture only.

async function fixture(t, { unavailable = false, failSave = false, failRouting = false, failRoutingProbe = false, rawValues = false, normalizeJson = false, ilandsEnvelope = false, rejectCredentialLikeAliases = false, pairingId = 'link-storage-qa' } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-storage-check-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const vault = new Map(), reports = [], probeAliases = new Set();
  let constructed = 0, closed = 0;
  const context = { fs, path, crypto, isDeepStrictEqual, CAPABILITIES: ['camera-view'], normalizeCompanionRelayOrigin, CONFIG_DIR: path.join(home, '.hexigrid-link'), VAULT_DIR: path.join(home, '.hexigrid-link', 'vault'),
    process: { env: { HEXIGRID_LINK_SECRET_COMMAND: '["supported-vault"]' }, platform: process.platform, pid: process.pid, exitCode: 0 },
    requireFlag: (flags, name) => flags[name], output: value => reports.push(value),
    spawnSync(command, args, options) {
      assert.equal(command, 'supported-vault'); assert.equal(options.shell, false);
      assert.equal(args.includes(token), false, 'credentials never travel in process arguments');
      if (unavailable) return { error: { code: 'ENOENT' } };
      const operation = args[0], alias = args.find(arg => arg.startsWith('--alias=')).slice(8);
      if (operation === 'put' && rejectCredentialLikeAliases && /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(alias)) return {status:1,stdout:'',stderr:'alias must not itself look like a credential'};
      if (operation === 'revoke') { vault.delete(alias); return { status: 0, stdout: '' }; }
      if (args.includes('--usage-hint=Disposable connection-storage check')) probeAliases.add(alias);
      const probe = probeAliases.has(alias);
      if (failSave && !probe) return { status: 1, stderr: 'PRIVATE-PROVIDER-DIAGNOSTIC' };
      if ((failRouting && !probe || failRoutingProbe && probe) && (alias.startsWith('hexigrid-link-routing-') || alias.startsWith('hexigrid-link.routing.'))) return { status: 1, stderr: 'PRIVATE-PROVIDER-DIAGNOSTIC' };
      if (operation === 'put') { vault.set(alias, options.input); return { status: 0, stdout: '' }; }
      if (ilandsEnvelope) return { status: 0, stdout: JSON.stringify({ content: [{ type: 'text', text: 'Human-readable secret-store summary' }], details: { status: vault.has(alias) ? 'retrieved' : 'not_found', alias, ...(vault.has(alias) ? { payload: { value: vault.get(alias) } } : {}) } }) };
      if (normalizeJson && vault.get(alias)?.startsWith('{')) return {status:0, stdout:JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(vault.get(alias))).reverse()),null,2)};
      return vault.has(alias) ? { status: 0, stdout: rawValues ? vault.get(alias) : JSON.stringify({ secret: { value: vault.get(alias) } }) } : { status: 1, stderr: 'PRIVATE-PROVIDER-DIAGNOSTIC' };
    },
    OutboundCompanionConnection: class {
      constructor() { constructed++; this.invitation = { origin: 'https://example.test', inviteId: 'invite-qa', deviceId: 'owner-device-qa' }; this.clientDeviceId = 'client-device-qa'; }
      async connect() { return { peerId: 'peer-qa' }; }
      async pair() { return { connection: { id: pairingId, capabilities: ['camera-view'] }, token, orientation: {} }; }
      async close() { closed++; }
    }
  };
  vm.createContext(context); vm.runInContext(functions + pair + `async function forgetSaved(flags) { const commandName='forget'; ${forget} }`, context);
  return { context, vault, reports, home, constructed: () => constructed, closed: () => closed };
}

test('rebuilt agent home restores exact credential, routing and cursors from the platform vault', async t => {
  for (const rawValues of [false, true]) {
    const f = await fixture(t, { rawValues });
    assert.equal(await f.context.checkStorage({ ephemeral: true }), 'platform-vault');
    assert.equal(f.vault.size, 0, 'storage probe is removed');
    const record = { connectionId: 'link-storage-qa', mode: 'outbound-companion', storage: 'platform-vault', origin: 'https://example.test', tokenAlias: 'hexigrid-link-link-storage-qa', inviteId: 'invite-qa', deviceId: 'owner-device-qa', clientDeviceId: 'unchanged-client-device', lastSequence: 17 };
    await f.context.saveToken(record.tokenAlias, token, true);
    await f.context.writeConfig(record);
    const cache = await fs.readFile(path.join(f.home, '.hexigrid-link', 'link-storage-qa.json'), 'utf8').catch(() => '');
    assert.equal(cache.includes(token), false, 'optional routing cache contains no credential');
    assert.equal(f.vault.get('hexigrid-link-routing-link-storage-qa').includes(token), false);
    await fs.rm(path.join(f.home, '.hexigrid-link'), { recursive: true, force: true });
    const restored = await f.context.readConfig(record.connectionId);
    assert.deepEqual(JSON.parse(JSON.stringify(restored)), record);
    assert.equal(await f.context.getSecret(restored.tokenAlias), token);
    f.vault.set('hexigrid-link-routing-link-storage-qa', JSON.stringify({ ...record, connectionId: 'link-other-agent' }));
    await assert.rejects(f.context.readConfig(record.connectionId), /No readable saved connection/);
    f.vault.set('hexigrid-link-routing-link-storage-qa',JSON.stringify(record));
    await f.context.forgetSaved({connection:record.connectionId});assert.equal(f.vault.size,0,'legacy token and routing are forgotten together');
  }
});

test('ephemeral runtime without a supported durable store stops before consuming any invitation', async t => {
  const f = await fixture(t, { unavailable: true });
  await assert.rejects(f.context.pair({ invite: 'synthetic-invite', name: 'QA', ephemeral: true }), /invitation has not been used/);
  assert.equal(f.constructed(), 0);
  assert.equal(f.reports.length, 0);
  assert.equal(await f.context.checkStorage({}), 'private-local-profile', 'a persistent local runtime keeps its supported existing path');
  const badReadback = await fixture(t);
  badReadback.context.spawnSync = () => ({ status: 0, stdout: 'unretained-probe' });
  await assert.rejects(badReadback.context.pair({ invite: 'synthetic-invite', name: 'QA', ephemeral: true }), /failed its storage check/);
  assert.equal(badReadback.constructed(), 0, 'failed readback also leaves the invitation unused');
  const routingProbe = await fixture(t, { failRoutingProbe: true });
  await assert.rejects(routingProbe.context.pair({ invite: 'synthetic-invite', name: 'QA', framework: 'iLands' }), error => error.stage === 'routing-write' && error.operation === 'put' && error.code === 'SECRET_STORE_OPERATION_FAILED');
  assert.equal(routingProbe.constructed(), 0, 'a vault that stores tokens but refuses routing must be rejected before pairing');
  for (const framework of ['iLands', 'ilands app', 'i-Lands']) {
    const automatic = await fixture(t, { unavailable: true });
    await assert.rejects(automatic.context.pair({ invite: 'synthetic-invite', name: 'QA', framework }), /invitation has not been used/);
    assert.equal(automatic.constructed(), 0, 'an iLands agent cannot accidentally fall back to disposable files by omitting --ephemeral');
  }
});

test('pairing reports success only after both vault saves pass readback and never emits credentials', async t => {
  const good = await fixture(t);
  await good.context.pair({ invite: 'synthetic-invite', name: 'QA', framework: 'custom', ephemeral: true });
  assert.equal(good.reports[0].saved, true);
  assert.equal(good.reports[0].storage, 'platform-vault');
  assert.equal(good.vault.has(good.context.routingAlias('link-storage-qa')), true);
  assert.equal(JSON.stringify(good.reports).includes(token), false);
  const broken = await fixture(t, { failSave: true });
  await broken.context.pair({ invite: 'synthetic-invite', name: 'QA', ephemeral: true });
  assert.equal(broken.reports[0].paired, true);
  assert.equal(broken.reports[0].saved, false);
  assert.equal(broken.reports[0].code, 'CREDENTIAL_SAVE_FAILED');
  assert.equal(broken.context.process.exitCode, 1);
  assert.equal(broken.closed(), 1);
  assert.doesNotMatch(JSON.stringify(broken.reports), /PRIVATE-PROVIDER-DIAGNOSTIC|pppppppppp/);
  await assert.rejects(good.context.writeConfig({ connectionId: 'link-storage-qa', token }), /cannot be written/);
  const routing = await fixture(t, { failRouting: true });
  await routing.context.pair({ invite: 'synthetic-invite', name: 'QA', framework: 'iLands' });
  assert.equal(routing.reports[0].code, 'ROUTING_SAVE_FAILED');
  assert.equal(routing.reports[0].saved, false);
  assert.equal(routing.reports[0].storage, 'platform-vault');
  assert.equal(JSON.stringify(routing.reports).includes(token), false);
  const normalized = await fixture(t, { normalizeJson: true });
  await normalized.context.pair({ invite: 'synthetic-invite', name: 'QA', framework: 'iLands' });
  assert.equal(normalized.reports[0].saved, true, 'equivalent JSON formatting is not a failed routing save');
});

test('storage status distinguishes unreadable routing from unreadable credential without mutating or exposing either', async t => {
  const f = await fixture(t);
  const connectionId = 'link-storage-qa';
  const status = () => f.context.connectionStorageStatus(connectionId);
  const assertSafe = result => { assert.doesNotMatch(JSON.stringify(result), /pppppppppp|PRIVATE-PROVIDER/); assert.equal(result.invitationUsed, false); assert.equal(f.constructed(), 0); };
  let result = await status(); assert.equal(result.code, 'CONNECTION_STORAGE_UNREADABLE'); assertSafe(result);
  await f.context.saveToken(`hexigrid-link-${connectionId}`, token, true);
  result = await status(); assert.equal(result.code, 'ROUTING_STORAGE_UNREADABLE'); assert.equal(result.credentialReadable, true); assertSafe(result);
  await f.context.writeConfig({ connectionId, mode: 'outbound-companion', storage: 'platform-vault', origin: 'https://example.test', tokenAlias: `hexigrid-link-${connectionId}` });
  await fs.rm(path.join(f.home, '.hexigrid-link'), { recursive: true, force: true });
  const before = [...f.vault.entries()];
  result = await status(); assert.equal(result.code, 'SAVED_CONNECTION_READABLE'); assert.equal(result.ok, true); assertSafe(result);
  assert.deepEqual([...f.vault.entries()], before); assert.equal(await fs.stat(path.join(f.home, '.hexigrid-link')).catch(()=>null), null);
  f.vault.delete(`hexigrid-link-${connectionId}`);
  result = await status(); assert.equal(result.code, 'CREDENTIAL_STORAGE_UNREADABLE'); assert.equal(result.routingReadable, true); assertSafe(result);
});

test('reported iLands details.payload.value envelope supports pair, readback and sandbox reset without parsing display text', async t => {
  const f = await fixture(t, { ilandsEnvelope: true });
  await f.context.pair({ invite: 'synthetic-invite', name: 'QA', framework: 'iLands', ephemeral: true });
  assert.equal(f.reports[0].saved, true);
  await fs.rm(path.join(f.home, '.hexigrid-link'), { recursive: true, force: true });
  const record = await f.context.readConfig('link-storage-qa');
  assert.equal(await f.context.getSecret(record.tokenAlias), token);
  assert.equal((await f.context.connectionStorageStatus('link-storage-qa')).code, 'SAVED_CONNECTION_READABLE');
  assert.doesNotMatch(JSON.stringify(f.reports), /pppppppppp|Human-readable secret-store summary/);
  for (const details of [{ status: 'not_found' }, { status: 'retrieved', payload: { value: null } }, { status: 'retrieved', payload: { value: {} } }, { status: 'not_found', payload: { value: token } }]) {
    assert.throws(() => f.context.extractSecretValue(JSON.stringify({ content: [{ type: 'text', text: token }], details })), /not supported/);
  }
  assert.throws(() => f.context.extractSecretValue(JSON.stringify({ isError: true, details: { status: 'retrieved', payload: { value: token } } })), /not supported/);
});

test('provider-neutral labels survive credential-like alias rejection, preserve reset recovery and isolate connections', async t => {
  const ids=['link-11111111-2222-4333-8444-555555555555','link-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'];
  const a=await fixture(t,{pairingId:ids[0],rejectCredentialLikeAliases:true,ilandsEnvelope:true});
  const b=await fixture(t,{pairingId:ids[1]});
  assert.equal(a.context.aliasLabel(ids[0]),'he.in.of.an.an.if.me.my.of.do.an.is.he.me.is.by.my.is.be.is.an.my.in.it.me.go.it.be.it.no.go.on','shared Node/Python label fixture');
  b.context.spawnSync=a.context.spawnSync;
  assert.throws(()=>a.context.secretCli(['put',`--alias=hexigrid-link-${ids[0]}`],token),/could not complete/,'reproduces the reported UUID-alias rejection');
  await a.context.pair({invite:'synthetic-invite',name:'QA',framework:'iLands',ephemeral:true});
  await b.context.pair({invite:'synthetic-invite',name:'QA',framework:'other-provider',ephemeral:true});
  assert.equal(a.reports[0].saved,true);assert.equal(b.reports[0].saved,true);
  const records=[];
  for(const [f,id] of [[a,ids[0]],[b,ids[1]]]){
    await fs.rm(path.join(f.home,'.hexigrid-link'),{recursive:true,force:true});
    const record=await f.context.readConfig(id);records.push(record);
    assert.equal(await f.context.getSecret(record.tokenAlias),token);
    assert.equal((await f.context.connectionStorageStatus(id)).code,'SAVED_CONNECTION_READABLE');
    for(const alias of [record.tokenAlias,f.context.routingAlias(id)]){
      assert.ok(alias.length<=128);assert.match(alias,/^hexigrid-link\.(token|routing)\.(?:[a-z]{2}\.){31}[a-z]{2}$/);
      assert.equal(alias.includes(id),false);assert.equal(alias.includes(token),false);
    }
  }
  assert.notEqual(records[0].tokenAlias,records[1].tokenAlias);
  a.vault.set(a.context.routingAlias(ids[0]),JSON.stringify({...records[0],tokenAlias:records[1].tokenAlias}));
  await assert.rejects(a.context.readConfig(ids[0]),/No readable saved connection/,'another connection credential alias cannot be substituted');
  a.vault.set(a.context.routingAlias(ids[0]),JSON.stringify(records[0]));
  await a.context.forgetSaved({connection:ids[0]});
  assert.equal(a.vault.has(records[0].tokenAlias),false);assert.equal(a.vault.has(a.context.routingAlias(ids[0])),false);
  assert.equal(a.vault.has(records[1].tokenAlias),true);assert.equal(a.vault.has(a.context.routingAlias(ids[1])),true);
});
