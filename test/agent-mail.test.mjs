import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = (file) => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('agent email bridge is modular, separately consented, and available offline', async () => {
  const [html, bridge, firebase, cachePolicy, assets] = await Promise.all([
    read('public/index.html'), read('public/agent-mail.js'), read('client/firebase-google.js'), read('public/pwa-policy.js'), read('lib/static-assets.mjs')
  ]);
  assert.match(html, /id="externalEmail"[^>]*type="email"/);
  assert.match(html, /src="\/agent-mail\.js"/);
  assert.match(bridge, /Message the actual agent/);
  assert.match(bridge, /listAgentEmails/);
  assert.match(bridge, /sendAgentEmail/);
  assert.match(bridge, /\/api\/live\/email-receipt/);
  assert.match(bridge, /watchTimer = setInterval\([\s\S]*?, 15000\)/);
  assert.match(firebase, /gmail\.readonly/);
  assert.match(firebase, /gmail\.send/);
  assert.match(firebase, /signInWithPopup\(auth, mailProvider\)/);
  assert.doesNotMatch(firebase, /signInWithRedirect|redirectSignIn|google-mail-redirect/);
  assert.match(firebase, /let mailToken = ''/);
  assert.match(firebase, /let driveToken = ''/);
  assert.match(firebase, /if \(\[401, 403\]\.includes\(response\.status\)\) mailToken = ''/);
  assert.match(firebase, /disconnect: async \(\) => \{ driveToken = ''; mailToken = '';/);
  assert.doesNotMatch(firebase, /(?:localStorage|sessionStorage)\.setItem\([^\n]*mailToken/);
  assert.match(cachePolicy, /'\/agent-mail\.js'/);
  assert.match(assets, /'\/agent-mail\.js'/);
});

test('email identity is validated and duplication does not copy it', async () => {
  const [server, standalone] = await Promise.all([read('server.mjs'), read('public/standalone-runtime.js')]);
  assert.match(server, /externalEmail: cleanEmail\(body\.externalEmail\)/);
  assert.match(server, /externalEmail: ""/);
  assert.match(standalone, /externalEmail: cleanEmail\(body\.externalEmail\)/);
  assert.match(standalone, /externalEmail: ''/);
});
