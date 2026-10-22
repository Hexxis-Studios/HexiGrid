import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'firebase/auth';

const app = initializeApp({
  projectId: 'hexigrid',
  appId: '1:1007956777224:web:6873d26df76fd0d80b74bd',
  storageBucket: 'hexigrid.firebasestorage.app',
  apiKey: 'AIzaSyDUbKiGpE_RUBM-vF7gFgQsjYA19sJKH1Q',
  authDomain: 'hexigrid.firebaseapp.com',
  messagingSenderId: '1007956777224',
});

const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });
const driveProvider = new GoogleAuthProvider();
driveProvider.addScope('https://www.googleapis.com/auth/drive.appdata');
driveProvider.setCustomParameters({ prompt: 'consent' });
let driveToken = '';
let driveAccountUid = '';
let mailToken = '';
let connectionPromise = null;
let driveConnectionPromise = null;
const mailProvider = new GoogleAuthProvider();
mailProvider.addScope('https://www.googleapis.com/auth/gmail.readonly');
mailProvider.addScope('https://www.googleapis.com/auth/gmail.send');
mailProvider.setCustomParameters({ prompt: 'consent' });

function publicAccount(user = auth.currentUser) {
  return user ? { uid: user.uid, displayName: user.displayName || '', email: user.email || '', photoURL: user.photoURL || '' } : null;
}

function account(result) {
  const selected = publicAccount(result?.user || auth.currentUser);
  if (selected?.uid !== driveAccountUid) { driveToken = ''; driveAccountUid = ''; }
  return selected;
}

async function prepare() {
  await setPersistence(auth, browserLocalPersistence);
  await auth.authStateReady();
  return account(null);
}

async function connect({ force = false } = {}) {
  if (connectionPromise) return connectionPromise;
  connectionPromise = (async () => {
    await setPersistence(auth, browserLocalPersistence);
    if (auth.currentUser && !force) return account(null);
    return account(await signInWithPopup(auth, provider));
  })();
  try { return await connectionPromise; } finally { connectionPromise = null; }
}

async function idToken() {
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) return '';
  return user.getIdToken();
}

async function requireDriveToken() {
  if (driveToken && driveAccountUid === auth.currentUser?.uid) return driveToken;
  driveToken = ''; driveAccountUid = '';
  if (driveConnectionPromise) return driveConnectionPromise;
  driveConnectionPromise = (async () => {
    const expectedUid = auth.currentUser?.uid;
    if (!expectedUid) throw new Error('Sign in to Google before using Drive backup.');
    const result = await signInWithPopup(auth, driveProvider);
    account(result);
    if (result.user?.uid !== expectedUid) throw new Error('Choose the same Google account for Drive backup, or switch your Google identity first.');
    const credential = GoogleAuthProvider.credentialFromResult(result);
    driveToken = credential?.accessToken || '';
    if (!driveToken) throw new Error('Google Drive permission was not completed. Try Continue with Google again.');
    driveAccountUid = expectedUid;
    return driveToken;
  })();
  try { return await driveConnectionPromise; } finally { driveConnectionPromise = null; }
}

async function driveRequest(url, options = {}) {
  const token = await requireDriveToken();
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) {
    if (response.status === 401) driveToken = '';
    throw new Error('Google Drive could not complete that backup action. Reconnect Google and try again.');
  }
  return response;
}

async function listBackups() {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: "name contains 'hexigrid-backup-' and trashed = false",
    orderBy: 'modifiedTime desc',
    pageSize: '10',
    fields: 'files(id,name,modifiedTime,size)',
  });
  return (await (await driveRequest(`https://www.googleapis.com/drive/v3/files?${params}`)).json()).files || [];
}

async function uploadBackup(envelope) {
  const boundary = `hexigrid-${crypto.randomUUID()}`;
  const name = `hexigrid-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const metadata = JSON.stringify({ name, mimeType: 'application/json', parents: ['appDataFolder'] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(envelope)}\r\n--${boundary}--\r\n`;
  const created = await (await driveRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size', { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body })).json();
  const history = await listBackups();
  await Promise.all(history.slice(10).map((file) => driveRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' }).catch(() => null)));
  return created;
}

async function downloadBackup(fileId) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(String(fileId || ''))) throw new Error('That Google backup identifier is invalid.');
  return (await driveRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)).json();
}

function encodeMail(value) {
  const bytes = new TextEncoder().encode(value); let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeMail(value = '') {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
}

async function gmailRequest(path, options = {}) {
  if (!mailToken) throw new Error('Connect Google Mail for this agent bridge first.');
  const token = mailToken;
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) }, redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok) { if ([401, 403].includes(response.status)) mailToken = ''; throw new Error('Google Mail permission is unavailable. Reconnect Google and approve Mail access.'); }
  return response;
}

async function connectMail() {
  await setPersistence(auth, browserLocalPersistence);
  const result = await signInWithPopup(auth, mailProvider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  mailToken = credential?.accessToken || '';
  if (!mailToken) throw new Error('Google did not grant Mail permission.');
  return publicAccount(result.user);
}

async function sendAgentEmail({ to, subject, text }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) throw new Error('Enter the agent’s working email address first.');
  const safeSubject = String(subject || 'HexiGrid message').replace(/[\r\n]/g, ' ').slice(0, 180);
  const raw = `To: ${to}\r\nSubject: ${safeSubject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${String(text || '').slice(0, 50000)}`;
  return gmailRequest('/messages/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: encodeMail(raw) }) }).then((response) => response.json());
}

function plainPart(payload) {
  if (payload?.mimeType === 'text/plain' && payload.body?.data) return decodeMail(payload.body.data);
  for (const part of payload?.parts || []) { const value = plainPart(part); if (value) return value; }
  return payload?.body?.data ? decodeMail(payload.body.data) : '';
}

async function listAgentEmails(from, after = 0) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(from || ''))) throw new Error('Enter the agent’s working email address first.');
  const list = await gmailRequest(`/messages?q=${encodeURIComponent(`from:${from} newer_than:7d`)}&maxResults=20`).then((response) => response.json());
  const messages = await Promise.all((list.messages || []).map(({ id }) => gmailRequest(`/messages/${encodeURIComponent(id)}?format=full`).then((response) => response.json())));
  return messages.map((message) => ({ id: message.id, receivedAt: Number(message.internalDate || 0), text: plainPart(message.payload).trim().slice(0, 50000) })).filter((message) => message.receivedAt > Number(after) && message.text).sort((a, b) => a.receivedAt - b.receivedAt);
}

window.HexiGridGoogle = Object.freeze({
  prepare,
  connect,
  idToken,
  current: () => account(null),
  onChange: (callback) => onAuthStateChanged(auth, () => callback(account(null))),
  disconnect: async () => { driveToken = ''; mailToken = ''; await signOut(auth); },
  listBackups,
  uploadBackup,
  downloadBackup,
  sendAgentEmail,
  listAgentEmails,
  connectMail,
  mailConnected: () => Boolean(mailToken),
});
