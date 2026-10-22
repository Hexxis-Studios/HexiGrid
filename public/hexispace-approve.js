(() => {
  const params = new URLSearchParams(location.search);
  const form = document.querySelector('#approveForm');
  const code = document.querySelector('#pairingCode');
  const status = document.querySelector('#status');
  code.value = params.get('code') || '';
  const csrf = () => decodeURIComponent(document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('hexigrid_csrf='))?.slice('hexigrid_csrf='.length) || '');
  const show = (text, error = false) => { status.textContent = text; status.dataset.error = error ? 'true' : 'false'; };
  fetch('/api/auth/status', { credentials: 'same-origin' }).then(async (response) => {
    const value = await response.json();
    if (!value.authenticated) show('Sign in to HexiGrid in this browser first, then return to this page.', true);
  }).catch(() => show('HexiGrid could not check your sign-in state.', true));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const scopes = [...form.querySelectorAll('input[name="scope"]:checked')].map((input) => input.value);
    try {
      const response = await fetch('/api/hexispace/v1/pairing/approve', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-hexigrid-csrf': csrf() }, body: JSON.stringify({ code: code.value.trim().toUpperCase(), scopes }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The connection could not be approved.');
      show('Approved. Return to HexiSpace; it will finish connecting automatically.');
      form.querySelector('button').disabled = true;
    } catch (error) { show(error instanceof Error ? error.message : 'The connection could not be approved.', true); }
  });
})();
