function renderSecurity() {
  const root = document.querySelector('#securityTools');
  if (!root || !state.data) return;
  const auth = state.data.settings.auth || {};
  const schedule = state.data.settings.backupSchedule || {};
  const browser = isStandaloneBrowser();
  const rollbackAvailable = state.data.backupRecovery?.localRollbackAvailable === true;
  root.innerHTML = `<div class="eyebrow">SECURITY + RECOVERY</div><h3>Protect and move your local data</h3><p class="panel-copy">Encrypted backups include chats, profiles, settings, private files, and dated memory. ${browser ? 'Provider keys are encrypted in this browser vault but excluded from downloaded backups, so enter them again after a restore on another device.' : 'Provider API keys stay in the operating system vault and must be entered again on another device.'}</p><div class="security-status"><span class="status-badge ${auth.localPasscode ? '' : 'warn'}">${auth.localPasscode ? 'PASSCODE ON' : 'GOOGLE SIGN-IN'}</span><span>${browser ? 'Your passcode unlocks AES-256 encryption; the usable key exists only in this tab while it is unlocked.' : auth.localPasscode ? 'Local sessions expire after 12 hours.' : 'Add a local passcode if you also want offline sign-in.'}</span></div>${browser ? '' : `<div class="security-status"><span class="status-badge ${schedule.enabled ? '' : 'warn'}">${schedule.enabled ? 'SNAPSHOTS ON' : 'SNAPSHOTS OFF'}</span><span>${schedule.enabled ? `Encrypted local snapshot every ${schedule.intervalHours} hours.${schedule.lastRunAt ? ` Last completed ${new Date(schedule.lastRunAt).toLocaleString()}.` : ''}` : 'Optional automatic snapshots stay on this computer and are off by default.'}</span></div>`}<div class="provider-actions">${!browser && !auth.localPasscode ? '<button class="secondary-button" data-control-action="add-local-passcode">Add local passcode</button>' : ''}<button class="secondary-button" data-control-action="export-backup">Download encrypted backup</button><button class="secondary-button" data-control-action="import-backup">Restore encrypted backup</button>${browser ? '' : `<button class="secondary-button" data-control-action="backup-schedule">${schedule.enabled ? 'Turn off automatic snapshots' : 'Set up automatic snapshots'}</button>`}<button class="ghost-button" data-control-action="logout">Lock now</button></div><input id="backupFile" type="file" accept="application/json,.json" hidden>`;
  if (!browser && schedule.enabled) root.insertAdjacentHTML('beforeend', `<section class="backup-recovery" aria-label="Automatic snapshot status"><div><h4>${schedule.lastError ? 'Snapshot needs attention' : 'Automatic snapshots'}</h4><p>${schedule.lastError ? escapeHtml(schedule.lastError) + ' Check the backup folder and disk space, then retry. If the vault passphrase is unavailable, turn snapshots off and set them up again.' : 'Save an encrypted snapshot now without waiting for the next scheduled run.'}</p><p class="microcopy">Folder: ${escapeHtml(schedule.directory || 'Documents/HexiGrid Backups')}${schedule.nextRunAt ? ` &middot; Next attempt: ${escapeHtml(new Date(schedule.nextRunAt).toLocaleString())}` : ''}</p><div class="provider-actions">${typeof window !== 'undefined' && typeof window.hexigridDesktop?.chooseBackupDirectory === 'function' ? '<button class="secondary-button" data-control-action="backup-directory">Change folder</button>' : ''}<button class="secondary-button" data-control-action="backup-snapshot">${schedule.lastError ? 'Retry snapshot now' : 'Save snapshot now'}</button></div></div></section>`);
  root.insertAdjacentHTML('beforeend', `<section class="backup-recovery" aria-label="Restore recovery"><div><h4>Undo the last restore</h4><p>${rollbackAvailable ? 'A recovery point is available. Rolling back replaces the current HexiGrid records and private app files with their pre-restore versions.' : 'No restore recovery point is available. After a successful restore, you can return to the previous HexiGrid data here.'}</p></div><button class="secondary-button" data-control-action="backup-rollback" ${rollbackAvailable ? '' : 'disabled'}>Undo last restore</button></section><p class="backup-safety-note">Restore replaces HexiGrid data on this device. Export a current backup first if you want to keep changes made since the backup. ${browser ? 'This browser vault uses its own backup format.' : 'Imported automation stays paused for review. Restored accounts and device connections need review before reuse.'}</p>`);
}

