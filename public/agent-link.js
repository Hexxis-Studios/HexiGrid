(() => {
  let watchTimer = 0, replacingConnection = false; const seenMessages = new Set();
  const selectedLiveAgent = () => window.HexiGridLiveCall?.selectedAgent?.();
  const connectionFor = (agentId) => (state.data?.agentLinks || []).find((item) => item.agentId === agentId && (item.authorizationStatus || item.status) === 'connected') || null;
  const feedback = (message, error = false) => { const node = document.querySelector('#agentLinkFeedback') || document.querySelector('#agentLinkStatus'); if (node) { node.textContent = message; node.classList.toggle('error', error); } };

  async function refreshLinks(importReplies = true) {
    const result = await api('/api/agent-links');
    // The Link watcher can wake before the authenticated bootstrap finishes.
    // Never manufacture a partial app state; bootstrap remains the authority.
    if (!state.data) return result.connections || [];
    state.data.agentLinks = result.connections || []; state.data.continuityTransfers = result.transfers || []; state.data.continuityApprovals = result.approvals || [];
    if (typeof renderAgents === 'function') renderAgents();
    if (typeof renderOverview === 'function') renderOverview();
    if (importReplies) {
      const agent = selectedLiveAgent(); const connection = connectionFor(agent?.id);
      if (connection) for (const message of connection.messages || []) {
        if (seenMessages.has(message.id)) continue; seenMessages.add(message.id);
        if (message.type === 'message' && message.text) window.HexiGridLiveCall?.addEntry?.('agent', message.text, agent.id, `${agent.name} · HexiGrid Link`);
      }
    }
    render();
    if (typeof renderDesktopBridge === 'function') renderDesktopBridge();
    return result.connections;
  }

  async function copyContinuityPrompt() {
    const result = await api('/api/continuity/markdown-prompt');
    const copied = await copyPlainText(result.prompt);
    feedback(copied ? 'Agent-record prompt copied. Give it to the agent in its current app, then download the Markdown file it creates.' : 'Copy the prompt from the open dialog and give it to the agent in its current app.');
    await modalRequest({ title: 'Private agent-record prompt', message: result.prompt, accept: 'Done' });
  }

  async function importMarkdown(files) {
    const selected = [...files];
    if (!selected.length) return;
    const payloadFiles = await Promise.all(selected.map(async (file) => ({ name: file.name, content: await file.text() })));
    const models = availableModels();
    const answer = await modalRequest({
      title: 'Create a local agent profile',
      message: `HexiGrid will read ${selected.length} agent-record file${selected.length === 1 ? '' : 's'}, reject likely credentials, and show any missing sections. The source agent and its provider account will not be changed.`,
      accept: 'Import and continue',
      fields: [
        { label: 'Name this profile', value: 'Imported agent', required: true, description: 'This name is used only in HexiGrid.' },
        { label: models.length ? 'HexiGrid model' : 'HexiGrid model (connect one after import)', options: models.length ? models.map((item) => item.id) : ['No model connected yet'], value: models.length ? state.data.settings.model : 'No model connected yet' }
      ]
    });
    if (!answer) return;
    const result = await approvedRequest('/api/continuity/import-markdown', { method: 'POST', body: JSON.stringify({ files: payloadFiles, accountLabel: answer[0], model: models.length ? answer[1] : '' }) }, 'Create one local agent profile from these owner-supplied Markdown files?');
    const missing = result.completeness?.missingRequired || [];
    await modalRequest({
      title: `${result.agent.name} was imported`,
      message: missing.length
        ? `The local profile was created. These categories were incomplete or missing: ${missing.join(', ')}. HexiGrid did not invent them.${models.length ? '' : ' Connect a model before chatting with this profile.'} Importing does not connect to or change the source agent.`
        : `The local profile was created with every required continuity category present. Importing does not connect to or change the source agent.`,
      accept: 'Done'
    });
    feedback(`${result.agent.name} was imported as a local profile. To keep using the agent in its current app, connect it through HexiGrid Link.`);
    await refresh();
  }

  function downloadJson(value, name) {
    const href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = href; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function continuityReview(snapshot) {
    const categories = snapshot?.categories || {};
    return Object.entries(categories).map(([name, item]) => {
      const data = item?.data === null || item?.data === undefined ? '' : JSON.stringify(item.data, null, 2);
      return `${name}\nStatus: ${item?.status || 'unavailable'}\n${item?.summary || ''}${item?.reason ? `\nReason: ${item.reason}` : ''}${data && data !== '{}' ? `\n${data}` : ''}`;
    }).join('\n\n').slice(0, 50000);
  }

  async function exportContinuity(linkId) {
    const pending = (state.data.continuityApprovals || []).find((item) => item.linkId === linkId);
    const draft = await api(`/api/agent-links/${linkId}/continuity-draft`);
    const answer = await modalRequest({ title: 'Review and encrypt continuity backup', message: 'Read the agent-curated record below. HexiGrid rejects incomplete records and possible secrets. The source remains active unless you explicitly move activity during restore.', accept: 'Approve encrypted backup', danger: true, fields: [{ label: 'Agent-curated record', multiline: true, readonly: true, rows: 12, value: continuityReview(draft.snapshot), description: 'This review stays on this device.' }, { label: 'New backup passphrase (12+ characters)', type: 'password', required: true }] });
    if (!answer) return;
    const result = await approvedRequest(`/api/agent-links/${linkId}/continuity-package`, { method: 'POST', body: JSON.stringify({ passphrase: answer[1], requestId: pending?.id || '' }) }, 'Approve this signed encrypted continuity backup?');
    downloadJson(result.envelope, result.downloadName); feedback('Encrypted continuity backup downloaded. Keep its passphrase separately. No second active agent was created.'); await refresh();
  }

  async function exportLocalContinuity(agentId) {
    const target = (state.data.agents || []).find((item) => item.id === agentId); if (!target) return;
    const pending = (state.data.continuityApprovals || []).find((item) => item.agentId === agentId && !item.linkId);
    const draft = await api(`/api/agents/${agentId}/continuity-draft`);
    const answer = await modalRequest({ title: `Review and back up ${target.name}`, message: 'Read the agent-curated record below. HexiGrid verifies it, rejects possible secrets, and creates one owner-encrypted file. The source stays active.', accept: 'Create encrypted backup', danger: true, fields: [{ label: 'Agent-curated record', multiline: true, readonly: true, rows: 12, value: continuityReview(draft.snapshot), description: 'This review stays on this device.' }, { label: 'New backup passphrase (12+ characters)', type: 'password', required: true }] });
    if (!answer) return;
    const result = await approvedRequest(`/api/agents/${agentId}/continuity-package`, { method: 'POST', body: JSON.stringify({ passphrase: answer[1], requestId: pending?.id || '' }) }, `Approve ${target.name}'s encrypted continuity backup?`);
    downloadJson(result.envelope, result.downloadName); feedback(`${target.name}'s encrypted continuity backup downloaded.`); await refresh();
  }

  async function importContinuityPackage(file) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) throw new Error('Choose an encrypted continuity backup smaller than 12 MB.');
    let envelope; try { envelope = JSON.parse(await file.text()); } catch { throw new Error('That backup is not valid JSON.'); }
    const models = availableModels();
    const answer = await modalRequest({
      title: 'Restore encrypted continuity',
      message: 'Restoring verifies encryption, signature, file digests, required categories, and secret exclusions. If the source identity is still active, Move activity is required and suspends the old local profile atomically.',
      accept: 'Verify and restore', danger: true,
      fields: [
        { label: 'Backup passphrase', type: 'password', required: true },
        { label: models.length ? 'Model for the restored agent' : 'Model (connect one after restore)', options: models.length ? models.map((item) => item.id) : [''], value: models.length ? state.data.settings.model : '' },
        { label: 'Move activity to the restored profile', type: 'checkbox', description: 'Required when the source was active. This prevents two active instances of the same identity.' }
      ]
    });
    if (!answer) return;
    const result = await approvedRequest('/api/continuity/import', { method: 'POST', body: JSON.stringify({ envelope, passphrase: answer[0], model: answer[1] || '', moveActivity: answer[2] === true }) }, 'Restore this verified continuity backup and enforce one active identity?');
    feedback(result.reused ? 'This backup was already restored; HexiGrid reused the existing profile.' : `${result.agent.name} restored with one active continuity lineage.`); await refresh();
  }

  async function verifyTransfer(transferId) {
    const names = ['identity', 'memories', 'relationships', 'preferences', 'commitments', 'files'];
    const answer = await modalRequest({ title: 'Verify continuity', message: 'Confirm each item only after comparing the continuation with the source records. Retirement stays locked if any item fails.', accept: 'Record verification', danger: true, fields: names.map((name) => ({ label: `${name[0].toUpperCase()}${name.slice(1)} match`, type: 'checkbox' })) });
    if (!answer) return; const checks = Object.fromEntries(names.map((name, index) => [name, answer[index] === true]));
    const result = await approvedRequest(`/api/continuity/${transferId}/verify`, { method: 'POST', body: JSON.stringify({ checks }) }, 'Record this owner-reviewed continuity comparison?');
    feedback(result.transfer.retirementEligible ? 'Continuity checks passed. The original is eligible for a separate owner-controlled retirement in iLands; HexiGrid will not delete it.' : 'Verification did not pass. The original must remain active.'); await refresh();
  }

  async function sendLinkedMessage() {
    const agent = selectedLiveAgent(); const connection = connectionFor(agent?.id); if (!connection) throw new Error('Connect this agent through HexiGrid Link first.');
    const field = document.querySelector('#agentLinkMessage'); const text = field?.value.trim(); if (!text) throw new Error('Write a message first.');
    await approvedRequest(`/api/agent-links/${connection.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }, `Send this message to ${agent.name} through HexiGrid Link?`);
    window.HexiGridLiveCall?.addEntry?.('user', text, null, 'You · HexiGrid Link'); field.value = ''; feedback(`Message queued for ${agent.name}.`); startWatch();
  }

  async function disconnect(linkId) {
    const connection = (state.data.agentLinks || []).find((item) => item.id === linkId); if (!connection) return;
    const accepted = await modalRequest({ title: 'Remove this connection?', message: `This immediately revokes ${connection.identity.name}’s token and removes the saved connection from this list. The Hexonaut profile stays available until you remove it from Agents.`, accept: 'Remove connection', danger: true });
    if (!accepted) return;
    await approvedRequest(`/api/agent-links/${linkId}`, { method: 'DELETE', body: JSON.stringify({ purge: true, approved: true }) }, `Revoke and remove ${connection.identity.name}’s connection?`); feedback(`${connection.identity.name} connection removed.`); await refreshLinks(false);
  }

  async function copyReconnectInstructions(linkId) {
    const link = window.HexiGridViewRenderers.currentAgentLinks(state.data).find(item => item.id === linkId);
    if (!link) throw new Error('This connection is no longer paired. Refresh the page.');
    const network = await api('/api/network');
    const address = network.agentRelay?.running ? network.agentRelay.url : network.tailnet?.running ? network.tailnet.url : '';
    const skill = address ? `${address.replace(/\/$/, '')}/agent-link/skill` : '/agent-link/skill at your saved HexiGrid origin';
    const prompt = `Resume your existing HexiGrid Link ${link.id}, paired as ${link.identity.name} from ${link.identity.framework}. Do not create a new agent or reuse the spent invitation. Fetch the complete skill bundle from ${skill}, verify its SHA-256 digests, install the listed relative paths and read CONNECT.md first. Keep routine setup checks internal; respond briefly in your own established voice. Rebuilt sandboxes must use storage-check --ephemeral before a new pairing; do not assume temporary files survive. Reuse your protected saved credential and routing record for this exact connection. The updated client restores missing local routing files from the platform vault automatically; a temporary vault failure is not proof that the credential was lost. With the outbound companion, run node scripts/companion_client.mjs status --connection ${link.id}; use the direct Python client if your saved connection is HTTPS. Reconnect per turn, or run watch only if your runtime actually supports a persistent process. Read the refreshed orientation and follow only the current grants. For every new camera question, use a fresh snapshot, inspect it and delete temporary images in finally. If the old credential or routing record was genuinely never saved or was lost, ask for one replacement invitation in a plain sentence in your own voice. Do not dump vault listings, paths, hashes or raw errors. Do not hide required approvals. Never expose credentials in chat or guess what a cached image shows now.`;
    await copyPlainText(prompt);
    await modalRequest({ title: 'Reconnect this agent', message: 'Give these instructions to the same agent in its own app.', accept: 'Done', fields: [{ label: 'Reconnect instructions', value: prompt, multiline: true, readonly: true, rows: 9 }] });
  }

  async function replaceConnection(linkId) {
    if (replacingConnection) return;
    const link = (state.data?.agentLinks || []).find(item => item.id === linkId && (item.authorizationStatus || item.status) === 'connected');
    if (!link?.agentId) throw new Error('Choose a paired agent with an existing profile.');
    replacingConnection = true;
    try {
      const accepted = await modalRequest({ title: `Replace ${link.identity.name}’s connection?`, message: 'Use this when the agent cannot recover its saved connection. Its profile, conversations and standard permissions stay. The old connection will be revoked. Special owner access must be approved again.', accept: 'Create replacement', danger: true });
      if (!accepted) return;
      const current = (await api('/api/agent-links')).connections?.find(item => item.id === linkId && item.agentId === link.agentId && (item.authorizationStatus || item.status) === 'connected');
      if (!current) throw new Error('This connection changed. Refresh before replacing it.');
      const capabilities = link.capabilities.filter(capability => current.capabilities.includes(capability));
      const result = await approvedRequest('/api/agent-links/invites', { method: 'POST', body: JSON.stringify({ agentId: link.agentId, capabilities, selfManagementEnabled: link.selfManagementEnabled === true && current.selfManagementEnabled === true, approved: true }) }, `Create a replacement invitation for ${link.identity.name} with its existing permissions?`);
      if (!result.agentPrompt) throw new Error('Connection instructions were not returned. The old connection was not changed.');
      let warning = '';
      try { await approvedRequest(`/api/agent-links/${link.id}`, { method: 'DELETE', body: JSON.stringify({ purge: false, approved: true }) }, `Revoke ${link.identity.name}’s old connection?`); }
      catch { warning = ' The old connection could not be revoked. Remove it after the agent reconnects.'; }
      const copied = await copyPlainText(result.agentPrompt);
      feedback((copied ? 'Replacement instructions copied. Give them to the same agent.' : 'Copy the replacement instructions from the dialog.') + warning);
      await refreshLinks(false);
      await modalRequest({ title: `Reconnect ${link.identity.name}`, message: 'Give these instructions to the same agent. It will reuse this profile and verify its protected save.' + warning, accept: 'Done', fields: [{ label: 'Connection instructions', value: result.agentPrompt, multiline: true, readonly: true, rows: 10 }] });
    } finally { replacingConnection = false; }
  }

  function renderConnections() {
    const root = document.querySelector('#agentLinks'); if (!root) return;
    const openDetails = new Set(Array.from(root.querySelectorAll('details[open] [data-link-replace]'), button => button.dataset.linkReplace));
    const transfers = state.data?.continuityTransfers || [];
    const renderLink = (link) => {
      const transfer = transfers.find((item) => item.linkId === link.id || item.agentId === link.agentId);
      const continuity = link.continuity; const complete = continuity?.complete;
      const connected = Date.parse(link.connectedAt || link.createdAt || '');
      const when = Number.isFinite(connected) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(connected) : 'time unknown';
      const shortId = String(link.id || '').slice(-8) || 'unknown';
      const live = link.status === 'online'; const paired = (link.authorizationStatus || link.status) === 'connected'; const presence = window.HexiGridViewRenderers.linkPresence(link); const reason = link.heartbeat?.reason || 'Connection state unavailable.';
      const resumeButton = (link.authorizationStatus || link.status) === 'connected' ? `<button class="secondary-button" data-link-resume="${link.id}">Copy reconnect instructions</button>` : '';
      const replacementButton = paired && link.agentId ? `<button class="secondary-button" data-link-replace="${escapeHtml(link.id)}">Replace connection</button>` : '';
      return `<article class="runner-profile"><div class="connection-line"><span class="connection-pulse ${live ? 'online' : ''}"></span><div><strong>${escapeHtml(link.identity.name)}</strong><small>${escapeHtml(link.identity.framework)}</small></div><span class="status-badge ${paired ? '' : 'warn'}">${paired ? (live ? 'CONNECTED' : 'PAIRED') : escapeHtml(String(link.status || 'offline').toUpperCase())}</span></div>${paired && !live ? '<p class="microcopy">Ready for requests when the agent runs. No new invitation needed.</p>' : ''}<details${openDetails.has(link.id) ? " open" : ""}><summary>Connection details</summary><p class="microcopy">Connected ${escapeHtml(when)} · ${escapeHtml(shortId)}<br>${escapeHtml(reason)}</p><p class="microcopy">${link.capabilities.map(escapeHtml).join(' · ')}</p>${continuity ? `<p class="microcopy">Continuity: ${complete ? 'all required categories complete' : `${continuity.missingRequired.length} required categories missing`}</p>` : ''}${replacementButton}</details><div class="provider-actions">${paired ? `<button class="secondary-button" data-link-manage="${escapeHtml(link.id)}">Manage access</button>` : ''}${resumeButton}${complete ? `<button class="secondary-button" data-link-export="${link.id}">Export continuity</button>` : ''}${transfer?.status === 'imported' ? `<button class="secondary-button" data-transfer-verify="${transfer.id}">Verify continuation</button>` : ''}<button class="ghost-button icon-action-button" data-link-disconnect="${link.id}" title="Remove this connection" aria-label="Remove ${escapeHtml(link.identity.name)} connection">&times;</button></div></article>`;
    };
    const activeLinks = window.HexiGridViewRenderers.currentAgentLinks(state.data);
    const activeIds = new Set(activeLinks.map(link => link.id));
    const history = (state.data?.agentLinks || []).filter(link => !activeIds.has(link.id));
    const linkCards = activeLinks.map(renderLink).join('');
    const historyCards = history.length ? `<details class="connection-history"><summary>Previous connections (${history.length})</summary>${history.map(renderLink).join('')}</details>` : '';
    const importedCards = transfers.filter((item) => item.status === 'imported' || item.status === 'verification_failed' || item.status === 'verified').map((transfer) => transfer.sourceFormat === 'markdown'
      ? `<article class="runner-profile"><div class="connection-line"><div><strong>Agent record imported</strong><small>${escapeHtml((transfer.sourceFiles || []).join(', ') || 'private Markdown')}</small></div><span class="status-badge">READY TO REVIEW</span></div><p class="microcopy">Open the agent profile, review its details, choose a model, and then use the matching destination setup prompt.</p></article>`
      : `<article class="runner-profile"><div class="connection-line"><div><strong>Encrypted record review</strong><small>${escapeHtml(transfer.status.replaceAll('_', ' '))}</small></div><span class="status-badge ${transfer.retirementEligible ? '' : 'warn'}">${transfer.retirementEligible ? 'REVIEW PASSED' : 'REVIEW NEEDED'}</span></div><div class="provider-actions"><button class="secondary-button" data-transfer-verify="${transfer.id}">${transfer.status === 'verified' ? 'Review again' : 'Verify record'}</button></div></article>`).join('');
    const localDraftCards = (state.data?.agents || []).filter((agent) => agent.continuityDraft?.completeness?.complete).map((agent) => `<article class="runner-profile"><div class="connection-line"><div><strong>${escapeHtml(agent.name)}</strong><small>Private draft · encrypted local state</small></div><span class="status-badge">READY</span></div><p class="microcopy">The agent curated a complete continuity draft. Only the owner can create the encrypted backup.</p><div class="provider-actions"><button class="secondary-button" data-local-continuity-export="${agent.id}">Create backup</button></div></article>`).join('');
    root.innerHTML = linkCards + localDraftCards + importedCards + historyCards || '<div class="empty-state"><strong>No connected agents yet</strong><p>Choose Pair an existing agent to create a connection.</p></div>';
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-link-manage]');
    if (button) window.HexiGridManageAgentAccess?.(button.dataset.linkManage);
  });

  function mountLive() {
    const conversation = document.querySelector('.live-conversation'); if (!conversation || document.querySelector('#agentLinkPanel')) return;
    conversation.insertAdjacentHTML('beforeend', `<section id="agentLinkPanel" class="agent-mail-panel"><div class="generated-voice-head"><div><div class="eyebrow">AGENT CONNECTION</div><h4>HexiGrid Link</h4></div><span id="agentLinkBadge" class="status-badge warn">NOT CONNECTED</span></div><p id="agentLinkDetail" class="panel-copy">No HexiGrid Link is paired with this agent. Connect one in Settings → Connections to exchange messages here.</p><div id="agentLinkConnected" class="hidden"><textarea id="agentLinkMessage" rows="3" maxlength="50000" placeholder="Message the connected agent…"></textarea><div class="live-voice-actions"><button class="primary-button" data-agent-link-action="send" type="button">Send through Link</button><button class="secondary-button" data-agent-link-action="refresh" type="button">Check replies</button></div></div><p id="agentLinkStatus" class="form-feedback" role="status"></p></section>`);
  }

  function renderLive() {
    mountLive(); const agent = selectedLiveAgent(); const connection = connectionFor(agent?.id); const badge = document.querySelector('#agentLinkBadge');
    if (badge) { badge.textContent = connection ? String(connection.status || 'offline').toUpperCase() : 'NOT CONNECTED'; badge.classList.toggle('warn', !connection || connection.status !== 'online'); }
    const detail = document.querySelector('#agentLinkDetail');
    if (detail) detail.textContent = connection
      ? `Link ${String(connection.id).slice(-8)} · ${connection.heartbeat?.reason || 'Heartbeat status unavailable.'} Messages can be sent through this paired connection; Check replies refreshes this conversation.`
      : 'No HexiGrid Link is paired with this agent. Connect one in Settings → Connections to exchange messages here.';
    document.querySelector('#agentLinkConnected')?.classList.toggle('hidden', !connection);
  }

  function render() { renderConnections(); renderLive(); }
  function startWatch() { if (!watchTimer) watchTimer = setInterval(() => { if (!document.hidden) refreshLinks(true).catch((error) => feedback(error.message, true)); }, 5000); }

  document.addEventListener('click', (event) => {
    const copyPrompt = event.target.closest('#continuityPromptCopy'); if (copyPrompt) { copyPrompt.disabled = true; copyContinuityPrompt().catch((error) => feedback(error.message, true)).finally(() => { copyPrompt.disabled = false; }); return; }
    const send = event.target.closest('[data-agent-link-action="send"]'); if (send) { sendLinkedMessage().catch((error) => feedback(error.message, true)); return; }
    if (event.target.closest('[data-agent-link-action="refresh"]')) { refreshLinks(true).catch((error) => feedback(error.message, true)); return; }
    const exportButton = event.target.closest('[data-link-export]'); if (exportButton) { exportContinuity(exportButton.dataset.linkExport).catch((error) => feedback(error.message, true)); return; }
    const localExportButton = event.target.closest('[data-local-continuity-export]'); if (localExportButton) { exportLocalContinuity(localExportButton.dataset.localContinuityExport).catch((error) => feedback(error.message, true)); return; }
    const verifyButton = event.target.closest('[data-transfer-verify]'); if (verifyButton) { verifyTransfer(verifyButton.dataset.transferVerify).catch((error) => feedback(error.message, true)); return; }
    const resumeButton = event.target.closest('[data-link-resume]'); if (resumeButton) { copyReconnectInstructions(resumeButton.dataset.linkResume).catch(error => feedback(error.message, true)); return; }
    const replacementButton = event.target.closest('[data-link-replace]'); if (replacementButton) { replaceConnection(replacementButton.dataset.linkReplace).catch(error => feedback(error.message, true)); return; }
    const disconnectButton = event.target.closest('[data-link-disconnect]'); if (disconnectButton) disconnect(disconnectButton.dataset.linkDisconnect).catch((error) => feedback(error.message, true));
  });
  document.querySelector('#continuityMarkdownImport')?.addEventListener('click', () => document.querySelector('#continuityMarkdownFiles').click());
  document.querySelector('#continuityMarkdownFiles')?.addEventListener('change', (event) => { if (event.target.files?.length) importMarkdown(event.target.files).catch((error) => feedback(error.message, true)); event.target.value = ''; });
  document.querySelector('#continuityPackageImport')?.addEventListener('click', () => document.querySelector('#continuityPackageFile')?.click());
  document.querySelector('#continuityPackageFile')?.addEventListener('change', (event) => { const file = event.target.files?.[0]; if (file) importContinuityPackage(file).catch((error) => feedback(error.message, true)); event.target.value = ''; });
  document.addEventListener('change', (event) => { if (event.target.matches('#liveAgentSelect')) renderLive(); });
  const appRendered = () => { render(); startWatch(); };
  window.addEventListener('hexigrid:rendered', appRendered); window.addEventListener('beforeunload', () => clearInterval(watchTimer));
  setTimeout(() => { if (state.data) appRendered(); }, 0);
})();
