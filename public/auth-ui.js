let authSetupMode = false;
let currentAuthStatus = null;

function showAuthGate(setup) {
  authSetupMode = setup === undefined ? authSetupMode : setup;
  const gate = document.querySelector('#authGate');
  if (!gate) return;
  const browser = isStandaloneBrowser();
  // Google identifies the owner, but a standalone browser still needs its
  // local passcode to decrypt the browser vault after a reload.
  const googleOnly = Boolean(!browser && !authSetupMode && currentAuthStatus?.googleLinked && !currentAuthStatus?.localPasscode);
  document.querySelector('#onboarding')?.classList.add('hidden');
  gate.classList.remove('hidden');
  gate.setAttribute?.('aria-hidden', 'false');
  document.body.classList.add('overlay-open');
  document.querySelector('#authTitle').textContent = authSetupMode ? 'Create your local passcode' : 'Unlock this control room';
  document.querySelector('#authCopy').textContent = authSetupMode
    ? browser ? 'This passcode creates the encryption key for data and provider keys saved in this browser. It is never stored and there is no recovery backdoor.' : 'This passcode protects this HexiGrid workspace. It is never uploaded or shown to an agent.'
    : googleOnly ? 'Continue with the Google account linked to this HexiGrid workspace to unlock it. Your data stays on this computer.'
      : browser ? 'Enter the passcode for this browser workspace. No desktop or Node.js process is involved.' : 'Enter the passcode for this local workspace. Your data stays on the computer running HexiGrid.';
  document.querySelector('#authConfirmWrap').classList.toggle('hidden', !authSetupMode);
  document.querySelector('#authForm').classList.toggle('hidden', googleOnly);
  document.querySelector('#authSubmit').textContent = authSetupMode ? 'Protect this workspace' : 'Unlock';
  document.querySelector('#authSwitch').classList.toggle('hidden', googleOnly);
  document.querySelector('#authSwitch').textContent = authSetupMode ? 'I already have a passcode' : 'Create a local passcode instead';
  document.querySelector('#authPassword').autocomplete = authSetupMode ? 'new-password' : 'current-password';
  window.HexiGridInertScopes?.set('auth', true, [gate, document.getElementById?.('offlineState')]);
  (googleOnly ? document.querySelector('#authGoogle') : document.querySelector('#authPassword'))?.focus?.({ preventScroll: true });
  window.hexigridBoot?.dismissForAuth?.();
}
window.showAuthGate = showAuthGate;

function containAuthTabFocus(event) {
  if (event.key !== 'Tab') return;
  const gate = document.querySelector('#authGate');
  const controls = [...(gate?.querySelectorAll('input,button,a[href],[tabindex]:not([tabindex="-1"])') || [])]
    .filter(control => !control.disabled && control.getClientRects().length);
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || !gate.contains(document.activeElement))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (document.activeElement === last || !gate.contains(document.activeElement))) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}
document.querySelector('#authGate')?.addEventListener('keydown', containAuthTabFocus);

function hideAuthGate() {
  const gate = document.querySelector('#authGate');
  if (!gate) return;
  gate.classList.add('hidden');
  gate.setAttribute?.('aria-hidden', 'true');
  document.body.classList.remove('overlay-open');
  window.HexiGridInertScopes?.set('auth', false);
}
window.hideAuthGate = hideAuthGate;

async function initAuth() {
  try {
    let status = await api('/api/auth/status');
    currentAuthStatus = status;
    document.querySelector('#authGoogle').classList.toggle('hidden', !window.HexiGridGoogle);
    document.querySelector('#authGoogle').textContent = 'Continue with Google';
    if (!status.configured) showAuthGate(true);
    else if (!status.authenticated) showAuthGate(false);
    window.hexigridAuthInitialized = true;

    await window.hexigridGoogleReady;
    status = await api('/api/auth/status');
    currentAuthStatus = status;
    if (status.authenticated) {
      hideAuthGate();
      // The first bootstrap can precede restored Google identity and return
      // 401, leaving state.data empty. Always load after successful unlock.
      await refresh();
    }
  } catch (error) { notify(`Sign-in status unavailable: ${error.message}`, true); }
}

async function submitAuth(event) {
  event.preventDefault();
  const password = document.querySelector('#authPassword').value;
  const feedback = document.querySelector('#authFeedback');
  if (authSetupMode && password !== document.querySelector('#authPasswordConfirm').value) {
    feedback.textContent = 'The two passcodes do not match.';
    return;
  }
  try {
    const result = await api(authSetupMode ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
    hideAuthGate();
    document.querySelector('#authPassword').value = '';
    document.querySelector('#authPasswordConfirm').value = '';
    if (result.recoveryCode && window.hexigridModal) await window.hexigridModal({ title: 'Save your recovery code', message: `Store this somewhere private. It is shown once and can reset the local passcode.\n\n${result.recoveryCode}`, accept: 'I saved it' });
    await refresh();
  } catch (error) { feedback.textContent = error.message; }
}

document.querySelector('#authForm').addEventListener('submit', submitAuth);
document.querySelector('#authSwitch').addEventListener('click', () => showAuthGate(!authSetupMode));
document.querySelector('#authGoogle').addEventListener('click', async () => {
  const feedback = document.querySelector('#authFeedback');
  const button = document.querySelector('#authGoogle');
  if (button.disabled) return;
  button.disabled = true;
  feedback.textContent = 'Opening Google account chooser. Choose the owner account, then HexiGrid will finish sign-in automatically.';
  try {
    const account = await window.connectHexiGridGoogle?.({ unlock: true });
    if (!account) return;
    if (isStandaloneBrowser()) {
      feedback.textContent = 'Google is connected. Create or enter your local encryption passcode to open this browser workspace.';
      return;
    }
    hideAuthGate();
    await refresh();
  }
  catch (error) { feedback.textContent = error.message; }
  finally { button.disabled = false; }
});
window.hexigridAuthReady = initAuth();
