const PROVIDERS = Object.freeze(['gmail', 'outlook']);
const GMAIL_SCOPE = 'https://mail.google.com/';
const OUTLOOK_READ_SCOPE = 'https://graph.microsoft.com/Mail.ReadWrite';
const OUTLOOK_SEND_SCOPE = 'https://graph.microsoft.com/Mail.Send';

const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function validateMailboxAttachment(input = {}) {
  const provider = clean(input.provider, 20);
  const profileId = clean(input.profileId, 120);
  const email = clean(input.email, 320).toLowerCase();
  const accessToken = clean(input.accessToken, 12000);
  const refreshToken = clean(input.refreshToken, 12000);
  const clientId = clean(input.clientId, 300);
  const expiresAt = Number(input.expiresAt);
  const scopes = [...new Set((Array.isArray(input.scopes) ? input.scopes : []).map((scope) => clean(scope, 300)).filter(Boolean))].slice(0, 16);
  if (!PROVIDERS.includes(provider)) throw invalid('Choose Gmail or Outlook.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('The mailbox address is invalid.');
  if (!profileId || !accessToken || !Number.isFinite(expiresAt)) throw invalid('The mailbox connection is incomplete.');
  if (!clientId) throw invalid('The mailbox OAuth client is missing.');
  return { provider, profileId, email, accessToken, refreshToken, clientId, expiresAt, scopes };
}

export function mailboxSecretRef(id) {
  if (!/^mailbox-[a-f0-9-]{8,80}$/.test(String(id))) throw invalid('The mailbox connection ID is invalid.');
  return `hexispace-${id}`;
}

export function publicMailbox(record) {
  return { id: record.id, profileId: record.profileId, provider: record.provider, email: record.email, scopes: [...record.scopes], connectedAt: record.connectedAt, updatedAt: record.updatedAt };
}

function requiresScope(record, action) {
  if (record.provider === 'gmail' && record.scopes.includes(GMAIL_SCOPE)) return;
  if (record.provider === 'outlook' && action === 'send' && record.scopes.includes(OUTLOOK_SEND_SCOPE)) return;
  if (record.provider === 'outlook' && action !== 'send' && record.scopes.includes(OUTLOOK_READ_SCOPE)) return;
  const error = new Error('This mailbox was connected without the permission needed for that action. Reconnect it with full mailbox access.');
  error.status = 403;
  throw error;
}

async function responseError(response, fallback) {
  const body = await response.json().catch(() => ({}));
  const detail = body?.error?.message || body?.error_description || body?.error?.innerError?.message;
  const error = new Error(detail ? `${fallback} ${String(detail).slice(0, 300)}` : fallback);
  error.status = response.status === 401 || response.status === 403 ? 502 : response.status;
  throw error;
}

async function refreshSecret(record, secret, vault, fetcher) {
  if (secret.expiresAt > Date.now() + 60_000) return secret;
  if (!secret.refreshToken) throw new Error('This mailbox session expired. Reconnect the mailbox from HexiSpace.');
  const endpoint = record.provider === 'gmail' ? 'https://oauth2.googleapis.com/token' : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const body = new URLSearchParams({ client_id: secret.clientId, refresh_token: secret.refreshToken, grant_type: 'refresh_token' });
  const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new Error('The mailbox session expired. Reconnect the mailbox from HexiSpace.');
  const next = { ...secret, accessToken: result.access_token, refreshToken: result.refresh_token || secret.refreshToken, expiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000 };
  await vault.set(record.vaultRef, JSON.stringify(next));
  return next;
}

async function authorizedRequest(record, action, vault, fetcher, input, init = {}) {
  requiresScope(record, action);
  let secret;
  try { secret = JSON.parse(await vault.get(record.vaultRef) || 'null'); } catch { secret = null; }
  if (!secret?.accessToken) throw new Error('The mailbox credential is unavailable. Reconnect the mailbox from HexiSpace.');
  secret = await refreshSecret(record, secret, vault, fetcher);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${secret.accessToken}`);
  return fetcher(input, { ...init, headers });
}

export async function mailboxAction(record, input, vault, { fetcher = fetch } = {}) {
  const action = clean(input?.action, 20);
  if (!['list', 'send', 'delete'].includes(action)) throw invalid('Choose a supported mailbox action.');
  if (action === 'list') return listMailbox(record, vault, fetcher);
  if (action === 'send') return sendMailbox(record, input, vault, fetcher);
  return deleteMailbox(record, input, vault, fetcher);
}

async function listMailbox(record, vault, fetcher) {
  if (record.provider === 'gmail') {
    const listResponse = await authorizedRequest(record, 'list', vault, fetcher, 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25');
    if (!listResponse.ok) return responseError(listResponse, 'Gmail could not list messages.');
    const list = await listResponse.json();
    const messages = await Promise.all((list.messages || []).slice(0, 25).map(async ({ id }) => {
      const response = await authorizedRequest(record, 'list', vault, fetcher, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
      if (!response.ok) return null;
      const message = await response.json();
      const header = (name) => message.payload?.headers?.find((item) => String(item.name).toLowerCase() === name.toLowerCase())?.value || '';
      return { id: message.id, subject: header('Subject') || '(no subject)', sender: header('From'), preview: message.snippet || '', receivedAt: header('Date') || new Date(Number(message.internalDate || Date.now())).toISOString(), unread: message.labelIds?.includes('UNREAD') || false };
    }));
    return { messages: messages.filter(Boolean) };
  }
  const response = await authorizedRequest(record, 'list', vault, fetcher, 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime%20desc&$select=id,subject,from,bodyPreview,receivedDateTime,isRead');
  if (!response.ok) return responseError(response, 'Outlook could not list messages.');
  const result = await response.json();
  return { messages: (result.value || []).map((message) => ({ id: message.id, subject: message.subject || '(no subject)', sender: message.from?.emailAddress?.address || '', preview: message.bodyPreview || '', receivedAt: message.receivedDateTime || '', unread: !message.isRead })) };
}

function safeAddress(value) { const email = clean(value, 320); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Add a valid recipient address.'); return email; }

async function sendMailbox(record, input, vault, fetcher) {
  const recipient = safeAddress(input?.recipient);
  const subject = clean(input?.subject || '(no subject)', 200).replace(/[\r\n]/g, ' ');
  const body = clean(input?.body, 10000);
  if (!body) throw invalid('Add a message before sending.');
  if (record.provider === 'gmail') {
    const raw = [`To: ${recipient}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=UTF-8', 'MIME-Version: 1.0', '', body].join('\r\n');
    const encoded = Buffer.from(raw, 'utf8').toString('base64url');
    const response = await authorizedRequest(record, 'send', vault, fetcher, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: encoded }) });
    if (!response.ok) return responseError(response, 'Gmail could not send the message.');
    return { sent: true };
  }
  const response = await authorizedRequest(record, 'send', vault, fetcher, 'https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { subject, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: recipient } }] }, saveToSentItems: true }) });
  if (!response.ok) return responseError(response, 'Outlook could not send the message.');
  return { sent: true };
}

async function deleteMailbox(record, input, vault, fetcher) {
  const messageId = clean(input?.messageId, 500);
  if (!messageId || /[\r\n]/.test(messageId)) throw invalid('Choose a message to delete.');
  const endpoint = record.provider === 'gmail' ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}` : `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`;
  const response = await authorizedRequest(record, 'delete', vault, fetcher, endpoint, { method: 'DELETE' });
  if (!response.ok) return responseError(response, `${record.provider === 'gmail' ? 'Gmail' : 'Outlook'} could not delete the message.`);
  return { deleted: true, messageId };
}
