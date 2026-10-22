/* Agent roster, profile editor, pictures, duplication, and removal. */
function usesPairedAgentModel(item) {
  return Boolean(item && (['ilands-link', 'agent-link'].includes(item.transport) || agentRosterLink(item)));
}

function renderAgentCard(item) {
  const source = usesPairedAgentModel(item) ? "Agent Link" : item.transport === "local-opencode" ? "Local" : "iLands";
  const link = agentRosterLink(item);
  const presence = link ? agentRosterPresence(link) : usesPairedAgentModel(item) ? { label: "No active link", className: "" } : { label: statusLabel(item.status), className: statusClass(item.status) };
  return `<article class="agent-card"><div class="agent-card-head">${avatarMarkup(item)}<div><h4>${escapeHtml(agentListLabel(item))}</h4><div class="account">${escapeHtml(agentRosterAccountLabel(item))}</div></div><div class="agent-card-actions"><button class="ghost-button" data-action="edit-agent" data-agent-id="${item.id}">Open</button></div></div><div class="agent-presence"><span class="presence-wave"><i></i><i></i><i></i></span><span>${item.personality ? "Personality ready" : "Personality needs detail"}</span></div><div class="agent-card-footer"><div class="status-label ${presence.className}"><span></span>${escapeHtml(presence.label)}</div><span class="tag">${source}</span></div></article>`;
}

function agentRosterAccountLabel(item) {
  if (usesPairedAgentModel(item) && item.accountLabel === "Existing iLands account") return "Agent profile";
  return item.accountLabel || "No account linked";
}

function agentRosterLink(item) {
  return (state.data.agentLinks || [])
    .filter((link) => link.agentId === item.id && link.authorizationStatus === "connected")
    .sort((a, b) => Date.parse(b.connectedAt || 0) - Date.parse(a.connectedAt || 0))[0] || null;
}

function agentRosterPresence(link) {
  const presence = window.HexiGridViewRenderers.linkPresence(link);
  return { label: presence.label, className: presence.state === 'online' ? 'linked' : '' };
}

function agentLearningPreference(item) {
  return item?.learnFromConversations === true ||
    (item?.learnFromConversations === undefined && item?.transport === 'local-opencode');
}

function agentLearningPatch(transport, enabled) {
  return ['local-opencode', 'ilands-link', 'agent-link'].includes(transport) ? { learnFromConversations: Boolean(enabled) } : {};
}