let preparedBackupUrl;
async function makeBackup() {
  const answer = window.hexigridModal ? await window.hexigridModal({ title: 'Encrypt a local backup', message: 'Save the passphrase somewhere safe. You need it to restore this file; HexiGrid cannot recover it. The backup is downloaded locally and is not uploaded.', accept: 'Create backup', fields: [{ label: 'Backup passphrase', type: 'password', required: true, minLength: 12, description: 'At least 12 characters. Provider and tool credentials are excluded.' }] }) : null;
  const passphrase = answer?.[0];
  if (!passphrase) return;
  try {
    const result = await api('/api/backup/export', { method: 'POST', body: JSON.stringify({ passphrase }) });
    const blob = new Blob([JSON.stringify(result.envelope, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    if (preparedBackupUrl) URL.revokeObjectURL(preparedBackupUrl);
    document.querySelector('[data-backup-download]')?.remove();
    preparedBackupUrl = URL.createObjectURL(blob);
    link.href = preparedBackupUrl;
    link.download = result.filename;
    link.textContent = 'Save encrypted backup';
    link.className = 'secondary-button';
    link.dataset.backupDownload = '';
    document.querySelector('#securityTools .provider-actions').append(link);
    notify('Encrypted backup ready. Choose Save encrypted backup to download it.');
  } catch (error) { notify(error.message, true); }
}

document.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-control-action]')?.dataset.controlAction;
  if (action === 'add-local-passcode') return window.showAuthGate?.(true);
  if (action === 'export-backup') return makeBackup();
  if (action === 'backup-snapshot') {
    const button = event.target.closest('[data-control-action]');
    button.disabled = true; button.textContent = 'Saving snapshot...';
    try {
      await approvedRequest('/api/backup/snapshot', { method: 'POST', body: '{}' }, 'Save an encrypted snapshot in the configured local folder?');
      notify('Encrypted local snapshot saved.');
    } catch (error) { notify(error.message, true); }
    finally { button.disabled = false; await refresh(); }
    return;
  }
  if (action === 'backup-schedule') {
    const button = event.target.closest('[data-control-action]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const schedule = state.data.settings.backupSchedule || {};
      if (schedule.enabled) {
        const accepted = await window.hexigridModal({ title: 'Turn off automatic snapshots?', message: `Existing encrypted snapshots stay in ${schedule.directory || 'Documents/HexiGrid Backups'}. The saved backup passphrase is removed from the operating-system vault.`, accept: 'Turn off', danger: true });
        if (!accepted) return;
        await approvedRequest('/api/backup/schedule', { method: 'PATCH', body: JSON.stringify({ enabled: false, confirmed: true }) }, 'Turn off automatic local snapshots?');
      } else {
        const answer = await window.hexigridModal({ title: 'Automatic encrypted snapshots', message: 'HexiGrid will save an encrypted snapshot in Documents/HexiGrid Backups. The password is protected by your operating-system vault and is never shown to agents.', accept: 'Enable snapshots', fields: [{ label: 'Backup passphrase (12+ characters)', type: 'password', required: true, minLength: 12 }, { label: 'Frequency', options: ['24 — Daily', '168 — Weekly'] }] });
        if (!answer?.[0]) return;
        await approvedRequest('/api/backup/schedule', { method: 'PATCH', body: JSON.stringify({ enabled: true, passphrase: answer[0], intervalHours: Number(String(answer[1] || '24').split(' — ')[0]), confirmed: true }) }, 'Enable automatic encrypted local snapshots?');
      }
      notify('Automatic snapshot settings updated.');
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { button.disabled = false; }
    return;
  }
  if (action === 'backup-directory') {
    const button = event.target.closest('[data-control-action]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const selection = await window.hexigridDesktop?.chooseBackupDirectory?.();
      if (!selection || selection.canceled) return;
      if (!selection.directory) throw new Error('Choose a backup folder on this computer.');
      await approvedRequest('/api/backup/schedule', {
        method: 'PATCH', body: JSON.stringify({ enabled: true, directory: selection.directory, confirmed: true })
      }, `Save future encrypted snapshots in ${selection.directory}?`);
      notify('Backup folder updated.');
      await refresh();
    } catch (error) { notify(error.message, true); }
    finally { button.disabled = false; }
    return;
  }
  if (action === 'logout') { await api('/api/auth/logout', { method: 'POST' }); location.reload(); }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-control-action="import-backup"]');
  if (!button) return;
  event.stopImmediatePropagation();
  const input = document.querySelector('#backupFile');
  input.value = '';
  input.click();
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      let envelope;
      try { envelope = JSON.parse(await file.text()); }
      catch { throw new Error('This file is not a valid encrypted HexiGrid backup.'); }
      const answer = await modalRequest({ title: 'Restore encrypted backup?', message: 'This replaces local control-room records on this device. Provider and tool keys remain device-specific.', accept: 'Restore backup', danger: true, fields: [{ label: 'Backup passphrase', type: 'password', required: true }] });
      if (!answer?.[0]) return;
      await approvedRequest('/api/backup/import', { method: 'POST', body: JSON.stringify({ envelope, passphrase: answer[0], confirmReplace: true }) }, 'Restore this encrypted backup and pause imported automation for review?');
      notify('Backup restored.');
      await refresh();
    } catch (error) { notify(error.message, true); }
  };
}, true);

document.addEventListener('click', async (event) => {
  if (!event.target.closest('[data-control-action="backup-rollback"]')) return;
  event.stopImmediatePropagation();
  const accepted = window.hexigridModal && await window.hexigridModal({ title: 'Roll back the last restore?', message: 'HexiGrid will restore the encrypted local state and private files that were present immediately before the last backup restore. Provider and tool secrets remain device-specific.', accept: 'Roll back restore', danger: true });
  if (!accepted) return;
  try { await approvedRequest('/api/backup/rollback', { method: 'POST', body: JSON.stringify({}) }, 'Roll back the last restore and replace the current local state?'); notify('The last restore was rolled back.'); await refresh(); }
  catch (error) { notify(error.message, true); }
}, true);
