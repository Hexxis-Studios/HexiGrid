function pluginPermissionText(capability) {
  const files = capability.permissions?.files || {};
  const parts = [];
  if (files.readRoots?.length) parts.push(`Read: ${files.readRoots.join(', ')}`);
  if (files.writeRoots?.length) parts.push(`Write: ${files.writeRoots.join(', ')}`);
  for (const rule of capability.permissions?.network || []) parts.push(`${rule.methods.join('/')} ${rule.origin}${rule.pathPrefix}`);
  return parts.join(' · ') || 'No file or network access';
}

function renderPlugins() {
  const root = document.querySelector('#pluginList');
  if (!root) return;
  const plugins = state.data?.plugins || [];
  root.innerHTML = plugins.map((plugin) => `<article class="plugin-item ${plugin.quarantined ? 'plugin-quarantined' : ''}"><div><strong>${escapeHtml(plugin.name)}</strong><small>${escapeHtml(plugin.id)} · v${escapeHtml(plugin.version)} · ${escapeHtml(plugin.trust || 'untrusted')}</small></div><p>${escapeHtml(plugin.description || 'No description supplied.')}</p>${plugin.quarantined ? `<div class="warning-callout"><strong>Quarantined</strong><p>${escapeHtml(plugin.quarantineReason || 'Package verification failed.')}</p></div>` : `<div class="security-status"><span class="status-badge">VERIFIED</span><span title="${escapeHtml(plugin.package?.digest || '')}">${escapeHtml((plugin.package?.digest || '').slice(0, 24))}…</span></div>`}<div class="plugin-capabilities">${plugin.capabilities.map((capability) => `<span><strong>${escapeHtml(capability.label)}</strong> · ${escapeHtml(capability.risk)}<br><small>${escapeHtml(pluginPermissionText(capability))} · ${capability.limits.timeoutMs} ms · ${capability.limits.memoryMb} MB</small></span>`).join('')}</div>${plugin.credentialError ? `<div class="warning-callout"><strong>Credentials unavailable</strong><p>${escapeHtml(plugin.credentialError)}</p></div>` : ''}${plugin.removalPending ? `<div class="warning-callout"><strong>Cleanup pending</strong><p>${escapeHtml(plugin.removalError || 'Retry Remove to finish cleanup. This plugin cannot run.')}</p></div>` : ''}<div class="provider-actions"><button class="secondary-button" data-plugin-toggle="${plugin.id}" data-plugin-enabled="${!plugin.enabled}" ${plugin.quarantined || plugin.removalPending || plugin.credentialError ? 'disabled' : ''}>${plugin.enabled ? 'Disable' : 'Enable'}</button>${plugin.capabilities.map((capability) => `<button class="secondary-button" data-plugin-execute="${plugin.id}" data-plugin-capability="${capability.id}" ${plugin.enabled && !plugin.removalPending ? '' : 'disabled'}>Run ${escapeHtml(capability.label)}</button>`).join('')}${plugin.secrets?.length ? `<button class="secondary-button" data-plugin-secrets="${plugin.id}" ${isHostBrowser() ? '' : 'disabled'}>Credentials</button>` : ''}${plugin.secrets?.length ? `<button class="secondary-button" data-plugin-hexikeys="${plugin.id}" ${isHostBrowser() ? '' : 'disabled'}>Use HexiKeys</button>` : ''}${plugin.publisher ? `<button class="ghost-button" data-plugin-revoke-publisher="${plugin.publisher.id}" ${isHostBrowser() ? '' : 'disabled'}>Revoke publisher</button>` : ''}<button class="ghost-button" data-plugin-remove="${plugin.id}">${plugin.removalPending ? 'Retry removal' : 'Remove'}</button></div></article>`).join('') || '<div class="empty-state">No plugins installed. The list is empty until you upload a verified package.</div>';
  renderPluginPublishers();
}