function agentLearningModelOptions(selected = '', paired = false) {
  const models = availableModels().filter(model => {
    const provider = state.data.providers?.find(item => item.id === model.providerId);
    if (!provider?.enabled || provider.local !== true || provider.hasKey || model.browser) return false;
    try {
      const url = new URL(provider.baseUrl);
      return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch { return false; }
  });
  const options = models.map(model => `<option value="${escapeHtml(model.id)}" ${model.id === selected ? 'selected' : ''}>${escapeHtml(model.label)}</option>`);
  if (selected && !models.some(model => model.id === selected)) options.unshift(`<option value="${escapeHtml(selected)}" selected>Saved learning model unavailable</option>`);
  return `<option value="" ${selected ? '' : 'selected'}>${paired ? 'Choose a local learning model' : 'Use conversation model when local'}</option>${options.join('')}`;
}

function renderAgents() {
  const query = $("#agentSearch").value.trim().toLowerCase();
  const agents = window.HexiGridViewRenderers.orderAgents(state.data.agents, state.data.agentLinks).filter((item) => `${item.name} ${agentRosterAccountLabel(item)} ${agentRosterLink(item)?.id || ""}`.toLowerCase().includes(query));
  $("#agentsList").innerHTML = agents.length ? agents.map((item) => {
    const link = agentRosterLink(item);
    const pairedModel = usesPairedAgentModel(item);
    const connection = pairedModel ? link ? `Agent Link · ${link.id.slice(-8)}` : "No active link" : item.transport === "local-opencode" ? "Local AI" : `iLands · ${item.harness === "codex" ? "Codex" : "Claude Code"}`;
    const presence = link ? agentRosterPresence(link) : pairedModel ? { label: "Offline", className: "" } : { label: statusLabel(item.status), className: statusClass(item.status) };
    const model = pairedModel ? "Managed in agent’s app" : modelInfo(item.model)?.label || item.model || "Default";
    return `<article class="agent-row"><div class="agent-row-main">${avatarMarkup(item)}<div><h4>${escapeHtml(agentListLabel(item))}</h4><p>${escapeHtml(agentRosterAccountLabel(item))}</p><small class="agent-row-mobile-connection">${escapeHtml(connection)} · ${escapeHtml(presence.label)}</small></div></div><div class="agent-row-detail"><span>CONNECTION</span><strong>${escapeHtml(connection)}</strong><small class="agent-row-compact-status">${escapeHtml(presence.label)}</small></div><div class="agent-row-detail"><span>MODEL</span><strong>${escapeHtml(model)}</strong></div><div class="agent-row-detail"><span>STATUS</span><strong class="${presence.className}">${escapeHtml(presence.label)}</strong></div><div class="row-actions"><button class="mini-button" title="Duplicate profile" aria-label="Duplicate ${escapeHtml(agentListLabel(item))}" data-action="duplicate-agent" data-agent-id="${item.id}">+</button><button class="ghost-button" data-action="edit-agent" data-agent-id="${item.id}">Edit ↗</button><button class="ghost-button icon-action-button" title="Remove this agent" aria-label="Remove ${escapeHtml(agentListLabel(item))}" data-action="remove-agent" data-agent-id="${item.id}">×</button></div></article>`;
  }).join("") : state.data.agents.length ? `<div class="panel empty-state">No matching agents.</div>` : `<div class="panel empty-agent-state"><div class="empty-core"><span>+</span></div><div><div class="eyebrow">YOUR TEAM STARTS HERE</div><h3>No agents connected yet</h3><p>Connect an account and its verified agent will appear here, or create an independent local agent.</p><button class="primary-button" data-action="open-connect-agent">Connect or create your first agent</button></div></div>`;
}

function updateAgentConnectionSummary() {
  $('#agentConnectionSummary').textContent = ({ 'ilands-link': 'Paired Agent Link', 'local-opencode': 'Independent local profile', 'ilands-runner': 'iLands Runner' })[$('#transport').value] || 'Choose a profile source';
  const item = state.editingAgentId ? agent(state.editingAgentId) : null;
  const providerManaged = ['ilands-link', 'agent-link'].includes($('#transport').value) || Boolean(item && agentRosterLink(item));
  $('#agentModel').innerHTML = providerManaged ? '' : modelOptions(item?.model || state.data.settings.model);
  $('#agentModel').disabled = providerManaged;
  $('#agentLocalModelField').hidden = providerManaged;
  $('#agentProviderModelNote').hidden = !providerManaged;
  $('#agentLearningModel').innerHTML = agentLearningModelOptions(item?.memoryLearningModel || '', providerManaged);
  syncAgentLearningControl();
}

function syncAgentLearningControl() {
  const control = $('#agentLearnFromConversations');
  const help = $('#agentLearnFromConversationsHelp');
  const pairedProfile = ['ilands-link', 'agent-link'].includes($('#transport').value);
  const localProfile = $('#transport').value === 'local-opencode' || pairedProfile;
  const wasLocalProfile = control.dataset.localProfile === 'true';
  if (wasLocalProfile && !localProfile) control.dataset.localChoice = String(control.checked);
  control.dataset.localProfile = String(localProfile);
  control.disabled = !localProfile;
  $('#agentLearningModelField').hidden = !localProfile;
  $('#agentLearningModel').disabled = !localProfile;
  $('#agentLearningModelHelp').textContent = pairedProfile
    ? 'Required for paired Link learning. Choose a local model; retained conversation text stays on this computer.'
    : 'Optional. Choose a local model for learning even when the conversation uses another model. Retained conversation text stays on this computer.';
  if (!localProfile) control.checked = false;
  else if (!state.editingAgentId && control.dataset.userChanged !== 'true') control.checked = !pairedProfile;
  else if (!wasLocalProfile && control.dataset.localChoice !== undefined) control.checked = control.dataset.localChoice === 'true';
  help.textContent = pairedProfile
    ? 'Learns only from completed room conversations retained in HexiGrid, using your chosen local model and this Link’s current memory read/write permissions and selected memory scope. Private chats in provider apps are never imported. Turn this off to stop new learning; saved memories remain.'
    : localProfile
    ? 'Learns from completed conversations retained in HexiGrid when a compatible local model is configured. Private chats in Muse or another provider app are never imported. Turn this off to stop new learning; saved memories remain. This is independent of using memories in replies.'
    : 'Automatic learning is available for local profiles and paired Agent Links. Runner profiles and private chats in provider apps are not read automatically.';
}

function openAgentModal(agentId = null, options = {}) {
  const item = agentId ? agent(agentId) : null;
  const paired = Boolean(item && state.data.agentLinks?.some(link => link.agentId === item.id && link.authorizationStatus === 'connected'));
  state.editingAgentId = item?.id || null;
  state.avatarDraft = item?.avatarImage || "";
  $('#agentAnimatePortrait').checked = Boolean(item?.portraitAvatar);
  $('#agentPortraitStatus').textContent = item?.portraitAvatar ? 'Animated portrait ready for calls.' : 'One clear face works best. Prepared on this computer; no paid service.';
  clearAvatarModelDraft(false);
  state.avatarModelDraft = item?.avatarModel || null;
  state.avatarModelRemove = false;
  const learningControl = $('#agentLearnFromConversations');
  learningControl.dataset.userChanged = 'false';
  $("#modalTitle").textContent = item ? `Edit ${agentListLabel(item)}` : "Add an agent";
  $("#deleteAgentBtn").classList.toggle("hidden", !item);
  $("#agentId").value = item?.id || "";
  const fields = {
    agentName: item?.name || "", accountLabel: item?.accountLabel || "", transport: usesPairedAgentModel(item) ? 'ilands-link' : item?.transport || "local-opencode",
    harness: item?.harness || "codex", ilandsAgentId: item?.ilandsAgentId || "", externalEmail: item?.externalEmail || "", runnerHome: item?.runnerHome || "",
    workspacePath: item?.workspacePath || "", personality: item?.personality || "", instructions: item?.instructions || "", rules: item?.rules || ""
  };
  Object.entries(fields).forEach(([key, value]) => { $("#" + key).value = value; });
  const initiallyLocal = $('#transport').value === 'local-opencode';
  const savedLearningPreference = item ? agentLearningPreference(item) : initiallyLocal;
  learningControl.dataset.localProfile = String(initiallyLocal);
  learningControl.dataset.localChoice = String(savedLearningPreference);
  $("#transport").disabled = paired;
  $("#transport").title = paired ? 'This profile uses its existing paired Link. Manage pairing in Settings → Connections.' : '';
  updateAgentConnectionSummary();
  for (const id of ['agentInstructionsDisclosure', 'agentAppearanceDisclosure', 'agentConnectionDisclosure']) $('#' + id).open = false;
  if (options.section === 'appearance') $('#agentAppearanceDisclosure').open = true;
  $('#agentMemoryDisclosure').open = options.section === 'memory';
  $('#agentMemoryDisclosure').hidden = false;
  $('#agentUseMemories').checked = item?.useMemories !== false;
  const localProfile = ['local-opencode', 'ilands-link', 'agent-link'].includes($('#transport').value);
  learningControl.checked = localProfile && savedLearningPreference;
  $("#agentUseGlobalCommunication").checked = item?.useGlobalCommunication !== false;
  renderAgentPhoto(item?.name || "Agent", item?.color || "#8d7dff");
  $("#agentModal").classList.remove("hidden");
  document.body.classList.add("overlay-open");
  if (item && options.section === 'memory') {
    const summary = $('#agentMemoryDisclosure summary');
    summary.focus();
    summary.scrollIntoView({ block: 'start' });
  } else {
    $('.agent-profile-body').scrollTop = 0;
    $("#agentName").focus();
  }
}

document.addEventListener('change', (event) => {
  if (event.target.id === 'agentLearnFromConversations') {
    event.target.dataset.userChanged = 'true';
    if (['local-opencode', 'ilands-link', 'agent-link'].includes($('#transport').value)) event.target.dataset.localChoice = String(event.target.checked);
    return;
  }
  if (event.target.id === 'transport') syncAgentLearningControl();
});

function openConnectModal() { $("#connectModal").classList.remove("hidden"); document.body.classList.add("overlay-open"); }
function closeConnectModal() { $("#connectModal").classList.add("hidden"); document.body.classList.remove("overlay-open"); }

function closeAgentModal() { state.portraitPreview?.stop(); state.portraitPreview = null; $("#agentModal").classList.add("hidden"); state.editingAgentId = null; state.avatarDraft = ""; $("#agentPhotoInput").value = ""; $("#agentModelInput").value = ""; clearAvatarModelDraft(false); document.body.classList.remove("overlay-open"); }

function renderAgentPhoto(name = $("#agentName").value || "Agent", color = "#8d7dff") {
  const preview = $("#agentPhotoPreview");
  preview.innerHTML = state.avatarDraft ? `${colorTile(color)}<img class="avatar-photo" src="${escapeHtml(state.avatarDraft)}" alt="Profile picture preview" />` : `${colorTile(color)}<span class="avatar-initials">${escapeHtml(initials(name))}</span>`;
  const item = state.editingAgentId ? agent(state.editingAgentId) : null;
  const animated = item?.avatarImage === state.avatarDraft && item?.portraitAvatar;
  if (animated && window.HexiGridPortraitAvatar) {
    state.portraitPreview?.stop();
    state.portraitPreview = window.HexiGridPortraitAvatar.mount(preview, animated, { preview: true, label: `${name} animated portrait preview` });
  } else { state.portraitPreview?.stop(); state.portraitPreview = null; }
  const modelPreview = $("#agentModelPreview");
  const modelUrl = state.avatarModelObjectUrl || state.avatarModelDraft?.url;
  const format = state.avatarModelFile?.name?.toLowerCase().endsWith('.vrm') ? 'vrm' : state.avatarModelDraft?.format || 'glb';
  modelPreview.innerHTML = modelUrl && $('#agentAppearanceDisclosure').open
    ? window.HexiGridAvatarViewer.element(modelUrl, `${name} 3D avatar preview`, 'agent-model-viewer', format)
    : modelUrl ? '<span>Open to preview</span>' : '<span>3D</span>';
}

function clearAvatarModelDraft(markForRemoval) {
  if (state.avatarModelObjectUrl) URL.revokeObjectURL(state.avatarModelObjectUrl);
  state.avatarModelObjectUrl = "";
  state.avatarModelFile = null;
  state.avatarModelDraft = null;
  state.avatarModelRemove = Boolean(markForRemoval);
}

function chooseAvatarModel(file) {
  if (!file || (!file.name.toLowerCase().endsWith('.glb') && !file.name.toLowerCase().endsWith('.vrm') && file.type !== 'model/gltf-binary')) throw new Error('Choose a self-contained GLB or VRM model file.');
  if (file.size < 20 || file.size > 64 * 1024 * 1024) throw new Error('Choose a GLB or VRM model at most 64 MB.');
  clearAvatarModelDraft(false);
  state.avatarModelFile = file;
  state.avatarModelObjectUrl = URL.createObjectURL(file);
}

async function modelDataUrl(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:model/gltf-binary;base64,${btoa(binary)}`;
}

async function saveAvatarModel(agentId, modelData, approved = false) {
  try { return await api(`/api/agents/${agentId}/avatar-model`, { method: 'POST', body: JSON.stringify({ modelData, approved }) }); }
  catch (error) {
    if (!error.body?.approvalRequired) throw error;
    const accepted = await userConfirm('Save this 3D avatar?', 'The GLB or VRM model will be validated and stored only in HexiGrid’s local data folder. Check the model creator’s usage terms.', 'Save 3D avatar');
    if (!accepted) throw new Error('3D avatar upload cancelled.');
    return saveAvatarModel(agentId, modelData, true);
  }
}

async function resizeProfileImage(file) {
  if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or animated GIF image.");
  if (file.size > 10 * 1024 * 1024) throw new Error("Choose an image smaller than 10 MB.");
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.readAsDataURL(file);
  });
  if (file.type === 'image/gif' && file.size <= 1150 * 1024) return dataUrl;
  if (file.type === 'image/gif') throw new Error('Animated GIF profile pictures must be smaller than 1.15 MB.');
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("That image could not be opened."));
    element.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.82);
}

async function saveAgent(event) {
  event.preventDefault();
  const payload = {
    name: $("#agentName").value, accountLabel: $("#accountLabel").value, transport: $("#transport").value,
    harness: $("#harness").value, ilandsAgentId: $("#ilandsAgentId").value, externalEmail: $("#externalEmail").value, runnerHome: $("#runnerHome").value,
    workspacePath: $("#workspacePath").value, personality: $("#personality").value, instructions: $("#instructions").value,
    rules: $("#rules").value, useGlobalCommunication: $("#agentUseGlobalCommunication").checked,
    useMemories: $("#agentUseMemories").checked,
    avatarImage: state.avatarDraft
  };
  Object.assign(payload, agentLearningPatch($("#transport").value, $("#agentLearnFromConversations").checked));
  if (!$('#agentLearningModel').disabled) payload.memoryLearningModel = $('#agentLearningModel').value;
  if (!$('#agentModel').disabled) payload.model = $('#agentModel').value;
  try {
    const animate = $('#agentAnimatePortrait').checked && Boolean(state.avatarDraft);
    const picture = state.avatarDraft;
    let response = state.editingAgentId
      ? await api(`/api/agents/${state.editingAgentId}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await api("/api/agents", { method: "POST", body: JSON.stringify(payload) });
    if (state.avatarModelFile) response = await saveAvatarModel(response.agent.id, await modelDataUrl(state.avatarModelFile));
    else if (state.avatarModelRemove) response = await api(`/api/agents/${response.agent.id}/avatar-model`, { method: 'DELETE', body: JSON.stringify({ approved: true }) });
    const index = state.data.agents.findIndex((item) => item.id === response.agent.id);
    if (index >= 0) state.data.agents[index] = response.agent; else state.data.agents.push(response.agent);
    if (animate && !response.agent.portraitAvatar) void prepareAgentPortrait(response.agent.id, picture);
    else if (!animate && response.agent.portraitAvatar) {
      const result = await api(`/api/agents/${response.agent.id}/portrait`, { method: 'POST', body: JSON.stringify({ animate: false }) });
      state.data.agents[index] = result.agent;
    }
    closeAgentModal(); renderAll(); notify(`${response.agent.name} saved locally.`);
  } catch (error) { notify(error.message, true); }
}

