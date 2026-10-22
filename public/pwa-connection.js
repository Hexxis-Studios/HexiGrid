(function installConnectivityGuard(scope) {
  let status = navigator.onLine === false ? 'offline' : 'verifying';
  const inertByElement = new Map();
  const elementsByScope = new Map();

  function setInertScope(name, enabled, excluded = []) {
    const exclusions = new Set((Array.isArray(excluded) ? excluded : [excluded]).filter(Boolean));
    const previous = elementsByScope.get(name) || new Set();
    const next = enabled
      ? new Set([...document.body.children].filter(element => !exclusions.has(element)))
      : new Set();

    for (const element of previous) {
      if (next.has(element)) continue;
      const state = inertByElement.get(element);
      if (!state) continue;
      state.scopes.delete(name);
      if (!state.scopes.size) {
        element.inert = state.wasInert;
        inertByElement.delete(element);
      }
    }
    for (const element of next) {
      let state = inertByElement.get(element);
      if (!state) {
        state = { wasInert: element.inert, scopes: new Set() };
        inertByElement.set(element, state);
      }
      state.scopes.add(name);
      element.inert = true;
    }
    if (next.size) elementsByScope.set(name, next);
    else elementsByScope.delete(name);
  }

  scope.HexiGridInertScopes = Object.freeze({ set: setInertScope });

  function ensurePanel() {
    let panel = document.getElementById('offlineState');
    if (panel) return panel;
    panel = document.createElement('section');
    panel.id = 'offlineState';
    panel.className = 'offline-state';
    panel.setAttribute('role', 'alert');
    panel.setAttribute('aria-live', 'assertive');
    panel.innerHTML = '<div class="offline-state-card"><span class="offline-state-signal" aria-hidden="true"></span><p class="eyebrow">LOCAL CONNECTION</p><h1>HexiGrid is disconnected</h1><p>Reconnect to return to your workspace. Live agents, tools, messages, and device controls are unavailable until this device reconnects.</p><a class="secondary-button" href="/offline-help.html">Offline help</a> <button class="primary-button" type="button" data-pwa-retry>Try again</button></div>';
    document.body.append(panel);
    panel.querySelector('[data-pwa-retry]').addEventListener('click', () => {
      markVerifying();
      scope.dispatchEvent(new CustomEvent('hexigrid:reconnect-requested'));
    });
    return panel;
  }

  function focusAuthGate(gate) {
    if (!gate || gate.classList.contains('hidden')) return;
    const form = gate.querySelector('#authForm');
    const target = form && !form.classList.contains('hidden')
      ? gate.querySelector('#authPassword')
      : gate.querySelector('#authGoogle');
    target?.focus?.({ preventScroll: true });
  }

  function apply(nextStatus) {
    status = nextStatus;
    const disconnected = status !== 'online';
    document.body.classList.toggle('app-disconnected', disconnected);
    document.body.classList.toggle('app-verifying', status === 'verifying');
    const panel = ensurePanel();
    const authGate = document.getElementById('authGate');
    const authVisible = Boolean(authGate && !authGate.classList.contains('hidden'));
    setInertScope('connectivity', disconnected, panel);
    setInertScope('auth', authVisible, [authGate, panel]);
    if (!disconnected && authVisible) focusAuthGate(authGate);
    panel.hidden = !disconnected;
    panel.setAttribute('aria-hidden', disconnected ? 'false' : 'true');
    const title = panel.querySelector('h1');
    const copy = panel.querySelector('p:not(.eyebrow)');
    if (status === 'verifying') {
      title.textContent = 'Checking the local connection';
      copy.textContent = 'Live status stays hidden until HexiGrid confirms a fresh connection.';
    } else if (status === 'offline') {
      title.textContent = 'HexiGrid is disconnected';
      copy.textContent = 'Reconnect to return to your workspace. Live agents, tools, messages, and device controls are unavailable until this device reconnects.';
    }
  }

  function markOffline() { apply('offline'); }
  function markVerifying() { apply('verifying'); }
  function markOnline() { apply('online'); }

  scope.HexiGridConnectivity = Object.freeze({ markOffline, markVerifying, markOnline, get status() { return status; } });
  scope.addEventListener('offline', markOffline);
  scope.addEventListener('online', () => {
    markVerifying();
    scope.dispatchEvent(new CustomEvent('hexigrid:reconnect-requested'));
  });
  document.addEventListener('DOMContentLoaded', () => apply(status));
})(window);