function renderPluginPublishers() {
  const root = document.querySelector('#pluginPublisherList');
  if (!root) return;
  const publishers = state.data?.pluginPublishers || [];
  root.innerHTML = publishers.map((publisher) => `<article class="plugin-item"><div><strong>${escapeHtml(publisher.name)}</strong><small>${escapeHtml(publisher.id)}</small></div><div class="security-status"><span class="status-badge ${publisher.trusted ? '' : 'warn'}">${publisher.cleanupPending ? 'REVOKED · CLEANUP PENDING' : publisher.revoked ? 'REVOKED' : publisher.trusted ? 'TRUSTED ON THIS DEVICE' : 'KEY NOT AVAILABLE'}</span></div><p>Fingerprint <code>${escapeHtml(publisher.fingerprint)}</code></p><button class="ghost-button" data-plugin-revoke-publisher="${publisher.id}" ${isHostBrowser() ? '' : 'disabled'}>${publisher.cleanupPending ? 'Retry key cleanup' : 'Revoke trust'}</button></article>`).join('') || '<div class="empty-state">No publisher keys are recorded on this device.</div>';
}

async function installPlugin(event) {
  event.preventDefault();
  const files = [...document.querySelector('#pluginFiles').files];
  const feedback = document.querySelector('#pluginFeedback');
  try {
    const decoded = await Promise.all(files.map(async (file) => ({ path: file.webkitRelativePath || file.name, content: await file.text() })));
    const manifestFile = decoded.find((file) => file.path.toLowerCase() === 'plugin.json' || file.path.toLowerCase().endsWith('/plugin.json'));
    if (!manifestFile) throw new Error('Choose a package containing plugin.json.');
    const base = manifestFile.path.slice(0, -'plugin.json'.length);
    const request = { manifest: JSON.parse(manifestFile.content), files: decoded.filter((file) => file !== manifestFile).map((file) => ({ path: base && file.path.startsWith(base) ? file.path.slice(base.length) : file.path, content: file.content })), localOwnerApproved: document.querySelector('#pluginLocalTrust').checked };
    let installed = false;
    while (!installed) {
      try { await api('/api/plugins/install', { method: 'POST', body: JSON.stringify(request) }); installed = true; }
      catch (error) {
        if (error.body?.approvalRequired && window.hexigridModal && await window.hexigridModal({ title: 'Approve plugin installation?', message: error.message, accept: 'Approve once', danger: true })) { request.approved = true; continue; }
        if (error.body?.publisherTrustRequired && window.hexigridModal && await window.hexigridModal({ title: 'Trust signed publisher?', message: `${error.body.publisher?.name || error.body.publisher?.id}\nFingerprint: ${error.body.publisher?.fingerprint}\n\nThis trusts future correctly signed packages from this exact key until you revoke it.`, accept: 'Trust publisher', danger: true })) { request.trustPublisher = true; continue; }
        if (error.body?.localTrustRequired && window.hexigridModal && await window.hexigridModal({ title: 'Trust unsigned local package?', message: 'Only continue if you created this package or reviewed every file. It will still run in the restricted brokered sandbox.', accept: 'I reviewed it', danger: true })) { request.localOwnerApproved = true; continue; }
        throw error;
      }
    }
    feedback.textContent = 'Verified and installed disabled. Review its exact permissions, then enable it.';
    document.querySelector('#pluginForm').reset();
    await refresh();
  } catch (error) { feedback.textContent = error.message; }
}