async function animateAgentPicture() {
  if (!state.avatarDraft) { notify('Choose a picture first.', true); return; }
  $('#agentAnimatePortrait').checked = true;
  if (!state.editingAgentId) { notify('Save this agent to prepare its animated portrait.'); return; }
  await prepareAgentPortrait(state.editingAgentId, state.avatarDraft);
}

async function prepareAgentPortrait(agentId, imageData) {
  try {
    const result = await api(`/api/agents/${agentId}/portrait`, { method: 'POST', body: JSON.stringify({ imageData }) });
    notify(result.job.status === 'setting-up' ? 'Setting up local portrait animation once. Your calls can continue.' : 'Preparing your animated portrait…');
    const deadline = Date.now() + 21 * 60_000;
    const poll = async () => {
      const current = await api(`/api/agents/${agentId}/portrait`);
      if (state.editingAgentId === agentId) $('#agentPortraitStatus').textContent = current.job.status === 'setting-up' ? 'Setting up once on this computer…' : current.job.status === 'preparing' ? 'Preparing your portrait…' : current.job.error || 'Animated portrait ready for calls.';
      if (current.job.status === 'failed') { notify(current.job.error, true); return; }
      if (current.job.status === 'ready') {
        const item = agent(agentId);
        if (item) { item.avatarImage = current.image; item.portraitAvatar = current.portrait; }
        if (state.editingAgentId === agentId) renderAgentPhoto();
        notify('Animated portrait ready for video calls.'); return;
      }
      if (Date.now() < deadline) window.setTimeout(() => { void poll().catch(error => notify(error.message, true)); }, 1500);
    };
    void poll().catch(error => notify(error.message, true));
  } catch (error) { notify(error.message, true); }
}

