(() => {
  const path = '/api/addons/hexikeys';
  const panels = [...document.querySelectorAll('[data-hexikeys-addon]')];
  async function request(action = '', body) {
    const raw = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('hexigrid_csrf='))?.slice(14) || '';
    const csrf = raw ? decodeURIComponent(raw) : '';
    const response = await fetch(path + (action ? `/${action}` : ''), { method: action ? 'POST' : 'GET',
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json',
        ...(action ? { 'content-type': 'application/json', 'x-hexigrid-csrf': csrf } : {}) },
      ...(action ? { body: JSON.stringify(body || {}) } : {}) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'HexiKeys could not be reached.'); error.approvalRequired = result.approvalRequired === true; throw error; }
    return ['open', 'request-capture'].includes(action) ? result : result.addon;
  }
  for (const panel of panels) {
    panel.innerHTML = '<div class="eyebrow">BUILT-IN ADDON · LOCAL ONLY</div><h2>HexiKeys</h2><p>Your passwords, keys and PINs stay in one encrypted vault. Agents use approved references.</p><p data-hexikeys-status role="status" aria-live="polite">Check the connection when HexiKeys is open.</p><div class="provider-actions"><button type="button" class="primary-button" data-hexikeys-action="open">Open vault</button><button type="button" class="secondary-button" data-hexikeys-action="refresh">Check connection</button><button type="button" class="primary-button" data-hexikeys-action="connect">Connect HexiKeys</button><button type="button" class="ghost-button" data-hexikeys-action="disconnect" hidden>Disconnect</button></div><p class="panel-copy">First open and unlock HexiKeys, then choose Connect HexiGrid there. After that, connect here. Locking the vault stops access to its saved values. Field approval and secret capture stay in the protected vault window.</p>';
    panel.querySelector('[data-hexikeys-action="open"]').insertAdjacentHTML('afterend', '<button type="button" class="secondary-button" data-hexikeys-action="request-capture">New vault item</button>');
    const output = panel.querySelector('[data-hexikeys-status]');
    let busy = false;
    let captureDraft = { title: '', category: 'Password', fieldLabel: 'Password' };
    panel.addEventListener('click', async event => {
      const button = event.target.closest('[data-hexikeys-action]');
      if (!button || busy) return;
      busy = true;
      const buttons = [...panel.querySelectorAll('button')];
      buttons.forEach(item => { item.disabled = true; });
      const action = button.dataset.hexikeysAction;
      output.textContent = action === 'refresh' ? 'Checking connection…' : action === 'request-capture' ? 'Describe the new item. Keep its secret in HexiKeys.' : 'Updating protected connection…';
      try {
        let body;
        if (action === 'request-capture') {
          if (!window.hexigridModal) throw new Error('The item editor is unavailable. Reload HexiGrid, then try again.');
          const values = await window.hexigridModal({
            title: 'New vault item', accept: 'Continue in HexiKeys',
            message: 'Describe the item here. Enter its password, key or other secret only in the protected HexiKeys window. This step does not save a value or grant agent access.',
            fields: [
              { label: 'Item name', required: true, maxLength: 120, value: captureDraft.title, placeholder: 'Example service' },
              { label: 'Category', value: captureDraft.category, options: ['Password', 'API key', 'Token', 'Recovery phrase', 'Backup codes', 'License key', 'Secure note', 'Screenshot OCR', 'Other'] },
              { label: 'Field label', required: true, maxLength: 80, value: captureDraft.fieldLabel, placeholder: 'Password or PIN' }
            ]
          });
          if (!values) { output.textContent = 'New item cancelled. Nothing was sent to HexiKeys.'; return; }
          body = { title: values[0].trim(), category: values[1], fieldLabel: values[2].trim() };
          captureDraft = body;
          if (!body.title || !body.fieldLabel || body.title.length > 120 || body.fieldLabel.length > 80) throw new Error('Enter a short item name and field label. Keep secret values in HexiKeys.');
        }
        let addon;
        try { addon = await request(action === 'refresh' ? '' : action, body); }
        catch (error) {
          if (!error.approvalRequired || !window.hexigridModal || !await window.hexigridModal({ title: 'Update HexiKeys connection?', message: error.message, accept: 'Approve once', danger: true })) throw error;
          addon = await request(action, { ...body, approved: true });
        }
        if (action === 'open') { output.textContent = 'HexiKeys opened in its protected desktop window. Unlock it there, then check the connection.'; return; }
        if (action === 'request-capture') {
          if (addon?.opened !== true) throw new Error('HexiKeys did not confirm opening the item form. Check its connection before trying again.');
          output.textContent = 'Item form opened in HexiKeys. Enter and save the secret there. No value has been saved or shared by HexiGrid.';
          return;
        }
        output.textContent = addon.paired === null ? 'Protected connection status is unavailable. Check the local credential vault, then try again.'
          : !addon.paired ? 'Not connected. Your saved vault remains in HexiKeys.'
          : !addon.available ? 'Paired, but HexiKeys is unavailable. Open and unlock it, then check again.'
          : addon.unlocked ? 'Connected · vault unlocked. Your saved items remain in HexiKeys.' : 'Connected · vault locked. Saved values are unavailable.';
        panel.querySelector('[data-hexikeys-action="disconnect"]').hidden = !addon.paired;
        panel.querySelector('[data-hexikeys-action="connect"]').hidden = addon.paired;
      } catch (error) { output.textContent = error.message; }
      finally { busy = false; buttons.forEach(item => { item.disabled = false; }); }
    });
  }
})();