function pluginInputFields(capability) {
  const schema = capability.inputSchema || {};
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties || {}).map(([name, property]) => {
    const json = property.type === 'object' || property.type === 'array';
    const value = property.default ?? (property.type === 'boolean' ? false : property.type === 'array' ? [] : property.type === 'object' ? {} : '');
    return { name, label: property.title || name, description: property.description || '', required: required.has(name), type: property.type === 'boolean' ? 'checkbox' : property.type === 'number' || property.type === 'integer' ? 'number' : 'text', multiline: json, json, options: property.enum, value: json ? JSON.stringify(value) : value };
  });
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-plugin-hexikeys]');
  if (!button || !isHostBrowser() || !window.hexigridModal) return;
  const plugin = (state.data?.plugins || []).find(item => item.id === button.dataset.pluginHexikeys);
  if (!plugin) return;
  const choices = [];
  for (const capability of plugin.capabilities) for (const [ruleIndex, rule] of capability.permissions.network.entries()) {
    if (!rule.origin.startsWith('https://')) continue;
    for (const mapping of rule.secretHeaders) choices.push({ capability, ruleIndex, secretId: mapping.secret,
      label: `${choices.length + 1}. ${capability.label} · ${mapping.secret} · ${rule.methods.join('/')} ${rule.origin}${rule.pathPrefix}` });
  }
  if (!choices.length) { notify('This plugin has no declared HTTPS credential destination.', true); return; }
  const recipients = [{ label: 'You, on this computer', id: '' }, ...(state.data?.agentLinks || []).filter(link => link.trustLevel === 'owner' && (link.authorizationStatus || link.status) === 'connected').map(link => ({ label: `${link.identity?.name || 'Owner agent'} · ${link.id.slice(-8)}`, id: link.id }))];
  const selection = await window.hexigridModal({ title: 'Use a saved HexiKeys item', message: 'Choose who can use the reference and the exact operation. The saved value stays in HexiKeys.', accept: 'Prepare field approval', fields: [
    { label: 'Operation and destination', options: choices.map(item => item.label), value: choices[0].label },
    { label: 'Who will run it?', options: recipients.map(item => item.label), value: recipients[0].label }
  ] });
  if (selection === null) return;
  const choice = choices.find(item => item.label === selection[0]);
  const recipient = recipients.find(item => item.label === selection[1]);
  if (!choice || !recipient) return;
  const input = { capability: choice.capability.id, secretId: choice.secretId, ...(recipient.id ? { recipientLinkId: recipient.id } : {}) };
  try {
    const result = await api(`/api/plugins/${plugin.id}/hexikeys-scope`, { method: 'POST', body: JSON.stringify({ ...input, ruleIndex: choice.ruleIndex }) });
    const answer = await window.hexigridModal({ title: 'Approve the saved field in HexiKeys', message: 'In HexiKeys, select your saved item → Share one field with HexiGrid. Paste this scope recipe, review it, and copy the resulting reference ID here. To stop use, revoke the field in HexiKeys or remove this binding.', accept: 'Connect reference', fields: [
      { label: 'Scope recipe (no credential values)', multiline: true, readonly: true, value: JSON.stringify(result.recipe, null, 2), rows: 8 },
      { label: 'Reference ID from HexiKeys', required: !result.configured, description: 'An opaque ID, never the password or key. Leave blank only when removing a configured binding.' },
      { label: 'Remove this recipient’s binding', type: 'checkbox', value: false }
    ] });
    if (answer === null) return;
    if (!answer[2] && !/^[0-9a-f]{32}$/.test(answer[1])) throw new Error('Paste the opaque reference ID created in HexiKeys.');
    await approvedRequest(`/api/plugins/${plugin.id}/hexikeys-reference`, { method: 'POST', body: JSON.stringify({ ...input, grantId: answer[2] ? null : answer[1] }) }, 'Connect this exact HexiKeys reference?');
    notify('Reference updated. Review and enable the plugin.');
    await refresh();
  } catch (error) { notify(error.message, true); }
});