async function duplicateAgent(agentId) {
  try {
    const response = await api(`/api/agents/${agentId}/duplicate`, { method: "POST" });
    state.data.agents.push(response.agent); renderAll();
    notify(response.agent.transport === "local-opencode" ? `${response.agent.name} created as an independent local profile. Connections and permissions start fresh.` : `${response.agent.name} created. Connect a separate account before using it.`);
  } catch (error) { notify(error.message, true); }
}

async function removeAgentById(agentId) {
  const item = agent(agentId);
  if (!item) return;
  const label = agentListLabel(item);
  const links = (state.data.agentLinks || []).filter(link => link.agentId === item.id && link.authorizationStatus === 'connected');
  if (links.length) {
    const confirmed = await window.hexigridModal({
      title: `Remove ${label}?`,
      message: 'This removes the local profile from your agent list and rooms. You can connect the agent again later with a new Link. Saved memories must be handled before removal.',
      accept: 'Disconnect and remove', danger: true,
      fields: [{ type: 'checkbox', label: `Disconnect ${label} and revoke its access`, required: true,
        description: 'Stops work using this connection. Other agents keep their access.' }]
    });
    if (!confirmed?.[0]) return;
  } else if (!await userConfirm(`Remove ${label}?`, 'This removes the local profile from your agent list and rooms. Saved memories must be handled before removal. Connected service credentials are kept separately.', 'Remove agent', true)) return;
  try {
    const result = await api(`/api/agents/${encodeURIComponent(item.id)}`, { method: "DELETE", body: JSON.stringify({ revokeLinkIds: links.map(link => link.id), approved: true }) });
    state.data.agents = state.data.agents.filter((candidate) => candidate.id !== item.id);
    state.data.rooms.forEach((room) => { room.agentIds = room.agentIds.filter((candidate) => candidate !== item.id); });
    state.data.agentLinks = (state.data.agentLinks || []).map(link => result.connections?.find(updated => updated.id === link.id) || link);
    closeAgentModal(); renderAll(); notify(`${label} removed.`);
  } catch (error) {
    if (error.body?.code === 'AGENT_CONNECTIONS_CHANGED') await refresh();
    notify(error.message, true);
  }
}

async function deleteAgent() { if (state.editingAgentId) await removeAgentById(state.editingAgentId); }
