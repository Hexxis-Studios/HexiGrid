let googleAccount = null;

function setGoogleAccount(account) {
  googleAccount = account || null;
  renderGoogleSummary();
  window.dispatchEvent(new CustomEvent('hexigrid:google-account', { detail: { account: googleAccount } }));
}

function googleReady() {
  return Boolean(window.HexiGridGoogle);
}

function renderSync() {
  const root = document.querySelector('#syncTools');
  if (!root || !state.data) return;
  const connected = Boolean(googleAccount);
  root.innerHTML = `<div class="eyebrow">OPTIONAL CLOUD BACKUP</div>
    <h3>Google Drive</h3>
    <p class="panel-copy">Google sign-in verifies your identity. Backups need separate Google Drive app-data consent when you first back up or open backup history. HexiGrid encrypts each backup on this device before upload.</p>
    <div class="security-status">
      <span class="status-badge ${connected ? '' : 'warn'}">${connected ? 'IDENTITY CONNECTED' : 'NOT CONNECTED'}</span>
      <span>${connected ? escapeHtml(googleAccount.email || googleAccount.displayName || 'Google account connected') : 'No Google setup or client ID is required from you.'}</span>
    </div>
    ${connected ? `<label class="editor-label">Backup password<input id="googleBackupPassphrase" type="password" autocomplete="new-password" placeholder="Use at least 12 characters"></label>` : ''}
    <div class="provider-actions">
      <button class="${connected ? 'secondary-button' : 'primary-button'}" data-google-action="connect">${connected ? 'Choose another Google account' : 'Continue with Google'}</button>
      ${connected ? '<button class="primary-button" data-google-action="push">Back up now</button><button class="secondary-button" data-google-action="history">Backup history</button><button class="ghost-button" data-google-action="disconnect">Disconnect</button>' : ''}
    </div>
    <p id="syncFeedback" role="status"></p>`;
}

function renderGoogleSummary() {
  const badge = document.querySelector('#googleSummaryBadge');
  const copy = document.querySelector('#googleSummaryCopy');
  const button = document.querySelector('#googleSummaryButton');
  if (!badge || !copy || !button) return;
  const connected = Boolean(googleAccount);
  badge.textContent = connected ? 'CONNECTED' : 'OPTIONAL';
  badge.classList.toggle('warn', !connected);
  copy.textContent = connected
    ? `Google identity is connected${googleAccount.email ? ` as ${googleAccount.email}` : ''}. Drive permission is requested separately for backup actions. Open backup settings to back up, restore, or disconnect.`
    : 'Google is optional. Sign in to verify your identity; Drive backups need separate permission and are encrypted on this device before upload.';
  button.textContent = connected ? 'Manage Google backup' : 'Set up Google backup';
}

async function connectGoogle({ unlock = false, force = false } = {}) {
  if (!googleReady()) throw new Error('Google sign-in did not load. Check the internet connection and reload HexiGrid.');
  const account = await window.HexiGridGoogle.connect({ force });
  if (!account) return null;
  setGoogleAccount(account);
  const idToken = await window.HexiGridGoogle.idToken();
  if (!isStandaloneBrowser() && idToken) {
    try {
      await api('/api/auth/google/firebase', { method: 'POST', body: JSON.stringify({ idToken, linkOnly: !unlock }) });
    } catch (error) {
      if (unlock) throw error;
    }
  }
  renderSync();
  return account;
}
window.connectHexiGridGoogle = connectGoogle;

async function backupToGoogle() {
  const passphrase = document.querySelector('#googleBackupPassphrase')?.value || '';
  if (passphrase.length < 12) throw new Error('Use a backup password with at least 12 characters.');
  const exported = await api('/api/backup/export', { method: 'POST', body: JSON.stringify({ passphrase }) });
  await window.HexiGridGoogle.uploadBackup(exported.envelope);
  notify('Encrypted backup saved to your Google Drive.');
}

async function chooseBackup() {
  const feedback = document.querySelector('#syncFeedback');
  if (feedback) feedback.textContent = 'Loading backup history…';
  const files = await window.HexiGridGoogle.listBackups();
  if (!files.length) {
    await window.hexigridModal({ title: 'Backup history', message: 'No HexiGrid backups are stored in this Google account yet.', accept: 'Done' });
    if (feedback) feedback.textContent = 'No backups are stored in this Google account yet.';
    return;
  }
  const choice = await window.hexigridModal({
    title: 'Restore a Google backup',
    message: 'Choose a version. HexiGrid downloads the encrypted file and decrypts it only on this device.',
    accept: 'Restore selected',
    danger: true,
    fields: [{ label: 'Backup version', options: files.map((file) => `${file.id} — ${new Date(file.modifiedTime).toLocaleString()} · ${Math.round(Number(file.size || 0) / 1024)} KB`) }],
  });
  if (!choice?.[0]) return;
  const passphrase = document.querySelector('#googleBackupPassphrase')?.value || '';
  if (!passphrase) throw new Error('Enter the backup password used when this backup was created.');
  const fileId = choice[0].split(' — ')[0];
  const envelope = await window.HexiGridGoogle.downloadBackup(fileId);
  await approvedRequest('/api/backup/import', { method: 'POST', body: JSON.stringify({ envelope, passphrase, confirmReplace: true }) }, 'Restore this encrypted Google backup and pause imported automation for review?');
  notify('Encrypted Google backup restored.');
  await refresh();
}

document.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-google-action]')?.dataset.googleAction;
  if (!action) return;
  const feedback = document.querySelector('#syncFeedback');
  try {
    if (action === 'connect') await connectGoogle({ force: Boolean(googleAccount) });
    if (action === 'push') await backupToGoogle();
    if (action === 'history') await chooseBackup();
    if (action === 'disconnect') {
      if (!isStandaloneBrowser()) await api('/api/auth/google', { method: 'DELETE' });
      await window.HexiGridGoogle.disconnect();
      setGoogleAccount(null);
      renderSync();
    }
  } catch (error) {
    if (feedback) feedback.textContent = error.message;
    notify(error.message, true);
  }
});

async function initializeGoogle() {
  if (!googleReady()) return renderSync();
  try {
    setGoogleAccount(await window.HexiGridGoogle.prepare());
    if (googleAccount && !isStandaloneBrowser()) {
      await api('/api/auth/status');
      const idToken = await window.HexiGridGoogle.idToken();
      if (idToken) await api('/api/auth/google/firebase', { method: 'POST', body: JSON.stringify({ idToken }) });
    }
  }
  catch (error) {
    setGoogleAccount(null);
    const message = error?.message || 'Google sign-in could not be completed.';
    const feedback = document.querySelector('#authFeedback');
    if (feedback) feedback.textContent = message;
    const syncFeedback = document.querySelector('#syncFeedback');
    if (syncFeedback) syncFeedback.textContent = message;
  }
  renderSync();
  return googleAccount;
}

window.hexigridGoogleReady = initializeGoogle();