document.querySelector('#pluginForm').addEventListener('submit', installPlugin);
document.addEventListener('click', (event) => { if (event.target.closest('[data-control-action="refresh-plugins"]')) refresh(); });

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-plugin-execute]');
  if (!button) return;
  const plugin = (state.data?.plugins || []).find((item) => item.id === button.dataset.pluginExecute);
  const capability = plugin?.capabilities.find((item) => item.id === button.dataset.pluginCapability);
  if (!plugin || !capability) return;
  const fields = pluginInputFields(capability);
  const answer = window.hexigridModal ? await window.hexigridModal({ title: capability.label, message: `Exact access: ${pluginPermissionText(capability)}. Risk: ${capability.risk}.`, accept: 'Run capability', fields }) : null;
  if (answer === null) return;
  const input = {};
  let valid = true;
  fields.forEach((field, index) => {
    let value = answer[index];
    try {
      if (field.type === 'number') { value = Number(value); if (!Number.isFinite(value)) throw new Error('must be a number'); }
      if (field.json) value = JSON.parse(value);
      input[field.name] = value;
    } catch { notify(`${field.label} is not valid ${field.json ? 'JSON' : 'input'}.`, true); valid = false; }
  });
  if (!valid) return;
  const request = { capability: capability.id, input };
  const showResult = async (result) => window.hexigridModal({ title: `${capability.label} completed`, message: JSON.stringify(result?.result ?? result, null, 2).slice(0, 12000) || 'The capability completed without a result.', accept: 'Done' });
  try { const result = await api(`/api/plugins/${plugin.id}/run`, { method: 'POST', body: JSON.stringify(request) }); await showResult(result); await refresh(); }
  catch (error) {
    if (error.body?.approvalRequired && window.hexigridModal && await window.hexigridModal({ title: 'Approve plugin action?', message: error.message, accept: 'Approve once', danger: true })) {
      try { const result = await api(`/api/plugins/${plugin.id}/run`, { method: 'POST', body: JSON.stringify({ ...request, approved: true }) }); await showResult(result); await refresh(); }
      catch (runError) { notify(runError.message, true); }
    }
    else notify(error.message, true);
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-plugin-toggle]');
  if (!button) return;
  event.stopImmediatePropagation();
  const enabled = button.dataset.pluginEnabled === 'true';
  try { await approvedRequest(`/api/plugins/${button.dataset.pluginToggle}/enable`, { method: 'PATCH', body: JSON.stringify({ enabled }) }, enabled ? 'Enable this plugin and its declared capabilities?' : 'Disable this plugin?'); await refresh(); }
  catch (error) { notify(error.message, true); }
}, true);

document.addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-plugin-remove]');
  if (remove) {
    const accepted = window.hexigridModal && await window.hexigridModal({ title: 'Remove this plugin?', message: 'Its local bundle and protected credentials will be removed. Execution stops immediately; failed cleanup can be retried.', accept: 'Remove plugin', danger: true });
    if (!accepted) return;
    try { await approvedRequest(`/api/plugins/${remove.dataset.pluginRemove}`, { method: 'DELETE', body: JSON.stringify({}) }, 'Remove this plugin from the local workspace?'); await refresh(); }
    catch (error) { await refresh().catch(() => {}); notify(error.message, true); }
    return;
  }
  const credentials = event.target.closest('[data-plugin-secrets]');
  if (credentials) {
    const plugin = (state.data?.plugins || []).find((item) => item.id === credentials.dataset.pluginSecrets);
    if (!plugin || !isHostBrowser()) return;
    const fields = plugin.secrets.map((secret) => ({ label: `${secret.label}${plugin.secretStatus?.[secret.id] ? ' (configured)' : ''}`, type: 'password', required: secret.required && !plugin.secretStatus?.[secret.id], description: 'Leave blank to keep the existing value.' }));
    fields.push({ label: 'Remove every saved credential for this plugin', type: 'checkbox', value: false });
    const answer = await window.hexigridModal({ title: 'Plugin credentials', message: 'Values stay in the device OS vault and are never exposed to plugin code. Updating disables this plugin until you review and enable it again.', accept: 'Save credentials', fields });
    if (answer === null) return;
    const clearAll = answer[fields.length - 1] === true;
    const secrets = {};
    plugin.secrets.forEach((secret, index) => { if (clearAll) secrets[secret.id] = ''; else if (answer[index]) secrets[secret.id] = answer[index]; });
    if (!Object.keys(secrets).length) return;
    try { await approvedRequest(`/api/plugins/${plugin.id}/secrets`, { method: 'PUT', body: JSON.stringify({ secrets }) }, 'Allow this plugin credential update?'); notify(clearAll ? 'Credentials removed. Review and enable this plugin to run it again.' : 'Credentials saved. Review and enable this plugin to run it again.'); await refresh(); }
    catch (error) { await refresh().catch(() => {}); notify(error.message, true); }
    return;
  }
  const revoke = event.target.closest('[data-plugin-revoke-publisher]');
  if (!revoke) return;
  try { await approvedRequest(`/api/plugin-publishers/${revoke.dataset.pluginRevokePublisher}`, { method: 'DELETE', body: JSON.stringify({}) }, 'Revoke this publisher and quarantine every installed package signed by it?'); notify('Publisher revoked. Affected plugins are quarantined.'); await refresh(); }
  catch (error) { await refresh().catch(() => {}); notify(error.message, true); }
});
