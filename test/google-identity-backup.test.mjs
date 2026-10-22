import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Expected source section between ${startMarker} and ${endMarker}`);
  return source.slice(start, end);
}

function sourceLine(source, marker) {
  const start = source.indexOf(marker);
  const end = source.indexOf('\n', start);
  assert.ok(start >= 0 && end > start, `Expected source declaration ${marker}`);
  return source.slice(start, end).trimEnd();
}

const serverSource = readSource('../server.mjs');
const googleRoute = between(
  serverSource,
  "  if (method === 'POST' && pathname === '/api/auth/google/firebase') {",
  "  if (method === 'POST' && pathname === '/api/auth/recover') {",
);

function routeHarness(sync) {
  const state = { settings: { auth: {}, sync } };
  const receipts = [];
  let authenticated = false;
  let saves = 0;
  const context = {
    method: 'POST',
    pathname: '/api/auth/google/firebase',
    req: {},
    res: {},
    state,
    loginLimit: () => ({ blocked: false, retryAfter: 0 }),
    readBody: async () => ({ idToken: 'fixture-firebase-id-token' }),
    verifyFirebaseIdToken: async (idToken) => {
      assert.equal(idToken, 'fixture-firebase-id-token');
      return { subject: 'fixture-google-subject', email: 'owner@example.test', name: 'Fixture Owner' };
    },
    authStatus: () => ({ configured: Boolean(state.settings.auth.configured), authenticated }),
    safeEqual: (left, right) => left === right,
    recordLoginFailure: () => ({ blocked: false, retryAfter: 0 }),
    clearLoginFailures: () => {},
    addReceipt: (receipt) => receipts.push(receipt),
    addActivity: () => {},
    saveState: async () => { saves += 1; },
    startOrRefreshSession: () => { authenticated = true; return 'fixture-session'; },
    json: (_res, status, payload, headers) => ({ status, payload, headers }),
  };
  const invoke = runInNewContext(`(async function invokeGoogleIdentityRoute() {\n${googleRoute}\n})`, context);
  return { invoke, state, receipts, get saves() { return saves; } };
}

test('first and repeated Google identity login preserve disabled sync and record identity only', async () => {
  const sync = { enabled: false, provider: 'google-drive', status: 'not_configured', encrypted: true, lastSyncAt: null };
  const originalSync = structuredClone(sync);
  const harness = routeHarness(sync);

  const first = await harness.invoke();
  assert.equal(first.status, 200);
  assert.equal(first.payload.auth.authenticated, true);
  assert.strictEqual(harness.state.settings.sync, sync);
  assert.deepEqual(sync, originalSync);
  assert.equal(harness.saves, 1);
  assert.equal(harness.receipts.length, 1);
  assert.match(harness.receipts[0].detail, /Google identity was linked/);
  assert.doesNotMatch(harness.receipts[0].detail, /Drive app-data access.*linked|Drive app-data granted/);

  const repeated = await harness.invoke();
  assert.equal(repeated.status, 200);
  assert.strictEqual(harness.state.settings.sync, sync);
  assert.deepEqual(sync, originalSync);
  assert.equal(harness.saves, 1);
  assert.equal(harness.receipts.length, 1);
});

test('Google identity login leaves an existing Drive backup opt-in intact', async () => {
  const sync = { enabled: true, provider: 'google-drive', status: 'connected', encrypted: true, lastSyncAt: '2026-10-04T12:00:00.000Z' };
  const originalSync = structuredClone(sync);
  const harness = routeHarness(sync);

  const response = await harness.invoke();
  assert.equal(response.status, 200);
  assert.strictEqual(harness.state.settings.sync, sync);
  assert.deepEqual(sync, originalSync);
});

test('identity OAuth token does not satisfy Drive consent; Drive popup token does', async () => {
  const clientSource = readSource('../client/firebase-google.js');
  const clientFunctions = between(clientSource, 'function publicAccount(', 'async function driveRequest(');
  const declarations = [
    sourceLine(clientSource, 'let driveToken ='),
    sourceLine(clientSource, 'let driveAccountUid ='),
    sourceLine(clientSource, 'let connectionPromise ='),
    sourceLine(clientSource, 'let driveConnectionPromise ='),
  ].join('\n');
  const provider = { type: 'identity' };
  const driveProvider = { type: 'drive-consent' };
  const identityUser = { uid: 'fixture-owner', email: 'owner@example.test', displayName: 'Fixture Owner' };
  const identityResult = { user: identityUser, credential: { accessToken: 'identity-only-token' } };
  const driveResult = { user: identityUser, credential: { accessToken: 'drive-appdata-token' } };
  const popupProviders = [];
  const auth = { currentUser: identityUser, authStateReady: async () => {} };
  const context = {
    auth,
    provider,
    driveProvider,
    browserLocalPersistence: {},
    setPersistence: async () => {},
    GoogleAuthProvider: { credentialFromResult: (result) => result?.credential || null },
    signInWithPopup: async (receivedAuth, requestedProvider) => {
      popupProviders.push(requestedProvider);
      const result = requestedProvider === driveProvider ? driveResult : identityResult;
      receivedAuth.currentUser = result.user;
      return result;
    },
  };
  const client = runInNewContext(`${declarations}\n${clientFunctions}\n({ prepare, connect, requireDriveToken })`, context);

  const preparedAccount = await client.prepare();
  assert.equal(preparedAccount.email, 'owner@example.test');
  assert.deepEqual(popupProviders, []);

  const account = await client.connect({ force: true });
  assert.equal(account.email, 'owner@example.test');
  assert.deepEqual(popupProviders, [provider]);

  assert.equal(await client.requireDriveToken(), 'drive-appdata-token');
  assert.deepEqual(popupProviders, [provider, driveProvider]);
  assert.equal(await client.requireDriveToken(), 'drive-appdata-token');
  assert.deepEqual(popupProviders, [provider, driveProvider]);
});

function driveHarness() {
  const source = readSource('../client/firebase-google.js');
  const declarations = ['driveToken', 'driveAccountUid', 'connectionPromise', 'driveConnectionPromise']
    .map(name => sourceLine(source, `let ${name} =`)).join('\n');
  const owner = { uid: 'fixture-owner', email: 'owner@example.test' };
  const auth = { currentUser: owner, authStateReady: async () => {} };
  let result = { user: owner, credential: { accessToken: 'drive-owner-token' } };
  let popups = 0;
  const context = { auth, provider: {}, driveProvider: {}, browserLocalPersistence: {},
    setPersistence: async () => {}, GoogleAuthProvider: { credentialFromResult: value => value.credential },
    signInWithPopup: async () => { popups++; auth.currentUser = result.user; return result; } };
  const client = runInNewContext(`${declarations}\n${between(source, 'function publicAccount(', 'async function driveRequest(')}\n({account, requireDriveToken})`, context);
  return { client, auth, get popups() { return popups; }, setResult(value) { result = value; } };
}

test('changing Google identity invalidates the previously consented Drive token', async () => {
  const h = driveHarness();
  assert.equal(await h.client.requireDriveToken(), 'drive-owner-token');
  const other = { uid: 'fixture-other', email: 'other@example.test' };
  h.auth.currentUser = other;
  h.client.account(null);
  h.setResult({ user: other, credential: { accessToken: 'drive-other-token' } });
  assert.equal(await h.client.requireDriveToken(), 'drive-other-token');
  assert.equal(h.popups, 2);
});

test('a different-account Drive consent cannot authorize the original identity backup', async () => {
  const h = driveHarness();
  h.setResult({ user: { uid: 'fixture-other' }, credential: { accessToken: 'wrong-account-token' } });
  await assert.rejects(h.client.requireDriveToken(), /same Google account/);
  h.auth.currentUser = null;
  await assert.rejects(h.client.requireDriveToken(), /Sign in to Google/);
  assert.equal(h.popups, 1);
});

test('backup export envelope reaches upload only after the export response', async () => {
  const publicSource = readSource('../public/google-backup.js');
  const backupFunction = between(publicSource, 'async function backupToGoogle() {', 'async function chooseBackup()');
  const envelope = Object.freeze({ salt: 'fixture-salt', iv: 'fixture-iv', ciphertext: 'encrypted-fixture-payload' });
  const calls = [];
  let exportResolved = false;
  const passphrase = 'fixture-local-backup-passphrase';
  const context = {
    document: { querySelector: (selector) => selector === '#googleBackupPassphrase' ? { value: passphrase } : null },
    api: async (path, options) => {
      assert.equal(path, '/api/backup/export');
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).passphrase, passphrase);
      calls.push('export');
      exportResolved = true;
      return { envelope };
    },
    window: { HexiGridGoogle: { uploadBackup: async (receivedEnvelope) => {
      assert.equal(exportResolved, true);
      assert.strictEqual(receivedEnvelope, envelope);
      calls.push('upload');
    } } },
    notify: () => calls.push('notify'),
  };
  const backupToGoogle = runInNewContext(`${backupFunction}\nbackupToGoogle`, context);

  await backupToGoogle();
  assert.deepEqual(calls, ['export', 'upload', 'notify']);
  assert.equal(typeof envelope.ciphertext, 'string');
});
