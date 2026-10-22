const providerRoot = document.createElement('section');
providerRoot.id = 'view-providers';
providerRoot.className = 'view';
providerRoot.innerHTML = `<div class="page-intro"><div><div class="eyebrow">AI CONNECTIONS</div><h2>Connect your AI</h2><p>Pick what you already use. HexiGrid checks the connection and finds its current models for you.</p></div></div>
<div class="connection-kind-grid" role="tablist" aria-label="Connection type">
  <button class="connection-kind active" role="tab" tabindex="0" aria-selected="true" data-connection-kind="api"><span class="connection-glyph" data-icon="key"></span><strong>API key</strong><small>OpenAI, Anthropic, Google, Hugging Face, or compatible</small></button>
  <button class="connection-kind" role="tab" tabindex="-1" aria-selected="false" data-connection-kind="local"><span class="connection-glyph" data-icon="server"></span><strong>Local model app</strong><small>Ollama, LM Studio, or compatible</small></button>
  <button class="connection-kind" role="tab" tabindex="-1" aria-selected="false" data-connection-kind="device"><span class="connection-glyph" data-icon="device"></span><strong>This device</strong><small>Run a small model in this browser</small></button>
  <button class="connection-kind" role="tab" tabindex="-1" aria-selected="false" data-connection-kind="harness"><span class="connection-glyph" data-icon="terminal"></span><strong>Computer tool</strong><small>OpenCode local models, or signed-in Claude Code / Codex</small></button>
</div>
<div class="provider-workbench">
  <form id="providerForm" class="panel stack-form"><div class="eyebrow">NEW CONNECTION</div><h3 id="providerFormTitle">Connect with an API key</h3>
    <label>1. Choose your service<select id="providerPreset"><option value="" selected disabled>Choose an API provider</option><option value="opencodezen">OpenCode Zen</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option><option value="hf">Hugging Face</option><option value="custom">Another compatible API</option></select></label>
    <label id="providerKeyLabel">2. Paste your API key<input id="providerKey" type="password" autocomplete="off" placeholder="Encrypted on this device; never saved in page settings"></label>
    <p id="providerHint" class="simple-callout"></p>
    <div id="providerHelpLinks" class="integration-help-links" aria-label="Setup help"></div>
    <details class="advanced-settings"><summary>Connection details</summary><div class="stack-form"><label>Name<input id="providerName" required maxlength="80"></label><label>API address<input id="providerAddress" required type="url"></label><label>API format<select id="providerStyle"><option value="openai-chat">OpenAI-compatible chat</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="google-gemini">Google Gemini</option></select></label><label>Output-token limit <small>Applies to connections created with this value. It limits reply output, not context size or account cost.</small><input id="providerMaxOutputTokens" type="number" min="1" max="32768" step="1" inputmode="numeric" placeholder="Provider default"></label><label>Estimated input-context token limit <small>Optional. Uses the existing estimate of about four characters per token across the prompt and conversation. Over-limit requests are rejected without shortening them. Image prompts are blocked while this limit is set because image tokens cannot be estimated here.</small><input id="providerMaxInputTokens" type="number" min="1" max="1000000" step="1" inputmode="numeric" placeholder="No limit"></label><label>Manual model IDs <small>Usually leave this blank.</small><textarea id="providerModels" rows="3" placeholder="Use only if this service cannot list its models"></textarea></label><label class="checkbox-control"><input id="providerImages" type="checkbox"> This service can also generate images</label></div></details>
    <button class="primary-button" type="submit">Connect and find models</button><p id="providerFeedback" role="status"></p>
  </form>
  <section id="onDevicePanel" class="panel hidden"><div class="eyebrow">BROWSER-NATIVE AI</div><h3>Run a model on this device</h3><p class="panel-copy">No API key and no cloud request. Your browser downloads the selected model once, keeps it in its own private storage, and runs it with your device GPU. The first download can be large.</p><div id="onDeviceSupport" class="simple-callout">Checking whether this browser can run WebGPU…</div><div class="stack-form"><label>Choose a model<select id="onDeviceModel" disabled><option>Checking supported models…</option></select></label><div id="onDeviceModelInfo" class="model-device-info"></div></div><div class="form-actions"><button class="secondary-button" type="button" data-on-device-refresh>Refresh supported models</button><button class="primary-button" type="button" data-on-device-add disabled>Use this model</button><button class="ghost-button" type="button" data-on-device-clear disabled>Remove download</button></div><p id="onDeviceFeedback" role="status"></p><div class="form-actions"><button class="secondary-button hidden" type="button" data-on-device-cancel>Cancel</button><button class="secondary-button hidden" type="button" data-on-device-retry>Retry</button></div><small class="form-note">This is separate from Ollama and LM Studio. If WebGPU is unavailable, use a local model app or API connection instead.</small></section>
  <section id="harnessPanel" class="panel hidden"><div class="eyebrow">TOOLS ON THIS COMPUTER</div><h3>Choose an installed computer tool</h3><p class="panel-copy">HexiGrid only lists tools it can detect. Nothing connects until you choose it.</p><div id="harnessList" class="harness-list"></div><button class="secondary-button" data-harness-scan>Scan again</button><p id="harnessFeedback" role="status"></p></section>
  <section class="panel"><div class="eyebrow">YOUR CONNECTIONS</div><h3>Connected services</h3><div id="providerList"></div></section>
</div>`;
document.querySelector('.main-content').append(providerRoot);
providerRoot.insertAdjacentHTML('beforeend', `<section class="panel"><div class="eyebrow">LOCAL ACCOUNT POOL</div><h3>One connection, multiple accounts</h3><p class="panel-copy">Use your installed Codex LB pool for account routing and usage. Your agent can manage it through an owner Link; account credentials stay in the pool.</p><button class="secondary-button" data-pool-refresh>Refresh pool</button><div id="modelPoolStatus" role="status">Refresh to check the pool on this computer.</div><div id="modelPoolControls" class="model-pool-controls hidden"><label>Routing<select id="modelPoolStrategy"><option value="capacity_weighted">Balance available capacity</option><option value="usage_weighted">Balance usage</option><option value="round_robin">Take turns</option><option value="relative_availability">Relative availability</option><option value="fill_first">Fill first</option><option value="sequential_drain">Sequential drain</option><option value="reset_drain">Reset drain</option></select></label><label class="checkbox-control"><input type="checkbox" id="modelPoolSticky"> Keep conversations on the same account when available</label><button class="primary-button" data-pool-save>Save routing</button><p><a id="modelPoolDashboard" target="_blank" rel="noopener noreferrer">Manage accounts in pool dashboard</a></p><p id="modelPoolAddress"></p></div></section>`);
let modelPoolVersion = null;
async function refreshModelPool() {
  const target = document.querySelector('#modelPoolStatus');
  target.textContent = 'Checking local pool…';
  document.querySelector('#modelPoolControls').classList.add('hidden');
  modelPoolVersion = null;
  try {
    const { pool } = await api('/api/model-pool');
    const remaining = value => value === null ? 'Unknown' : `${value}%`;
    const usageCount = value => value === null ? 'Unknown' : Number(value).toLocaleString();
    target.innerHTML = `<p>${pool.accounts.length} accounts · Checked ${escapeHtml(new Date(pool.observedAt).toLocaleTimeString())}</p><p>Past 7 days through this pool: ${usageCount(pool.usage.requests)} requests · ${usageCount(pool.usage.tokens)} tokens · ${usageCount(pool.usage.cachedInputTokens)} cached input tokens · ${usageCount(pool.usage.errors)} errors.</p><div class="model-pool-table"><table><thead><tr><th>Account</th><th>State</th><th>Primary left</th><th>Secondary left</th><th>Purchased credits</th><th>Last refreshed</th></tr></thead><tbody>${pool.accounts.map(account => `<tr><td>${escapeHtml(account.label)} · ${escapeHtml(account.plan || 'Unknown plan')}</td><td>${escapeHtml(account.status || 'Unknown')}</td><td>${remaining(account.remaining.primary)}${account.resets.primary ? `<br><small>Resets ${escapeHtml(new Date(account.resets.primary).toLocaleString())}</small>` : ''}</td><td>${remaining(account.remaining.secondary)}${account.resets.secondary ? `<br><small>Resets ${escapeHtml(new Date(account.resets.secondary).toLocaleString())}</small>` : ''}</td><td>${account.credits.balance !== null ? usageCount(account.credits.balance) : account.credits.unlimited === true ? 'Provider reports unlimited' : 'Unknown'}<br><small>Credits, not raw tokens</small></td><td>${account.lastRefreshAt ? escapeHtml(new Date(account.lastRefreshAt).toLocaleString()) : 'Unknown'}</td></tr>`).join('')}</tbody></table></div><p>${escapeHtml(pool.notice)}</p>`;
    const headers = [...target.querySelectorAll('th')].map(cell => cell.textContent);
    target.querySelectorAll('tbody tr').forEach(row => [...row.cells].forEach((cell, index) => { cell.dataset.label = headers[index]; }));
    modelPoolVersion = pool.settings.version;
    document.querySelector('#modelPoolStrategy').value = pool.settings.routingStrategy || '';
    document.querySelector('#modelPoolSticky').checked = pool.settings.stickyThreadsEnabled;
    document.querySelector('#modelPoolDashboard').href = pool.baseUrl;
    document.querySelector('#modelPoolAddress').textContent = `For model connections, use ${pool.inferenceBaseUrl}. The pool may require its own API key; store it using HexiGrid’s protected key field.`;
    document.querySelector('#modelPoolControls').classList.remove('hidden');
  } catch (error) { target.textContent = error.message; }
}
providerRoot.addEventListener('click', async event => {
  const button = event.target.closest('[data-pool-refresh], [data-pool-save]');
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    if (button.hasAttribute('data-pool-refresh')) await refreshModelPool();
    else {
      if (!modelPoolVersion) throw new Error('Refresh the pool before changing routing.');
      if (!await userConfirm('Update account pool routing?', 'This changes which eligible account handles future requests. Existing account limits still apply.', 'Save routing')) return;
      await api('/api/model-pool/routing', { method: 'POST', body: JSON.stringify({ routingStrategy: document.querySelector('#modelPoolStrategy').value, stickyThreadsEnabled: document.querySelector('#modelPoolSticky').checked, expectedVersion: modelPoolVersion, approved: true }) });
      notify('Pool routing saved.'); await refreshModelPool();
    }
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
});
providerRoot.querySelector('#providerImages')?.closest('label')?.insertAdjacentHTML('afterend', '<label class="checkbox-control"><input id="providerSpeech" type="checkbox"> This service has an OpenAI-compatible text-to-speech endpoint</label><label class="checkbox-control"><input id="providerRealtime" type="checkbox"> This service supports OpenAI-compatible realtime voice calls</label>');

