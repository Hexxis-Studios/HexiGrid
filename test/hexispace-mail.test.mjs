import test from 'node:test';
import assert from 'node:assert/strict';
import { mailboxAction, publicMailbox, validateMailboxAttachment } from '../lib/hexispace-mail.mjs';

function response(body, status = 200, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function vaultWith(secret) {
  const values = new Map([['vault-mailbox', JSON.stringify(secret)]]);
  return { values, async get(key) { return this.values.get(key) || ''; }, async set(key, value) { this.values.set(key, value); } };
}

const baseRecord = { id: 'mailbox-12345678', profileId: 'profile-1', provider: 'gmail', email: 'agent@example.com', scopes: ['https://mail.google.com/'], vaultRef: 'vault-mailbox', connectedAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' };

test('mailbox attachment validation keeps OAuth credentials out of public metadata', () => {
  const input = validateMailboxAttachment({ provider: 'gmail', profileId: 'profile-1', email: 'Agent@Example.com', accessToken: 'access-secret', refreshToken: 'refresh-secret', clientId: 'public-client-id', expiresAt: Date.now() + 3600000, scopes: ['https://mail.google.com/'] });
  assert.equal(input.email, 'agent@example.com');
  const publicRecord = publicMailbox({ ...baseRecord, scopes: input.scopes });
  assert.equal('accessToken' in publicRecord, false);
  assert.equal('refreshToken' in publicRecord, false);
  assert.equal('clientId' in publicRecord, false);
});

test('Gmail mailbox listing uses the vault token and returns bounded metadata', async () => {
  const vault = vaultWith({ accessToken: 'access-secret', refreshToken: 'refresh-secret', clientId: 'client', expiresAt: Date.now() + 3600000 });
  const calls = [];
  const fetcher = async (input, init = {}) => {
    calls.push({ input: String(input), authorization: new Headers(init.headers).get('authorization') });
    if (String(input).includes('/messages?')) return response({ messages: [{ id: 'message-1' }] });
    return response({ id: 'message-1', snippet: 'Hello', labelIds: ['UNREAD'], payload: { headers: [{ name: 'Subject', value: 'Welcome' }, { name: 'From', value: 'sender@example.com' }, { name: 'Date', value: 'Wed, 16 Sep 2026 00:00:00 GMT' }] } });
  };
  const result = await mailboxAction(baseRecord, { action: 'list' }, vault, { fetcher });
  assert.equal(result.messages[0].subject, 'Welcome');
  assert.equal(result.messages[0].unread, true);
  assert.equal(calls.every((call) => call.authorization === 'Bearer access-secret'), true);
});

test('Gmail send encodes plain text and delete uses the selected message', async () => {
  const vault = vaultWith({ accessToken: 'access-secret', clientId: 'client', expiresAt: Date.now() + 3600000 });
  const calls = [];
  const fetcher = async (input, init = {}) => { calls.push({ input: String(input), init }); return response({}); };
  await mailboxAction(baseRecord, { action: 'send', recipient: 'friend@example.com', subject: 'Hello', body: 'A short message.' }, vault, { fetcher });
  await mailboxAction(baseRecord, { action: 'delete', messageId: 'message-1' }, vault, { fetcher });
  assert.match(calls[0].input, /messages\/send$/);
  assert.match(JSON.parse(calls[0].init.body).raw, /^[A-Za-z0-9_-]+$/);
  assert.equal(calls[1].init.method, 'DELETE');
  assert.match(calls[1].input, /messages\/message-1$/);
});

test('Outlook requires the matching permission for send', async () => {
  const record = { ...baseRecord, provider: 'outlook', scopes: ['https://graph.microsoft.com/Mail.ReadWrite'] };
  const vault = vaultWith({ accessToken: 'access-secret', clientId: 'client', expiresAt: Date.now() + 3600000 });
  await assert.rejects(() => mailboxAction(record, { action: 'send', recipient: 'friend@example.com', body: 'Hello' }, vault), /permission needed/);
});

test('expired mailbox tokens refresh through the provider and update the vault', async () => {
  const vault = vaultWith({ accessToken: 'old-access', refreshToken: 'refresh-secret', clientId: 'client', expiresAt: Date.now() - 1000 });
  const record = { ...baseRecord };
  const calls = [];
  const fetcher = async (input, init = {}) => {
    calls.push(String(input));
    if (String(input).includes('/token')) return response({ access_token: 'new-access', expires_in: 3600 });
    return response({ messages: [] });
  };
  await mailboxAction(record, { action: 'list' }, vault, { fetcher });
  assert.deepEqual(calls, ['https://oauth2.googleapis.com/token', 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25']);
  assert.match(await vault.get('vault-mailbox'), /new-access/);
});