function capabilityLabel(capability) {
  return ({ chat: 'chat', image: 'images', speech: 'speech', realtime: 'realtime voice' })[capability] || capability;
}

function providerKeyRequired(address) {
  try { return ['opencode.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'router.huggingface.co'].includes(new URL(address).hostname.toLowerCase()); }
  catch { return false; }
}

const providerNav = document.createElement('button');
providerNav.className = 'nav-item'; providerNav.dataset.view = 'providers';
providerNav.innerHTML = '<span class="nav-icon" data-icon="link"></span>Connections';
document.querySelector('[data-view="settings"]').after(providerNav);

const providerPresets = {
  opencodezen: { name:'OpenCode Zen', address:'https://opencode.ai/zen/v1', style:'openai-responses', key:'2. Paste your OpenCode Zen API key', hint:'OpenCode Zen is an optional cloud connection. Model access and cost depend on the service and model. For a local route, choose Local model app or This device.', guide:'openCodeZen', official:'https://opencode.ai/docs/zen' },
  openai: { name:'OpenAI', address:'https://api.openai.com/v1', style:'openai-responses', key:'2. Paste your OpenAI API key', hint:'Connect to see the models available with your OpenAI API key.', guide:'openai', official:'https://platform.openai.com/docs/quickstart' },
  anthropic: { name:'Anthropic', address:'https://api.anthropic.com/v1', style:'anthropic', key:'2. Paste your Anthropic API key', hint:'HexiGrid asks Anthropic which models this key can use.', guide:'anthropic', official:'https://platform.claude.com/docs/en/api/overview' },
  google: { name:'Google Gemini', address:'https://generativelanguage.googleapis.com/v1beta', style:'google-gemini', key:'2. Paste your Gemini API key', hint:'This connects Gemini models. Google Drive backup is a separate optional connection.', guide:'gemini', official:'https://ai.google.dev/gemini-api/docs/api-key' },
  hf: { name:'Hugging Face', address:'https://router.huggingface.co/v1', style:'openai-chat', key:'2. Paste your Hugging Face token', hint:'HexiGrid asks the Hugging Face router which models your token can use.', guide:'huggingface', official:'https://huggingface.co/docs/hub/models-inference' },
  ollama: { name:'Ollama', address:'http://127.0.0.1:11434/v1', style:'openai-chat', key:'2. API key (usually leave blank)', hint:'Start Ollama first. HexiGrid finds the models installed in it.', guide:'ollama', official:'https://docs.ollama.com/quickstart' },
  lmstudio: { name:'LM Studio', address:'http://127.0.0.1:1234/v1', style:'openai-chat', key:'2. API key (usually leave blank)', hint:'Start the local server in LM Studio first. HexiGrid finds the models it exposes.', guide:'lmstudio', official:'https://lmstudio.ai/docs/developer/core/server' },
  localcustom: { name:'Local model server', address:'http://127.0.0.1:8080/v1', style:'openai-chat', key:'2. API key (if your server requires one)', hint:'Change the local address under Connection details if needed.', guide:'compatibleLocal' },
  custom: { name:'Compatible API', address:'', style:'openai-chat', key:'2. API key (if required)', hint:'Open Connection details once to enter the service address. Models are found automatically when supported.', guide:'compatibleApi' }
};

const onDeviceCatalog = { capabilities: null, models: [], selected: '', cache: { modelId: '', status: 'unknown' } };
let lastOnDeviceAttempt = '';

window.addEventListener('hexigrid:on-device-load-state', (event) => {
  const detail = event.detail || {};
  if (detail.modelId) lastOnDeviceAttempt = detail.modelId;
  const cancel = document.querySelector('[data-on-device-cancel]');
  const retry = document.querySelector('[data-on-device-retry]');
  cancel.classList.toggle('hidden', detail.cancel !== true);
  retry.classList.toggle('hidden', detail.retry !== true || !lastOnDeviceAttempt);
  if (detail.message) document.querySelector('#onDeviceFeedback').textContent = detail.message;
  else if (detail.state === 'loading') document.querySelector('#onDeviceFeedback').textContent = 'Downloading the on-device model…';
  else if (detail.state === 'ready') document.querySelector('#onDeviceFeedback').textContent = 'The on-device model is ready.';
});

function onDeviceBrowserId() {
  const key = 'hexigrid-on-device-browser-id';
  let value = localStorage.getItem(key);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,120}$/.test(String(value || ''))) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    value = `browser-${[...bytes].map((item) => item.toString(16).padStart(2, '0')).join('')}`;
    localStorage.setItem(key, value);
  }
  return value;
}

function renderOnDeviceCatalog() {
  const support = document.querySelector('#onDeviceSupport');
  const select = document.querySelector('#onDeviceModel');
  const add = document.querySelector('[data-on-device-add]');
  const clear = document.querySelector('[data-on-device-clear]');
  const info = document.querySelector('#onDeviceModelInfo');
  if (!support || !select || !add || !clear || !info) return;
  const capabilities = onDeviceCatalog.capabilities;
  support.className = `simple-callout${capabilities?.supported ? '' : ' error-message'}`;
  support.textContent = capabilities?.supported ? `WebGPU is available. ${onDeviceCatalog.models.length} model options are listed; actual compatibility and speed depend on your device's GPU memory.` : (capabilities?.reason || 'This browser cannot run on-device models yet.');
  select.innerHTML = onDeviceCatalog.models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`).join('') || '<option value="">No supported models found</option>';
  select.disabled = !onDeviceCatalog.models.length;
  if (!onDeviceCatalog.models.some((model) => model.id === onDeviceCatalog.selected)) onDeviceCatalog.selected = onDeviceCatalog.models[0]?.id || '';
  select.value = onDeviceCatalog.selected;
  const model = onDeviceCatalog.models.find((item) => item.id === onDeviceCatalog.selected);
  const cacheStatus = model && onDeviceCatalog.cache.modelId === model.id ? onDeviceCatalog.cache.status : 'unknown';
  const cacheMessage = cacheStatus === 'cached' ? 'Model files are already saved in this browser.'
    : cacheStatus === 'empty' ? 'No downloaded files yet. They download when you send the first message.'
      : cacheStatus === 'error' ? 'Could not check for downloaded files. Refresh supported models to try again.'
        : 'Checking for downloaded files…';
  info.innerHTML = model ? `<strong>${escapeHtml(model.label)}</strong><span>${model.vramRequiredMB ? `About ${model.vramRequiredMB.toLocaleString()} MB graphics memory` : 'Memory requirement not published'} · ${model.lowResource ? 'lower-resource option' : 'larger model'}</span><small>${cacheMessage}</small>` : '';
  add.disabled = !model;
  clear.disabled = !model || cacheStatus !== 'cached';
}

async function refreshOnDeviceCache(modelId = onDeviceCatalog.selected) {
  if (!modelId) return;
  onDeviceCatalog.cache = { modelId, status: 'checking' };
  renderOnDeviceCatalog();
  try {
    if (typeof window.HexiGridOnDevice?.hasCachedModel !== 'function') throw new Error('Cache status is unavailable.');
    const cached = await window.HexiGridOnDevice.hasCachedModel(modelId);
    if (onDeviceCatalog.selected !== modelId) return;
    onDeviceCatalog.cache = { modelId, status: cached ? 'cached' : 'empty' };
  } catch {
    if (onDeviceCatalog.selected !== modelId) return;
    onDeviceCatalog.cache = { modelId, status: 'error' };
  }
  renderOnDeviceCatalog();
}

async function refreshOnDeviceCatalog() {
  const feedback = document.querySelector('#onDeviceFeedback');
  if (!window.HexiGridOnDevice?.supportedModels) {
    onDeviceCatalog.capabilities = { supported: false, reason: 'The browser inference module did not load. Refresh the page and try again.' };
    onDeviceCatalog.models = [];
    renderOnDeviceCatalog();
    return;
  }
  feedback.textContent = 'Checking this browser…';
  try {
    const result = await window.HexiGridOnDevice.supportedModels();
    onDeviceCatalog.capabilities = result;
    onDeviceCatalog.models = result.models || [];
    renderOnDeviceCatalog();
    await refreshOnDeviceCache();
    feedback.textContent = result.models?.length ? 'Choose a model, then add it to your connections.' : 'No on-device model is available in this browser.';
  } catch (error) {
    onDeviceCatalog.capabilities = { supported: false, reason: error.message };
    onDeviceCatalog.models = [];
    renderOnDeviceCatalog();
    feedback.textContent = error.message;
  }
}

async function addOnDeviceConnection() {
  const model = onDeviceCatalog.models.find((item) => item.id === document.querySelector('#onDeviceModel').value);
  const feedback = document.querySelector('#onDeviceFeedback');
  if (!model) return notify('Choose an on-device model first.', true);
  const button = document.querySelector('[data-on-device-add]');
  button.disabled = true;
  feedback.textContent = 'Adding the browser model…';
  try {
    await api('/api/on-device/providers', { method: 'POST', body: JSON.stringify({ name: `This browser · ${model.label}`, deviceId: onDeviceBrowserId(), models: [model] }) });
    await refresh();
    feedback.textContent = `${model.label} is ready. The first message will download its files.`;
    notify('On-device model added.');
  } catch (error) { feedback.textContent = error.message; }
  finally { renderOnDeviceCatalog(); }
}

async function clearOnDeviceDownload() {
  const model = onDeviceCatalog.models.find((item) => item.id === document.querySelector('#onDeviceModel').value);
  if (!model || !window.HexiGridOnDevice?.clearCache) return;
  if (!await userConfirm('Remove this model download?', 'The browser will need to download the model again before it can answer.', 'Remove', true)) return;
  const feedback = document.querySelector('#onDeviceFeedback');
  const button = document.querySelector('[data-on-device-clear]');
  button.disabled = true;
  feedback.textContent = 'Removing the browser model files…';
  try { await window.HexiGridOnDevice.clearCache(model.id); onDeviceCatalog.cache = { modelId: model.id, status: 'empty' }; feedback.textContent = 'The browser model download was removed.'; notify('On-device model removed from this browser.'); }
  catch (error) { feedback.textContent = error.message; }
  finally { renderOnDeviceCatalog(); }
}

function setConnectionKind(kind) {
  document.querySelectorAll('[data-connection-kind]').forEach((button) => { const active=button.dataset.connectionKind===kind; button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active)); button.tabIndex=active?0:-1; });
  document.querySelector('#providerForm').classList.toggle('hidden',kind==='harness' || kind==='device');
  document.querySelector('#onDevicePanel').classList.toggle('hidden',kind!=='device');
  document.querySelector('#harnessPanel').classList.toggle('hidden',kind!=='harness');
  const select=document.querySelector('#providerPreset');
  select.innerHTML = kind === 'local'
    ? '<option value="" selected disabled>Choose a local model app</option><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option><option value="localcustom">Another local model server</option>'
    : '<option value="" selected disabled>Choose an API provider</option><option value="opencodezen">OpenCode Zen</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option><option value="hf">Hugging Face</option><option value="custom">Another compatible API</option>';
  document.querySelector('#providerFormTitle').textContent = kind === 'local' ? 'Connect a local model app' : 'Connect with an API key';
  if (kind !== 'device') applyProviderPreset();
  if (kind === 'device' && typeof refreshOnDeviceCatalog === 'function') refreshOnDeviceCatalog();
  if (kind === 'harness' && typeof scanHarnesses === 'function') scanHarnesses();
}

function updateProviderSubmitState() {
  const form = document.querySelector('#providerForm');
  const preset = document.querySelector('#providerPreset').value;
  const address = document.querySelector('#providerAddress').value;
  const key = document.querySelector('#providerKey').value;
  const submit = document.querySelector('#providerForm button[type="submit"]');
  submit.disabled = !providerPresets[preset] || !form.checkValidity()
    || (providerKeyRequired(address) && !String(key).trim());
}

function applyProviderPreset() {
  document.querySelector('#providerFeedback').textContent = '';
  const select = document.querySelector('#providerPreset');
  const preset = providerPresets[select.value];
  if (!preset) {
    document.querySelector('#providerKey').value = '';
    document.querySelector('#providerName').value = '';
    document.querySelector('#providerAddress').value = '';
    document.querySelector('#providerStyle').value = 'openai-chat';
    document.querySelector('#providerKeyLabel').firstChild.textContent = '2. API key (if required)';
    document.querySelector('#providerHint').textContent = 'Choose a service above. HexiGrid will show its setup steps before connecting.';
    document.querySelector('#providerHelpLinks').innerHTML = '';
    document.querySelector('.advanced-settings').open = false;
    updateProviderSubmitState();
    return;
  }
  if (document.querySelector('#providerAddress').value !== preset.address) {
    document.querySelector('#providerKey').value = '';
  }
  document.querySelector('#providerName').value = preset.name;
  document.querySelector('#providerAddress').value = preset.address;
  document.querySelector('#providerStyle').value = preset.style;
  document.querySelector('#providerKeyLabel').firstChild.textContent = preset.key;
  document.querySelector('#providerHint').textContent = preset.hint;
  document.querySelector('#providerHelpLinks').innerHTML = `<button type="button" class="text-button" data-action="open-guide-topic" data-guide="${preset.guide}">Simple steps</button>${preset.official ? `<a href="${preset.official}" target="_blank" rel="noopener noreferrer">Official guide</a>` : ''}`;
  document.querySelector('.advanced-settings').open = !preset.address || /custom/.test(select.value);
  updateProviderSubmitState();
}

function renderProviders() {
  const saved = state.data?.providers || [];
  const harnesses = (state.data?.harnesses || []).filter((item) => item.connected);
  const providers = saved.map((p) => { const browser = p.kind === 'browser-webllm'; const direct = p.kind === 'browser-cloud'; const label = browser ? 'This browser' : direct ? 'Direct from this browser' : p.local ? 'This computer' : 'Cloud API'; const address = browser ? 'Runs locally in this browser' : p.baseUrl; const missingKey = !browser && !p.hasKey && providerKeyRequired(p.baseUrl); const actions = browser ? `<button class="secondary-button" data-provider-test="${p.id}">Check browser</button>` : `<button class="secondary-button" data-provider-test="${p.id}">Refresh models</button><button class="secondary-button" data-provider-key="${p.id}" ${(isHostBrowser() || direct || isStandaloneBrowser()) ? '' : 'disabled'}>Change key</button>`; const limits = browser ? '' : `<details class="advanced-settings provider-limits-editor"><summary>Edit token limits</summary><form class="stack-form" data-provider-limits-form="${p.id}" aria-label="Edit token limits for ${escapeHtml(p.name)}"><label>Estimated input-context token limit <small id="provider-input-limit-help-${p.id}">Uses the existing four-characters-per-token estimate; image prompts are rejected while set. Leave blank and save to clear.</small><input aria-describedby="provider-input-limit-help-${p.id}" type="number" min="1" max="1000000" step="1" inputmode="numeric" placeholder="No limit" value="${p.maxInputTokens ?? ''}" data-provider-max-input="${p.id}"></label><label>Output-token limit <small id="provider-output-limit-help-${p.id}">Caps reply output, not context size or account cost. Leave blank and save to clear.</small><input aria-describedby="provider-output-limit-help-${p.id}" type="number" min="1" max="32768" step="1" inputmode="numeric" placeholder="Provider default" value="${p.maxOutputTokens ?? ''}" data-provider-max-output="${p.id}"></label><button type="submit" class="primary-button" data-provider-limits-save="${p.id}">Save limits</button></form></details>`; return `<article class="saved-provider"><header><strong>${escapeHtml(p.name)}</strong><span class="tag">${label}</span></header><p>${escapeHtml(address)}</p><small>${p.modelIds.length} model${p.modelIds.length===1?'':'s'} · ${(p.capabilities || ['chat']).map(capabilityLabel).join(' + ')} · ${missingKey ? 'API key required for chat' : browser ? 'No key needed' : p.hasKey ? 'Key protected' : 'No key needed'}</small>${direct ? '<small>Encrypted by this browser passcode; direct HTTPS requests use no desktop host.</small>' : browser ? '<small>Model files stay in this browser’s private storage.</small>' : ''}${p.lastError?`<p class="error-message">${escapeHtml(p.lastError)}</p>`:''}<div class="provider-actions">${actions}<button class="ghost-button" data-provider-remove="${p.id}">Disconnect</button></div>${limits}<div class="provider-key-editor hidden" data-provider-editor="${p.id}"><label>New API key<input type="password" autocomplete="off" data-provider-key-input="${p.id}"></label><button class="primary-button" data-provider-key-save="${p.id}">Save new key</button></div></article>`; }).join('');
  const tools = harnesses.map((item) => `<article class="saved-provider"><header><strong>${escapeHtml(item.label)}</strong><span class="tag">Computer tool</span></header><small>${item.authenticated ? 'Signed in and connected by you' : 'Connected by you · provider sign-in depends on the selected model'}</small><div class="provider-actions"><button class="ghost-button" data-harness-disconnect="${item.id}">Disconnect</button></div></article>`).join('');
  document.querySelector('#providerList').innerHTML = providers + tools || '<div class="empty-state"><strong>No AI connected yet</strong><p>Choose API key, local model app, or a detected computer tool above.</p></div>';
  if (typeof renderHarnesses === 'function') renderHarnesses();
}

document.querySelector('#providerPreset').addEventListener('change', applyProviderPreset);
document.querySelector('#providerKey').addEventListener('input', updateProviderSubmitState);
document.querySelector('#providerName').addEventListener('input', updateProviderSubmitState);
document.querySelector('#providerAddress').addEventListener('input', () => {
  document.querySelector('#providerFeedback').textContent = '';
  document.querySelector('#providerKey').value = '';
  updateProviderSubmitState();
});
document.querySelector('#onDeviceModel').addEventListener('change', (event) => { onDeviceCatalog.selected = event.target.value; void refreshOnDeviceCache(); });
document.addEventListener('click',(event)=>{const button=event.target.closest('[data-connection-kind]');if(button)setConnectionKind(button.dataset.connectionKind);});
// Manual activation: arrows move focus without scanning tools or replacing a draft.
// Enter/Space uses the button's native click and activates the chosen connection.
document.addEventListener('keydown', (event) => {
  const button = event.target.closest('[data-connection-kind]');
  if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[data-connection-kind]')];
  const index = tabs.indexOf(button);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs.forEach(tab => { tab.tabIndex = tab === tabs[next] ? 0 : -1; });
  tabs[next].focus();
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-on-device-refresh],[data-on-device-add],[data-on-device-clear],[data-on-device-cancel],[data-on-device-retry]');
  if (!button) return;
  if (button.dataset.onDeviceRefresh !== undefined) refreshOnDeviceCatalog();
  if (button.dataset.onDeviceAdd !== undefined) addOnDeviceConnection();
  if (button.dataset.onDeviceClear !== undefined) clearOnDeviceDownload();
  if (button.dataset.onDeviceCancel !== undefined) window.HexiGridOnDevice?.cancelLoad();
  if (button.dataset.onDeviceRetry !== undefined && lastOnDeviceAttempt) window.HexiGridOnDevice?.retryLoad(lastOnDeviceAttempt).catch((error) => { document.querySelector('#onDeviceFeedback').textContent = error.message; });
});
setConnectionKind('api');

async function switchToStandaloneBrowser() {
  const status = await window.HexiGridBrowserVault.status();
  if (!status.configured) {
    const answer = await window.hexigridModal({
      title: 'Protect this browser',
      message: 'This phone or browser will work independently. Your passcode makes the encryption key for local agents, chats, and provider keys. There is no recovery backdoor.',
      accept: 'Create browser vault',
      fields: [
        { label: 'New browser passcode (10+ characters)', type: 'password', required: true },
        { label: 'Type it again', type: 'password', required: true }
      ]
    });
    if (!answer) return false;
    if (answer[0] !== answer[1]) throw new Error('The two browser passcodes do not match.');
    await window.HexiGridStandalone.request('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: answer[0] }) });
  } else if (!status.unlocked) {
    const answer = await window.hexigridModal({ title: 'Unlock this browser', message: 'Enter the passcode that protects this browser’s local HexiGrid data.', accept: 'Unlock', fields: [{ label: 'Browser passcode', type: 'password', required: true }] });
    if (!answer) return false;
    await window.HexiGridStandalone.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: answer[0] }) });
  } else window.HexiGridStandalone.activate();
  await refresh();
  return true;
}

let providerFormSaving = false;
document.querySelector('#providerForm').addEventListener('submit',async(event)=>{
  event.preventDefault();
  if (providerFormSaving) return;
  if (!providerPresets[document.querySelector('#providerPreset').value]) {
    document.querySelector('#providerFeedback').textContent = 'Choose a service before connecting.';
    return;
  }
  providerFormSaving = true;
  const controls = [...document.querySelector('#providerForm').querySelectorAll('input,select,textarea,button'), ...document.querySelectorAll('[data-connection-kind]')];
  const disabledBefore = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  const feedback=document.querySelector('#providerFeedback'); feedback.textContent='Checking the connection and finding models…';
  try {
    if (providerKeyRequired(document.querySelector('#providerAddress').value) && !document.querySelector('#providerKey').value.trim()) throw new Error('Paste this service’s API key before connecting. Its public model list does not verify chat access.');
    if (!isHostBrowser() && !isStandaloneBrowser() && !(await switchToStandaloneBrowser())) return;
    const outputLimit = document.querySelector('#providerMaxOutputTokens').value;
    const inputLimit = document.querySelector('#providerMaxInputTokens').value;
    const providerConfig = {name:document.querySelector('#providerName').value,baseUrl:document.querySelector('#providerAddress').value,apiStyle:document.querySelector('#providerStyle').value,...(outputLimit === '' ? {} : {maxOutputTokens:Number(outputLimit)}),...(inputLimit === '' ? {} : {maxInputTokens:Number(inputLimit)}),models:document.querySelector('#providerModels').value,capabilities:['chat',...(document.querySelector('#providerImages').checked?['image']:[]),...(document.querySelector('#providerSpeech')?.checked?['speech']:[]),...(document.querySelector('#providerRealtime')?.checked?['realtime']:[])],apiKey:document.querySelector('#providerKey').value};
    const result=await api('/api/providers',{method:'POST',body:JSON.stringify(providerConfig)});
    document.querySelector('#providerKey').value=''; document.querySelector('#providerModels').value=''; await refresh(); feedback.textContent=`Added ${result.directBrowser ? 'to this browser' : 'to this computer'}. Found ${result.provider.modelIds.length} model${result.provider.modelIds.length===1?'':'s'}. Send a message to verify chat access.`;
  } catch(error){feedback.textContent=error.message;} finally {
    controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
    providerFormSaving = false;
  }
});

document.addEventListener('click',async(event)=>{
  const button=event.target.closest('[data-provider-test],[data-provider-remove],[data-provider-key],[data-provider-key-save],[data-provider-limits-save]'); if(!button)return;
  const id=button.dataset.providerTest||button.dataset.providerRemove||button.dataset.providerKey||button.dataset.providerKeySave||button.dataset.providerLimitsSave;
  if(button.dataset.providerLimitsSave) event.preventDefault();
  if(button.dataset.providerKey){document.querySelector(`[data-provider-editor="${id}"]`)?.classList.toggle('hidden');return;}
  button.disabled=true;
  try {
    if(button.dataset.providerLimitsSave){const form=document.querySelector(`[data-provider-limits-form="${id}"]`);if(!form?.reportValidity())return;const limits=window.HexiGridProviderLimits||await import('/provider-limits.mjs');const request=limits.createProviderLimitRequest(id,{maxInputTokens:form.querySelector('[data-provider-max-input]').value===''?null:Number(form.querySelector('[data-provider-max-input]').value),maxOutputTokens:form.querySelector('[data-provider-max-output]').value===''?null:Number(form.querySelector('[data-provider-max-output]').value)});const result=await api(request.path,{method:request.method,body:request.body});state.data.providers=(state.data.providers||[]).map(provider=>provider.id===id?result.provider:provider);renderProviders();notify('Provider token limits updated.');}
    else if(button.dataset.providerTest){const result=await api(`/api/providers/${id}/test`,{method:'POST'});notify(result.message);await refresh();}
    else if(button.dataset.providerRemove){if(!await userConfirm('Disconnect this service?','Its protected API key will be removed from this device.','Disconnect',true))return;await api(`/api/providers/${id}`,{method:'DELETE'});await refresh();}
    else {const field=document.querySelector(`[data-provider-key-input="${id}"]`);if(!field.value)return notify('Paste the new key first.',true);await api(`/api/providers/${id}/key`,{method:'PUT',body:JSON.stringify({apiKey:field.value})});field.value='';await refresh();notify('Protected API key updated.');}
  }catch(error){notify(error.message,true);}finally{button.disabled=false;}
});
