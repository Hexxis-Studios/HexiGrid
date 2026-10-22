(() => {
  // Authorization, transport liveness and session permissions are separate.
  function linkPresence(link = {}) {
    const authorization = link.authorizationStatus;
    const state = authorization && authorization !== 'connected' ? authorization : link.heartbeat?.state || link.status || 'unknown';
    const label = { online: 'Online', degraded: 'Heartbeat delayed', offline: authorization === 'connected' ? 'Paired · heartbeat idle' : 'Offline', revoked: 'Revoked', stale: 'Replaced', unknown: 'Status unknown' }[state] || 'Status unknown';
    const format = (value) => {
      const at = Date.parse(value || '');
      return Number.isFinite(at) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(at) : 'not received';
    };
    return { state, label, detail: `Last heartbeat: ${format(link.lastHeartbeatAt || link.heartbeat?.lastAt)}. Last signed contact: ${format(link.lastSeenAt)}.` };
  }
  function orderAgents(agents, links = []) {
    const paired = new Set(links.filter((link) => link.authorizationStatus === 'connected').map((link) => link.agentId));
    const rank = (item) => paired.has(item.id) ? 0 : item.status === 'local_ready' ? 1 : 2;
    return [...agents].sort((a, b) => rank(a) - rank(b));
  }
  function agentSelectionStanding(item, links = []) {
    const link = links.filter(candidate => candidate.agentId === item.id && candidate.authorizationStatus === 'connected')
      .sort((a, b) => (Date.parse(b.connectedAt || 0) || 0) - (Date.parse(a.connectedAt || 0) || 0))[0];
    if (link) return linkPresence(link).label;
    if (['agent-link', 'ilands-link'].includes(item.transport)) return 'No active link';
    return item.status === 'local_ready' ? 'Local ready' : String(item.status || 'Status unknown').replaceAll('_', ' ');
  }
  function renderOverview({ state, $, escapeHtml, timeAgo, workMode, approvalProfile, renderAgentCard }) {
    const agents = orderAgents(state.data.agents, state.data.agentLinks);
    const settings = state.data.settings;
    const goal = settings.activeGoal;
    $("#metricAgents").textContent = agents.length;
    if (agents.length) {
      const localReady = agents.filter((item) => item.status === "local_ready").length;
      $("#metricAgentsMeta").textContent = `${localReady} local agent${localReady === 1 ? '' : 's'} ready`;
    } else $("#metricAgentsMeta").textContent = "Add your first agent";
    const runningRunners = (state.data.runnerProfiles || []).filter((profile) => profile.runtime?.running === true).length;
    const onlineLinks = (state.data.agentLinks || []).filter((link) => link.authorizationStatus === 'connected' && (link.heartbeat?.state || link.status) === 'online').length;
    $("#metricConnected").textContent = runningRunners + onlineLinks;
    $("#metricRooms").textContent = state.data.rooms.length;
    $("#syncMetric").textContent = settings.sync.enabled ? "Encrypted" : "Off";
    $("#agentCountNav").textContent = agents.length;
    $("#activeGoalTitle").textContent = goal?.title || "No active goal";
    $("#activeGoalMeta").textContent = goal?.title ? `${goal.status} · context for agents; create a task to begin work` : "Save an outcome, then create a bounded task to work toward it.";
    $("#postureMode").textContent = workMode(settings.workMode)?.label || "Converse";
    $("#postureApproval").textContent = approvalProfile(settings.approvalPolicy)?.label || "Approve for me";
    $("#postureSubagents").textContent = settings.subagents.enabled ? `Up to ${settings.subagents.maxConcurrent}` : "Disabled";
    $("#overviewAgents").innerHTML = agents.length ? agents.slice(0, 8).map(renderAgentCard).join("") : `<div class="panel empty-overview"><div class="empty-core"><span>+</span></div><div><strong>Connect your first agent</strong><p>Bring in an account or create a local personality. Nothing appears here until you add it.</p></div><button class="primary-button" data-action="open-connect-agent">Connect or create</button></div>`;
    const icons = { chat: "chat", room: "chat", policy: "shield", assistant: "assistant", communication: "speech", model: "models", workspace: "workspace", terminal: "terminal", agent: "agents", system: "activity" };
    $("#activityList").innerHTML = state.data.activity.slice(0, 8).map((event) => `<div class="activity-item"><div class="activity-icon" data-icon="${icons[event.kind] || 'activity'}"></div><div class="activity-text">${escapeHtml(event.text)}<span class="activity-time">${timeAgo(event.createdAt)}</span></div></div>`).join("") || `<div class="empty-state">No activity yet.</div>`;
  }

  function usageWindow(snapshot, { days = 7, endAt = Date.now(), agentId = 'all' } = {}) {
    const cutoff = endAt - days * 86400000;
    return (snapshot.usage || []).filter(item => {
      const at = new Date(item.createdAt).getTime();
      return at >= cutoff && at <= endAt && (agentId === 'all' || (item.agentId || 'assistant') === agentId);
    });
  }
  function usageMeteringLabel(items) {
    return items.some(item => item.estimated === true) ? 'Includes estimates' : items.some(item => item.estimated !== false) ? 'Metering source not recorded' : 'Provider-reported tokens';
  }
  function agentUsageReport(snapshot, { days = 7, endAt = Date.now() } = {}) {
    const records = usageWindow(snapshot, { days, endAt });
    const groups = new Map();
    for (const record of records) {
      const key = record.agentId || 'assistant';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    const totals = items => ({ requests: items.length, inputTokens: items.reduce((sum, item) => sum + item.inputTokens, 0), outputTokens: items.reduce((sum, item) => sum + item.outputTokens, 0), metering: items.length ? usageMeteringLabel(items) : 'No requests recorded' });
    return { from: new Date(endAt - days * 86400000).toISOString(), through: new Date(endAt).toISOString(), days, ...totals(records), agents: [...groups].map(([agentId, items]) => ({ agentId, name: (snapshot.agents || []).find(item => item.id === agentId)?.name || (agentId === 'assistant' ? 'HexiGrid assistant' : 'Removed agent'), ...totals(items) })) };
  }
  function renderUsage({ state, $, $$, escapeHtml, timeAgo, agent, avatarMarkup, levelClass }) {
    const days = state.usagePeriod === "day" ? 1 : state.usagePeriod === "month" ? 30 : 7;
    const endAt = Date.now();
    const select = $("#usageAgentFilter");
    const requested = select.value || "all";
    const filter = requested === 'assistant' || state.data.agents.some(item => item.id === requested) ? requested : "all";
    select.innerHTML = `<option value="all">All agents</option><option value="assistant">HexiGrid assistant</option>${state.data.agents.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(agentListLabel(item))}</option>`).join("")}`;
    select.value = filter;
    const usage = usageWindow(state.data, { days, endAt, agentId: filter });
    const meteringLabel = usageMeteringLabel;
    const totalInput = usage.reduce((sum, item) => sum + item.inputTokens, 0);
    const totalOutput = usage.reduce((sum, item) => sum + item.outputTokens, 0);
    $("#usageTotal").textContent = (totalInput + totalOutput).toLocaleString();
    const budget = state.data.usageBudget;
    const browserOnly = state.data.bridge?.standaloneBrowser === true;
    const budgetForm = $('#usageBudgetForm'), budgetNotice = $('#usageBudgetPlatformNotice');
    if (budgetForm) budgetForm.hidden = false;
    if (budgetNotice) budgetNotice.hidden = !browserOnly;
    const budgetNode = $("#usageBudgetFeedback");
    if (budgetNode) budgetNode.textContent = !budget || budget.flag === 'unconfigured' ? 'No 7-day token budget configured' : `${budget.remaining.toLocaleString()} tokens remaining · ${budget.flag === 'under-budget' ? 'under budget' : budget.flag}`;
    const budgetInput = $('#usageBudgetInput');
    if (budgetInput?.dataset && budgetInput.dataset.edited !== 'true') {
      budgetInput.value = budget?.limit ?? '';
      budgetInput.dataset.expectedTokens = JSON.stringify(budget?.limit ?? null);
    }
    $("#usageInput").textContent = totalInput.toLocaleString();
    $("#usageOutput").textContent = totalOutput.toLocaleString();
    $("#usageChartTitle").textContent = days === 1 ? "Last 24 hours · 2-hour intervals" : `Last ${days} days`;
    $$('[data-usage-period]').forEach((button) => button.classList.toggle("active", button.dataset.usagePeriod === state.usagePeriod));
    const buckets = [];
    const count = days === 1 ? 12 : days;
    const interval = days === 1 ? 2 * 3600000 : 86400000;
    for (let index = count - 1; index >= 0; index -= 1) {
      const start = endAt - (index + 1) * interval;
      const end = start + interval;
      const items = usage.filter((item) => { const time = new Date(item.createdAt).getTime(); return time >= start && (index === 0 ? time <= end : time < end); });
      const value = items.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0);
      const date = new Date(end);
      buckets.push({ value, start, end, label: days === 1 ? date.toLocaleTimeString([], { hour: "numeric" }) : date.toLocaleDateString([], { month: "short", day: "numeric" }) });
    }
    const max = Math.max(1, ...buckets.map((bucket) => bucket.value));
    const chart = $("#usageChart");
    chart.dataset.columns = String(count);
    const localDateTime = timestamp => new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    chart.innerHTML = buckets.map((bucket) => {
      const detail = `${bucket.label} · ${bucket.value.toLocaleString()} tokens · Local interval: ${localDateTime(bucket.start)} → ${localDateTime(bucket.end)}`;
      const safeDetail = escapeHtml(detail);
      return `<button type="button" class="usage-bar-wrap" title="${safeDetail}" aria-label="${safeDetail}" data-usage-detail="${safeDetail}"><span class="usage-bar-value">${bucket.value.toLocaleString()}</span><i class="${levelClass(bucket.value, max)}"></i><small>${escapeHtml(bucket.label)}</small></button>`;
    }).join("");
    $("#usageChartDetail").textContent = "Tap or focus a bar to see its exact token count and local interval.";
    const groups = new Map();
    for (const item of usage) {
      const key = item.agentId || "assistant";
      const group = groups.get(key) || { value: 0, items: [] };
      group.value += item.inputTokens + item.outputTokens;
      group.items.push(item);
      groups.set(key, group);
    }
    $("#usageAgentBreakdown").innerHTML = [...groups.entries()].sort((a,b) => b[1].value-a[1].value).map(([key, group]) => { const { value, items } = group; const item = agent(key); const name = item ? agentListLabel(item) : key === 'assistant' ? 'HexiGrid assistant' : `Removed agent · ${key}`; return `<div class="usage-agent-row">${item ? avatarMarkup(item, "agent-avatar compact-avatar") : `<div class="agent-avatar compact-avatar" data-icon="assistant"></div>`}<div><strong>${escapeHtml(name)}</strong><small>${value.toLocaleString()} tokens · ${meteringLabel(items)}</small></div><div class="usage-meter"><i class="${levelClass(value, Math.max(1,totalInput+totalOutput))}"></i></div><b>${Math.round(value / Math.max(1,totalInput+totalOutput) * 100)}%</b></div>`; }).join("") || `<div class="empty-state">No requests recorded for this agent and time period.</div>`;
    $("#usageLegend").innerHTML = `<span><i></i>${usage.length ? meteringLabel(usage) : 'No requests recorded'}</span>`;
  }

  function renderModels({ state, $, escapeHtml, availableModels, modelOptions, modelAllowedByPreference, avatarMarkup, selectionPending = null }) {
    const busy = Boolean(selectionPending);
    const selected = selectionPending && !selectionPending.agentId ? selectionPending.model : state.data.settings.model;
    const options = modelOptions(selected);
    $("#globalModelSelect").innerHTML = options;
    $("#defaultModelSelect").innerHTML = options;
    for (const selector of ['#globalModelSelect', '#defaultModelSelect', '#modelPolicySelect']) {
      $(selector).disabled = busy;
      $(selector).setAttribute('aria-busy', String(busy));
    }
    $("#modelPolicySelect").value = state.data.settings.modelPolicy || 'free-only';
    $("#modelCatalog").innerHTML = availableModels().map((model) => `<button class="model-card ${model.id === selected ? "active" : ""} ${modelAllowedByPreference(model) ? '' : 'model-blocked'}" data-action="choose-model" data-model="${escapeHtml(model.id)}" ${!busy && modelAllowedByPreference(model) ? '' : 'disabled'}><span class="model-status"></span><div><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(model.id)}</small></div><span class="free-tag">${model.browser ? "IN BROWSER" : model.free ? "NO COST" : model.cloud ? "CONNECTED" : "LOCAL"}</span></button>`).join("") || `<div class="panel empty-state"><strong>No models connected</strong><p>Open Connections and choose an API key, local model app, detected signed-in computer tool, or This device.</p></div>`;
    $("#agentModelList").innerHTML = state.data.agents.length ? orderAgents(state.data.agents, state.data.agentLinks).map((item) => {
      const paired = ['ilands-link', 'agent-link'].includes(item.transport);
      const connected = paired && (state.data.agentLinks || []).some(link => link.agentId === item.id && link.authorizationStatus === 'connected');
      const account = paired ? (connected ? 'Paired agent' : 'No active Link') : item.accountLabel;
      const assigned = selectionPending?.agentId === item.id ? selectionPending.model : item.model || state.data.settings.model;
      return `<div class="agent-model-row${paired ? ' provider-managed' : ''}">${avatarMarkup(item, "agent-avatar compact-avatar")}<div><strong>${escapeHtml(agentListLabel(item))}</strong><small>${escapeHtml(account)}</small></div>${paired ? '<span class="provider-model-note">Model managed in the agent’s app</span>' : `<select aria-label="Model for ${escapeHtml(agentListLabel(item))}" data-agent-model="${escapeHtml(item.id)}" ${busy ? 'disabled aria-busy="true"' : ''}>${modelOptions(assigned)}</select>`}</div>`;
    }).join("") : `<div class="empty-state">Add an agent to assign a model.</div>`;
  }

  function renderSetup({ state, $, escapeHtml, modelInfo }) {
    const bridge = state.data.bridge;
    const badge = $("#bridgeBadge");
    badge.textContent = bridge.runnerInstalled ? "iLands connection ready" : "iLands connection optional";
    badge.className = `status-badge ${bridge.runnerInstalled ? "" : "warn"}`;
    $("#bridgeDetails").innerHTML = `<div class="bridge-line"><span>AI connections</span><strong>${(state.data.providers?.length||0)+(state.data.harnesses?.filter(item=>item.connected).length||0)}</strong></div><div class="bridge-line"><span>Runtime</span><strong>${bridge.standaloneBrowser ? 'Standalone browser · no desktop' : 'Local HexiGrid service'}</strong></div><div class="bridge-line"><span>Optional iLands connection</span><strong class="bridge-value ${bridge.runnerInstalled ? "ok" : "warn"}">${bridge.runnerInstalled ? "Detected" : bridge.standaloneBrowser ? 'Needs an optional host' : "Install the connection helper"}</strong></div><div class="bridge-line"><span>iLands-specific access</span><strong class="bridge-value warn">iLands account and world access</strong></div><div class="bridge-line"><span>Room messages</span><strong>Local to HexiGrid</strong></div><div class="bridge-line"><span>Default model</span><strong>${escapeHtml(modelInfo(bridge.model)?.label || bridge.model || 'Choose a model')}</strong></div><div class="bridge-line"><span>Model choice</span><strong>${state.data.settings.modelPolicy === 'free-only' ? 'No-cost only' : 'All connected models'}</strong></div>${bridge.port ? `<div class="bridge-line"><span>Local address</span><strong>127.0.0.1:${bridge.port}</strong></div>` : ''}`;
    const policy = document.querySelector('#view-setup .model-policy'); if(policy) policy.innerHTML = `<span class="policy-check">✓</span><div><strong>${state.data.settings.modelPolicy === 'free-only' ? 'No-cost guard is on' : 'All connected models are allowed'}</strong><p>${state.data.settings.modelPolicy === 'free-only' ? 'Metered OpenCode and cloud models cannot be selected.' : 'HexiGrid will use a paid model only when you select it.'}</p></div>`;
    $("#setupSteps").innerHTML = state.data.guide.steps.map((step, index) => `<div class="setup-step"><span class="step-number">${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(step)}</strong></div></div>`).join("");
    const profiles = state.data.runnerProfiles || [];
    $("#setupRoster").innerHTML = profiles.length ? profiles.map((profile) => `<div class="setup-roster-row"><div><strong>${escapeHtml(profile.label)}</strong><small>${escapeHtml(profile.harness)}</small></div><span>${profile.agentId ? "Account linked" : "Setup needed"}</span><span>${profile.runtime?.running ? "Runner active" : "Runner stopped"}</span><button class="ghost-button" data-view-target="integrations">Manage ↗</button></div>`).join("") : `<div class="empty-state">No iLands Runner profiles yet. Add one in Settings → Connections.</div>`;
  }

  function renderAccess({ state, $, escapeHtml, workMode, approvalProfile }) {
    const settings = state.data.settings;
    const catalog = state.data.policyCatalog;
    $("#workModeSelect").innerHTML = catalog.workModes.map((mode) => `<option value="${mode.id}" ${mode.id === settings.workMode ? "selected" : ""}>${escapeHtml(mode.label)}</option>`).join("");
    $("#approvalSelect").innerHTML = catalog.approvalProfiles.map((profile) => `<option value="${profile.id}" ${profile.id === settings.approvalPolicy ? "selected" : ""}>${escapeHtml(profile.label)}</option>`).join("");
    $("#modeCards").innerHTML = catalog.workModes.map((mode) => `<button class="mode-card ${mode.id === settings.workMode ? "active" : ""}" data-action="choose-mode" data-mode="${mode.id}"><span class="mode-symbol" data-icon="${({ converse: 'converse', setup: 'settings', plan: 'plan', goal: 'goal', sketch: 'sketch', research: 'research', build: 'build', watch: 'watch' })[mode.id] || 'models'}"></span><strong>${escapeHtml(mode.label)}</strong><small>${escapeHtml(mode.description)}</small><span class="capability-count">${mode.capabilities.length} allowed actions</span></button>`).join("");
    $("#approvalCards").innerHTML = catalog.approvalProfiles.map((profile) => `<button class="approval-card ${profile.id === settings.approvalPolicy ? "active" : ""}" data-action="choose-approval" data-approval="${profile.id}"><span class="approval-radio"></span><span><strong>${escapeHtml(profile.label)}</strong><small>${escapeHtml(profile.description)}</small></span></button>`).join("");
    $("#goalInput").value = settings.activeGoal?.title || "";
    $("#subagentsEnabled").checked = settings.subagents.enabled;
    $("#subagentLimit").value = settings.subagents.maxConcurrent;
    $("#terminalMode").textContent = `${workMode(settings.workMode)?.label || "Converse"} · ${approvalProfile(settings.approvalPolicy)?.label || "Review"}`;
  }

  function receiptStanding(status) {
    return ({ completed: ['Completed', 'complete'], failed: ['Failed', 'deny'], blocked: ['Blocked', 'deny'], denied: ['Denied', 'deny'], waiting_approval: ['Needs approval', 'ask'], pending: ['Pending', 'ask'], running: ['Running', 'ask'], cancelled: ['Cancelled', 'neutral'] })[status] || (status ? ['Unknown', 'neutral'] : ['Recorded', 'neutral']);
  }

  function receiptCategory(receipt) {
    const action = String(receipt.action || '');
    const capability = String(receipt.capability || '');
    if (/^(auth:|backup[:\-]|security:|capability:|permissions?:|emergency-stop)/.test(action) || /^(manage_sessions|restore_backup|write_backup|emergency_stop|manage_permissions)$/.test(capability)) return 'policy';
    if (/^(room:|chat:|codex-relay:|presence:|voice[.:])/.test(action)) return 'chat';
    if (/^(workspace:|terminal:|harness-job:|runner:|plugin:|mcp:|owner-agent:(exec|fs\/))/.test(action)) return 'workspace';
    if (/^(model:|provider:)/.test(action)) return 'model';
    if (/^(agent[:\-]|avatar[:_]|memory:|skill:|continuity:)/.test(action)) return 'agent';
    if (/^(write_workspace|run_tools|owner-process|workspace-read|workspace-write|owner-filesystem-read|owner-filesystem-write)$/.test(capability)) return 'workspace';
    if (capability === 'conversation') return 'chat';
    return receipt.source || 'tool';
  }

  function renderActivity({ state, $, escapeHtml, timeAgo }) {
    const search = $("#activitySearch").value.trim().toLowerCase();
    const filter = $("#activityFilter").value;
    const outcome = $('#activityOutcome')?.value || 'all';
    const receipts = (state.data.receipts || []).map((receipt) => ({ id: receipt.id, kind: receiptCategory(receipt), source: receipt.source || 'Not recorded', text: `${receipt.action}: ${receipt.detail}`, createdAt: receipt.createdAt, receiptStatus: receipt.status || 'unknown', risk: receipt.risk, capability: receipt.capability, agentId: receipt.agentId }));
    const events = [...receipts, ...state.data.activity].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt)).filter((event) => {
      const category = ({ room: 'chat', communication: 'chat', security: 'policy', 'agent-link': 'agent', terminal: 'workspace' })[event.kind] || event.kind;
      const kindMatch = filter === "all" || category === filter;
      const outcomeMatch = outcome === 'all' || (outcome === 'attention' ? ['failed', 'blocked', 'denied', 'waiting_approval'].includes(event.receiptStatus) : outcome === 'in_progress' ? ['pending', 'running'].includes(event.receiptStatus) : outcome === 'recorded' ? !event.receiptStatus : event.receiptStatus === outcome);
      return kindMatch && outcomeMatch && (!search || `${event.kind} ${event.source || ''} ${event.text} ${event.receiptStatus || 'recorded'} ${event.capability || ''} ${event.id || ''}`.toLowerCase().includes(search));
    });
    const icons = { agent: "agents", chat: "chat", room: "chat", workspace: "workspace", terminal: "terminal", policy: "shield", model: "models", assistant: "assistant", communication: "speech", system: "activity" };
    const visibleCount = Math.max(100, Number(state.activityVisibleCount) || 100);
    const visibleEvents = events.slice(0, visibleCount);
    $("#activityResultCount").textContent = events.length > visibleEvents.length ? `Showing ${visibleEvents.length} of ${events.length} events` : `${events.length} event${events.length === 1 ? "" : "s"}`;
    $("#activityTimeline").innerHTML = visibleEvents.map((event) => {
      const [label, tone] = receiptStanding(event.receiptStatus);
      return `<article class="timeline-event"><div class="timeline-glyph" data-icon="${icons[event.kind] || 'activity'}"></div><div><div class="timeline-meta"><span>${escapeHtml(event.kind || "system")}${event.risk ? ` · ${escapeHtml(event.risk)} risk` : ''}</span><time>${timeAgo(event.createdAt)}</time></div><p>${escapeHtml(event.text)}</p><small>${new Date(event.createdAt).toLocaleString()}</small>${event.receiptStatus ? `<details class="receipt-details"><summary>Receipt details</summary><dl><dt>ID</dt><dd>${escapeHtml(event.id)}</dd><dt>Source</dt><dd>${escapeHtml(event.source)}</dd><dt>Permission</dt><dd>${escapeHtml(event.capability || 'Not recorded')}</dd><dt>Agent</dt><dd>${escapeHtml(state.data.agents?.find(agent => agent.id === event.agentId)?.name || event.agentId || 'Not recorded')}</dd><dt>Standing</dt><dd>${escapeHtml(event.receiptStatus)}</dd></dl></details>` : ''}</div><span class="receipt-status ${tone}">${escapeHtml(label)}</span></article>`;
    }).join("") + (events.length > visibleEvents.length ? `<button class="secondary-button activity-show-more" type="button" data-action="show-more-activity">Show 100 more</button>` : "") || `<div class="empty-state">No activity matches these filters.</div>`;
  }

  function renderSettings({ state, $, $$, escapeHtml, initials }) {
    const owner = state.data.settings.owner || { displayName: "Owner", avatarImage: "" };
    $("#ownerName").value = owner.displayName || "Owner";
    const ownerAvatar = $("#ownerAvatar");
    ownerAvatar.innerHTML = owner.avatarImage ? `<img src="${escapeHtml(owner.avatarImage)}" alt="Owner profile picture" />` : escapeHtml(initials(owner.displayName || "Owner"));
    const theme = window.HexiGridPreferences.getItem("hexigrid-theme") || "aurora-dark";
    $$('[data-theme-choice]').forEach((card) => {
      const active = card.dataset.themeChoice === theme;
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', String(active));
    });
    $("#motionEnabled").checked = window.HexiGridPreferences.getItem("hexigrid-motion") !== "off";
    $("#buttonSoundsEnabled").checked = window.HexiInteractions?.soundsEnabled() !== false;
    $("#compactMode").checked = window.HexiGridPreferences.getItem("hexigrid-compact") === "on";
    const installButton = $("#installPwaBtn");
    const standalone = matchMedia("(display-mode: standalone)").matches;
    installButton.textContent = standalone ? "Installed on this device" : state.deferredInstallPrompt ? "Install on this device" : "Installation help";
    installButton.disabled = standalone;
  }

  function renderNetwork({ state, $, escapeHtml }) {
    const network = state.network;
    if (!network) return;
    const badge = $("#networkBadge");
    const button = $("#copyMobileAddress");
    const remoteButton = $("#remoteLinkButton");
    if (network.standaloneBrowser) {
      badge.textContent = "STANDALONE";
      badge.className = "status-badge";
      $("#networkDescription").textContent = "This browser works independently for direct-capable cloud APIs and supported on-device models. Pair a host only for desktop files, CLIs, isolated tools, or background work.";
      $("#networkDetails").innerHTML = `<div><span>Cloud requests</span><strong>Direct from this browser</strong></div><div><span>Local protection</span><strong>Passcode-derived AES-256 vault</strong></div>`;
      button.disabled = true;
      remoteButton.disabled = true;
      return;
    }
    remoteButton.disabled = false;
    remoteButton.textContent = network.tunnel?.running ? "Close temporary remote link" : network.tunnel?.starting ? "Opening remote link…" : "Open temporary remote link";
    if (network.tunnel?.running) {
      badge.textContent = "REMOTE LINK OPEN";
      badge.className = "status-badge warn";
      $("#networkDescription").textContent = "This temporary public link closes when HexiGrid stops. Anyone opening it must enter the current pairing code; a valid code signs that device into a temporary workspace session.";
      $("#networkDetails").innerHTML = `<div><span>Temporary address</span><strong>${escapeHtml(network.tunnel.url)}</strong></div><div><span>Pairing code</span><strong>${escapeHtml(network.pairingCode || "Shown only on the host computer")}</strong></div>`;
      button.disabled = !network.pairingCode;
      return;
    }
    if (!network.enabled) {
      badge.textContent = "LOCAL ONLY";
      badge.className = "status-badge warn";
      $("#networkDescription").textContent = "Phone access is off. Restart with private-network access when both devices are on Wi-Fi you trust.";
      $("#networkDetails").innerHTML = `<div><span>Windows shortcut</span><strong>Use “Open on phone”</strong></div><div><span>Command</span><strong>Start-Control-Room.ps1 -Network</strong></div>`;
      button.disabled = true;
      return;
    }
    badge.textContent = "READY TO PAIR";
    badge.className = "status-badge";
    $("#networkDescription").textContent = "Choose an address below while your phone is on the same private network. The pairing code changes whenever HexiGrid restarts.";
    $("#networkDetails").innerHTML = network.urls.length ? network.urls.map((url) => `<div><span>Phone address</span><strong>${escapeHtml(url)}</strong></div>`).join("") + `<div><span>Pairing code</span><strong>${escapeHtml(network.pairingCode || "Open this page on the computer")}</strong></div>` : `<div><span>No private address found</span><strong>Check Windows network settings</strong></div>`;
    button.disabled = !network.urls.length || !network.pairingCode;
  }

  function taskHistoryHtml(task, allRuns) {
    const escape = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
    const runs = (allRuns || []).filter(run => run.taskId === task.id).slice(0, 10);
    const output = task.lastOutput ? `<details class="task-instructions"><summary>Last completed result</summary><pre>${escape(task.lastOutput)}</pre></details>` : '';
    const history = `<details class="task-instructions"><summary>Recent runs (${runs.length})</summary>${runs.length ? runs.map(run => `<div class="work-run"><code>${escape(run.id)}</code><small>${escape(run.status)} · ${escape(run.startedAt || 'Time not recorded')}</small>${run.error ? `<p>${run.status === 'cancelled' ? '' : 'Error: '}${escape(taskErrorText(run.error))}</p>` : ''}${run.output ? `<pre>${escape(run.output)}</pre>` : !run.error ? `<p>${run.status === 'running' ? 'Execution is in progress; no completed result yet.' : 'No completed output recorded.'}</p>` : ''}</div>`).join('') : '<p>No run records are included in this view.</p>'}</details>`;
    return output + history;
  }

  function taskErrorText(value) {
    return String(value || '').replace(/\bspawn_subagents\b/g, 'autonomous tasks');
  }

  function agentWorkRecords(snapshot) {
    const escape = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
    const people=snapshot.agents || [];
    const person=id => people.find(item=>item.id===id)?.name || 'Missing agent';
    const tasks=(snapshot.tasks || []).map(task=>{
      const origin=task.source==='agent-link'?'Signed Link task':'Owner task';
      const limit=task.maxRuns===0?'no run limit':`limit ${task.maxRuns ?? 1}`;
      return `<article class="record" data-task-id="${escape(task.id)}"><strong>${escape(task.name)}</strong><small>${escape(person(task.agentId))} · ${escape(task.status || 'paused')} · ${origin}</small><code>${escape(task.id)}</code><small>${task.runCount || 0} runs · ${limit} · interval ${task.intervalSeconds || 0}s · ${task.retryCount || 0}/${task.maxRetries || 0} retries</small>${task.lastError?`<p class="work-outcome">${task.status === 'cancelled' ? '' : 'Error: '}${escape(task.lastError)}</p>`:''}<details><summary>Instructions</summary><pre>${escape(task.prompt)}</pre></details>${taskHistoryHtml(task, snapshot.taskRuns)}</article>`;
    }).join('') || '<p>No tasks. Create a paused task using the local owner createTask contract, or signedLinkTasks with the Tasks grant.</p>';
    const rooms=(snapshot.rooms || []).map(room=>{
      const chain=room.replyChain;
      const responder=chain?.agentIds?.[chain.index];
      return `<article class="record" data-room-id="${escape(room.id)}"><strong>${escape(room.name)}</strong><small>${room.archived?'Archived':'Active'} · ${room.agentIds?.length || 0} participants · ${room.messages?.length || 0} messages</small><code>${escape(room.id)}</code>${chain?`<dl class="work-standing"><div><dt>Reply status</dt><dd>${escape(chain.status)}</dd></div><div><dt>Request ID for Stop</dt><dd><code>${escape(chain.requestId)}</code></dd></div>${responder?`<div><dt>Current responder</dt><dd>${escape(person(responder))}</dd></div>`:''}</dl>${chain.error?`<p class="work-outcome">${escape(chain.error)}</p>`:''}`:'<small>No saved host continuation.</small>'}</article>`;
    }).join('') || '<p>No rooms.</p>';
    return {tasks,rooms};
  }

  function agentCatalogEntries(manifest, { query = '', authentication = 'all' } = {}) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return ['resources', 'actions'].flatMap((kind) => Object.entries(manifest[kind] || {}).map(([name, action]) => {
      const path = action.path || action.pathTemplate || action.pathPrefix || '';
      const auth = path.startsWith('/agent-link/') || action.authentication === 'signed Link' ? 'signed' : action.ownerOnly ? 'owner' : 'workspace';
      return { name, kind, action, path, authentication: auth };
    })).filter((entry) => (authentication === 'all' || entry.authentication === authentication)
      && terms.every((term) => `${entry.name} ${JSON.stringify(entry.action)}`.toLowerCase().includes(term)));
  }

  function createMemoryRecall({ root, request, agents = () => [], label = (agent) => agent.name, openProfile, ask, healthReports = () => [] }) {
    const find = (selector) => root.querySelector(selector);
    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
    const picker = find('#memoryRecallAgent');
    const status = find('#memoryRecallStatus');
    const list = find('#memoryRecallList');
    const healthStatus = find('#memoryHealthStatus'), healthIssues = find('#memoryHealthIssues');
    const healthCheck = find('#memoryHealthCheck'), healthMore = find('#memoryHealthMore');
    const rollbackPanel = find('#memoryRollbackPanel'), rollbackStatus = find('#memoryRollbackStatus'), rollbackList = find('#memoryRollbackList');
    const rollbackCreate = find('#memoryRollbackCreate'), rollbackLabel = find('#memoryRollbackLabel');
    let healthVersion = 0, healthCursor = null, healthPending = false;
    let rollbackVersion = 0, rollbackCurrent = null, rollbackBusy = false, rollbackRows = [];
    const healthReason = reason => ({ stale: 'Recheck date passed', disputed: 'Unresolved fact',
      'recorded-conflict': 'Recorded contradiction', 'suspicious-content': 'Content needs inspection',
      'unconfirmed-anchor': 'Identity fact not confirmed', 'inactive-anchor': 'Identity fact no longer current',
      'invalid-provenance': 'Note history needs inspection' })[reason] || 'Needs review';
    function renderHealth(report) {
      if (!healthStatus) return;
      healthCursor = report?.nextCursor || null;
      healthMore?.classList.toggle('hidden', !healthCursor);
      if (!report) { healthStatus.textContent = 'Checks saved facts and notes without changing them. No automatic check recorded yet.'; if (healthIssues) healthIssues.innerHTML = ''; return; }
      const issues = Array.isArray(report.issues) ? report.issues : [];
      healthStatus.textContent = `${report.scanned} of ${report.total} saved items checked. ${report.incomplete ? 'This is a partial scan. ' : ''}${report.anchors?.status === 'not-configured' ? 'No pinned identity facts yet. ' : ''}${report.anchors?.changed ? 'Pinned identity facts changed since the previous check. ' : ''}${issues.length ? 'Review the flagged items below.' : 'No known consistency warning in these checked items.'} This checks recorded claims, not whether they are true.`;
      if (healthIssues) healthIssues.innerHTML = issues.map(issue => `<p><button class="text-button" type="button" data-memory-health-id="${escape(issue.memoryId)}" data-memory-health-store="${issue.store === 'notes' ? 'notes' : 'facts'}">Review ${issue.store === 'notes' ? 'note' : 'fact'}</button> ${escape((issue.reasons || []).map(healthReason).join(' · '))}</p>`).join('') +
        (report.omittedIssues ? `<p>${escape(report.omittedIssues)} more flagged items; use targeted recall or continue the scan.</p>` : '');
    }
    function renderRollback(rows = []) {
      if (!rollbackList) return;
      rollbackRows = rows;
      rollbackList.innerHTML = rows.map(item => `<article class="memory-recall-card" data-memory-checkpoint="${escape(item.id)}">
        <header><strong>${escape(item.label || 'Saved memory checkpoint')}</strong><span>${item.available ? `History position ${escape(item.sequence)}` : 'Earlier memory identity'}</span></header>
        <p>${escape(formatTime(item.createdAt))}${item.available ? '' : ` · ${escape(item.unavailableReason || 'Not available for this agent identity')}`}</p>
        <div class="memory-recall-actions">${item.available ? `<button class="secondary-button" type="button" data-memory-checkpoint-restore="${escape(item.id)}" ${rollbackBusy || (Number(rollbackCurrent?.sequence) <= Number(item.sequence)) ? 'disabled' : ''}>Restore</button>` : ''}<button class="text-button" type="button" data-memory-checkpoint-delete="${escape(item.id)}" ${rollbackBusy ? 'disabled' : ''}>Delete checkpoint</button></div>
      </article>`).join('') || '<div class="empty-state"><strong>No saved checkpoints</strong><p>Save one before a large memory change if you may want to return to this point.</p></div>';
    }
    async function refreshRollback(agentId = picker?.value || '') {
      if (!rollbackPanel || !rollbackStatus || !rollbackList) return;
      const version = ++rollbackVersion;
      if (!ask || !isFacts()) { rollbackPanel.classList.add('hidden'); return; }
      rollbackPanel.classList.remove('hidden');
      rollbackCurrent = null;
      if (!agentId) { rollbackStatus.textContent = 'Choose an agent to see saved checkpoints.'; rollbackList.innerHTML = ''; if (rollbackCreate) rollbackCreate.disabled = true; return; }
      if (rollbackCreate) rollbackCreate.disabled = true;
      rollbackStatus.textContent = 'Loading saved checkpoints…';
      try {
        const result = await request(`/api/agents/${encodeURIComponent(agentId)}/memory-rollback-checkpoints`);
        if (version !== rollbackVersion || picker.value !== agentId || !isFacts()) return;
        rollbackCurrent = result.current || null;
        const rows = Array.isArray(result.checkpoints) ? result.checkpoints : [];
        renderRollback(rows);
        rollbackStatus.textContent = rows.length ? `${rows.length} saved checkpoint${rows.length === 1 ? '' : 's'}. Restore adds revisions to the existing history.` : 'No checkpoints saved yet.';
        if (rollbackCreate) rollbackCreate.disabled = rollbackBusy || !agentId;
      } catch (error) {
        if (version !== rollbackVersion || picker.value !== agentId) return;
        rollbackCurrent = null; rollbackList.innerHTML = '';
        rollbackStatus.textContent = `Checkpoints could not be loaded: ${error.message || 'request failed'}. Refresh to retry.`;
      } finally { if (version === rollbackVersion && rollbackCreate) rollbackCreate.disabled = rollbackBusy || !picker.value; }
    }
    if (rollbackCreate) rollbackCreate.addEventListener('click', async () => {
      const agentId = picker.value;
      if (rollbackBusy || !agentId || !ask || !isFacts()) return;
      rollbackBusy = true; rollbackCreate.disabled = true; rollbackStatus.textContent = 'Saving a checkpoint…';
      try {
        const result = await request(`/api/agents/${encodeURIComponent(agentId)}/memory-rollback-checkpoints`, {
          method: 'POST', body: JSON.stringify({ label: rollbackLabel?.value.trim() || '', approved: true })
        });
        if (picker.value !== agentId) return;
        if (rollbackLabel) rollbackLabel.value = '';
        rollbackStatus.textContent = 'Checkpoint saved. Your memory history was not changed.';
        await refreshRollback(agentId);
      } catch (error) { if (picker.value === agentId) rollbackStatus.textContent = `Checkpoint was not saved: ${error.message || 'request failed'}.`; }
      finally { rollbackBusy = false; if (rollbackCreate) rollbackCreate.disabled = !picker.value; renderRollback(rollbackRows); }
    });
    if (rollbackList) rollbackList.addEventListener('click', async (event) => {
      const restoreButton = event.target?.closest('[data-memory-checkpoint-restore]');
      const deleteButton = event.target?.closest('[data-memory-checkpoint-delete]');
      const checkpointId = restoreButton?.dataset.memoryCheckpointRestore || deleteButton?.dataset.memoryCheckpointDelete;
      const agentId = picker.value;
      if (!checkpointId || !agentId || rollbackBusy || !ask) return;
      rollbackBusy = true; renderRollback(rollbackRows); rollbackStatus.textContent = restoreButton ? 'Checking the current memory point…' : 'Removing the selected checkpoint…';
      try {
        if (restoreButton) {
          const latest = await request(`/api/agents/${encodeURIComponent(agentId)}/memory-rollback-checkpoints`);
          if (picker.value !== agentId) return;
          rollbackCurrent = latest.current || null;
          const saved = (latest.checkpoints || []).find(item => item.id === checkpointId && item.available);
          if (!saved || !rollbackCurrent) throw new Error('This checkpoint is no longer available. Refresh the list.');
          const confirmed = await ask({ title: 'Restore this memory checkpoint?',
            message: 'HexiGrid will add revisions that return eligible facts to this saved point. Newer facts become historical, rejected facts stay rejected, and permanently deleted facts cannot be recovered.',
            accept: 'Restore memory', danger: true });
          if (!confirmed || picker.value !== agentId) { rollbackStatus.textContent = 'Restore cancelled. Memory was not changed.'; return; }
          const result = await request(`/api/agents/${encodeURIComponent(agentId)}/memory-rollback-checkpoints/${encodeURIComponent(checkpointId)}/restore`, {
            method: 'POST', body: JSON.stringify({ approved: true, expectedCurrent: rollbackCurrent, why: 'Owner restored a saved memory checkpoint.' })
          });
          if (picker.value !== agentId) return;
          await refresh({ more: false });
          rollbackStatus.textContent = result.restored ? `Memory restored with ${result.changedRecords} history-preserving revision${result.changedRecords === 1 ? '' : 's'}.` : 'Memory already matched this checkpoint; nothing changed.';
          return;
        }
        const confirmed = await ask({ title: 'Delete this checkpoint?', message: 'This removes only the selected restore point. It does not delete or change memory history.', accept: 'Delete checkpoint', danger: true });
        if (!confirmed || picker.value !== agentId) { rollbackStatus.textContent = 'Checkpoint kept.'; return; }
        await request(`/api/agents/${encodeURIComponent(agentId)}/memory-rollback-checkpoints/${encodeURIComponent(checkpointId)}`, {
          method: 'DELETE', body: JSON.stringify({ approved: true })
        });
        if (picker.value !== agentId) return;
        rollbackStatus.textContent = 'Checkpoint deleted. Memory history was not changed.';
        await refreshRollback(agentId);
      } catch (error) {
        if (picker.value === agentId) { rollbackStatus.textContent = `Checkpoint action did not finish: ${error.message || 'request failed'}. Refresh before retrying.`; await refreshRollback(agentId); }
      } finally { rollbackBusy = false; if (rollbackCreate) rollbackCreate.disabled = !picker.value; renderRollback(rollbackRows); }
    });
    async function checkHealth(more = false) {
      if (healthPending || !picker.value || !healthStatus) return;
      const agentId = picker.value, version = healthVersion;
      healthPending = true;
      if (healthCheck) healthCheck.disabled = true;
      if (healthMore) healthMore.disabled = true;
      healthStatus.textContent = 'Checking saved memory locally…';
      try {
        const report = await request(`/api/agents/${encodeURIComponent(agentId)}/memory-health${more && healthCursor ? `?after=${encodeURIComponent(healthCursor)}` : ''}`);
        if (version === healthVersion && picker.value === agentId) renderHealth(report);
      } catch (error) {
        if (version === healthVersion && picker.value === agentId) {
          healthStatus.textContent = `The check could not finish: ${error.message || 'request failed'}. Existing memories were preserved.`;
          if (healthIssues) healthIssues.innerHTML = '';
          healthCursor = null;
          healthMore?.classList.add('hidden');
        }
      } finally {
        healthPending = false;
        if (healthCheck) healthCheck.disabled = !picker.value;
        if (healthMore) healthMore.disabled = false;
      }
    }
    healthCheck?.addEventListener('click', () => { void checkHealth(); });
    healthMore?.addEventListener('click', () => { void checkHealth(true); });
    healthIssues?.addEventListener('click', event => {
      const button = event.target.closest('[data-memory-health-id]');
      const id = button?.dataset.memoryHealthId;
      if (!id) return;
      find('#memoryRecallStore').value = button.dataset.memoryHealthStore === 'notes' ? 'notes' : 'facts';
      configureStoreControls();
      setKindOptions('all');
      if (categoryFilter.select) categoryFilter.select.value = '';
      if (scopeFilter.select) scopeFilter.select.value = '';
      find('#memoryRecallStanding').value = 'all';
      find('#memoryRecallQuery').value = id;
      void refresh();
    });
    let notes = [], visible = 30, generation = 0, loading = false, failed = false, nextCursor = null, total = 0, searchTimer;
    let activeAgentId = '', disputedCount = 0, truncatedCategoryFacets = false, truncatedScopeFacets = false;
    const skillDrafts = new Map();
    let skillQuarantines = [], skillQuarantineError = '', skillQuarantineLoading = false;
    const skillQuarantineBusy = new Set();
    const skillQuarantineSection = find('#skillQuarantineReview');
    const skillQuarantineStatus = find('#skillQuarantineStatus');
    const skillQuarantineList = find('#skillQuarantineList');
    const factDrafts = new Map();
    let factActionBusy = false;
    let ownerMemoryReconfirmBusy = false;
    let ownerMemoryRetireBusy = false;
    const factToolbar = find('.memory-recall-meta');
    const createFactButton = find('#memoryRecallCreateFact') || (() => {
      if (!root.ownerDocument?.createElement || !factToolbar) return { disabled: true, classList: { toggle() {} }, addEventListener() {} };
      const button = root.ownerDocument.createElement('button');
      button.id = 'memoryRecallCreateFact';
      button.type = 'button';
      button.className = 'secondary-button hidden';
      button.textContent = 'New fact';
      factToolbar.appendChild(button);
      return button;
    })();
    const reviewDisputedButton = find('#memoryRecallReviewDisputed') || (() => {
      if (!root.ownerDocument?.createElement || !factToolbar) return { disabled: true, classList: { toggle() {} }, addEventListener() {} };
      const button = root.ownerDocument.createElement('button');
      button.id = 'memoryRecallReviewDisputed';
      button.type = 'button';
      button.className = 'text-button hidden';
      button.textContent = 'Review disputed (0)';
      factToolbar.appendChild(button);
      return button;
    })();
    const factFilterControls = root.querySelector('.memory-recall-controls');
    function ensureFactFilter(id, labelText, ariaLabel) {
      let select = find(`#${id}`);
      let labelNode = select?.closest?.('label');
      if (!select && factFilterControls && root.ownerDocument?.createElement) {
        labelNode = root.ownerDocument.createElement('label');
        labelNode.textContent = labelText;
        select = root.ownerDocument.createElement('select');
        select.id = id;
        select.setAttribute('aria-label', ariaLabel);
        labelNode.appendChild(select);
        factFilterControls.appendChild(labelNode);
      }
      return { select, labelNode };
    }
    const categoryFilter = ensureFactFilter('memoryRecallCategory', 'Category', 'Fact category');
    const scopeFilter = ensureFactFilter('memoryRecallScope', 'Scope', 'Fact scope');
    const kindFilter = ensureFactFilter('memoryRecallKind', 'Record kind', 'Fact kind');
    const isFacts = () => find('#memoryRecallStore')?.value === 'facts';
    const isSkills = () => find('#memoryRecallStore')?.value === 'skills';
    function setKindOptions(selected = 'all') {
      if (!kindFilter.select) return;
      kindFilter.select.replaceChildren();
      for (const [value, text] of [['all', 'All facts'], ['mistakes', 'Past mistakes']]) {
        const option = root.ownerDocument.createElement('option');
        option.value = value;
        option.textContent = text;
        kindFilter.select.appendChild(option);
      }
      kindFilter.select.value = selected === 'mistakes' ? 'mistakes' : 'all';
    }
    setKindOptions();
    const selectedKind = () => kindFilter.select?.value === 'mistakes' ? 'mistakes' : 'all';
    const formatTime = (value) => Number.isFinite(Date.parse(value || '')) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Time not recorded';
    const changeLabel = (key) => ({ content: 'Text', status: 'Standing', valid_while: 'Valid while', verify_by: 'Recheck by', evidence_excerpt: 'Evidence excerpt' })[key] || key.replaceAll('_', ' ');
    const changeText = (value) => value && typeof value === 'object' ? 'from' in value && 'to' in value ? `${value.from ?? '(empty)'} → ${value.to ?? '(empty)'}` : value.changed === true ? 'Changed; choose evidence detail to read it.' : JSON.stringify(value) : value;
    const utf8ByteLength = (text) => {
      let bytes = 0;
      for (const character of text) {
        const point = character.codePointAt(0);
        bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      }
      return bytes;
    };
    const factCategory = (fact) => {
      const value = fact?.metadata?.category;
      if (typeof value !== 'string') return 'General';
      const selected = value.trim();
      return selected && utf8ByteLength(selected) <= 160 ? selected : 'General';
    };
    function memoryMistakeRecord(fact) {
      const wrapper = fact?.metadata?.memoryMistake;
      const record = wrapper?.record;
      const idPattern = /^mistake-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
      if (!wrapper || wrapper.format !== 'hexigrid-memory-mistake' || wrapper.version !== 1 ||
        !record || typeof record !== 'object' || Array.isArray(record) ||
        record.format !== 'hexigrid-memory-mistake' || record.version !== 1 ||
        typeof record.id !== 'string' || typeof record.agentId !== 'string' || typeof record.lineageId !== 'string' ||
        typeof fact?.id !== 'string' || typeof fact.agentId !== 'string' || typeof fact.lineageId !== 'string' ||
        !['whatWentWrong', 'correction', 'resultingFix'].every(field => typeof record[field] === 'string') ||
        !record.author || typeof record.author !== 'object' ||
        typeof record.author.kind !== 'string' || typeof record.author.id !== 'string' ||
        !record.evidence || typeof record.evidence !== 'object' ||
        typeof record.evidence.kind !== 'string' || typeof record.evidence.id !== 'string' ||
        typeof record.evidence.observedAt !== 'string' || !Array.isArray(record.recurrenceOf)) return null;
      const idMatch = record.id.match(idPattern);
      if (!idMatch || fact.id.toLowerCase() !== `memory-${idMatch[1]}`.toLowerCase() ||
        fact.agentId !== record.agentId || fact.lineageId.toLowerCase() !== record.lineageId.toLowerCase()) return null;
      const sameScope = (left, right) => {
        if (left == null || right == null) return left == null && right == null;
        return typeof left === 'object' && !Array.isArray(left) && typeof right === 'object' && !Array.isArray(right) &&
          left.projectId === right.projectId && (left.topicId || '') === (right.topicId || '');
      };
      return sameScope(fact.contextScope, record.contextScope) ? record : null;
    }
    const factScopeLabel = (fact) => fact.contextScope ? [fact.contextScope.projectId, fact.contextScope.topicId].filter(Boolean).join(' / ') : 'Unscoped';
    const factOriginLabel = (fact) => {
      switch (fact.originKind) {
        case 'owner-entry': return 'Entered by owner';
        case 'agent-proposal': return 'Agent proposal';
        case 'automatic-learning': return 'Automatic learning';
        default: return 'Origin not recorded';
      }
    };
    function setFilterOptions(select, defaultLabel, entries, selected) {
      if (!select) return;
      select.replaceChildren();
      const add = (value, text) => {
        const option = root.ownerDocument.createElement('option');
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
      };
      add('', defaultLabel);
      if (selected && !entries.some(([value]) => value === selected)) entries = [[selected, selected], ...entries];
      for (const [value, text] of entries) add(value, text);
      select.value = entries.some(([value]) => value === selected) ? selected : '';
    }
    function refreshFactFilterOptions(facets = {}) {
      const categories = Array.isArray(facets.categories)
        ? [...new Set(facets.categories.filter(value => typeof value === 'string' && value.trim()))].sort((a, b) => a.localeCompare(b)) : [];
      const scopes = Array.isArray(facets.scopes)
        ? facets.scopes.filter(item => item && typeof item.value === 'string' && typeof item.label === 'string')
          .map(item => [item.value, item.label]) : [];
      setFilterOptions(categoryFilter.select, 'All categories', categories.map(value => [value, value]), categoryFilter.select?.value || '');
      setFilterOptions(scopeFilter.select, 'All scopes', scopes, scopeFilter.select?.value || '');
      truncatedCategoryFacets = facets.truncated?.categories === true;
      truncatedScopeFacets = facets.truncated?.scopes === true;
    }
    function syncFactControls() {
      find('#memoryRecallDepth').disabled = isSkills() || (!isFacts() && find('#memoryRecallStanding').value === 'inactive');
      createFactButton.classList.toggle('hidden', !isFacts() || !ask || !picker.value);
      createFactButton.disabled = factActionBusy || !isFacts() || !ask || !picker.value;
      reviewDisputedButton.textContent = `Review disputed (${disputedCount})`;
      reviewDisputedButton.classList.toggle('hidden', !isFacts() || disputedCount < 1);
      reviewDisputedButton.disabled = loading || !isFacts() || disputedCount < 1;
      categoryFilter.labelNode?.classList.toggle('hidden', !isFacts());
      scopeFilter.labelNode?.classList.toggle('hidden', !isFacts());
      kindFilter.labelNode?.classList.toggle('hidden', !isFacts());
    }
    function renderSkillQuarantines() {
      if (!skillQuarantineSection) return;
      const visible = Boolean(ask) && isSkills();
      skillQuarantineSection.classList.toggle('hidden', !visible);
      if (!visible || !skillQuarantineStatus || !skillQuarantineList) return;
      if (!picker.value) {
        skillQuarantineStatus.textContent = 'Choose an agent to review pending skill drafts.';
        skillQuarantineList.innerHTML = '';
        return;
      }
      if (skillQuarantineLoading) {
        skillQuarantineStatus.textContent = 'Loading pending skill drafts…';
        skillQuarantineList.innerHTML = '';
        return;
      }
      if (skillQuarantineError) {
        skillQuarantineStatus.textContent = `Pending skill drafts could not be loaded: ${skillQuarantineError}. Refresh to retry.`;
        skillQuarantineList.innerHTML = '';
        return;
      }
      if (!skillQuarantines.length) {
        skillQuarantineStatus.textContent = 'No pending skill drafts for this agent.';
        skillQuarantineList.innerHTML = '<div class="empty-state"><strong>No pending skill drafts</strong><p>New drafts held for owner review will appear here.</p></div>';
        return;
      }
      const selectedAgent = agents().find(agent => agent.id === picker.value);
      skillQuarantineStatus.textContent = `${skillQuarantines.length} pending skill draft${skillQuarantines.length === 1 ? '' : 's'} for ${escape(label(selectedAgent || { name: 'selected agent' }))}.`;
      skillQuarantineList.innerHTML = skillQuarantines.map(item => {
        const intent = item.intent || {}, draft = item.draft || {};
        const operation = intent.operation === 'revise'
          ? `Revision request for ${escape(intent.skillId || 'an existing skill')} · expected version ${escape(intent.expectedRevision ?? 'unknown')}`
          : 'New skill draft';
        const reasons = (Array.isArray(item.riskReasonCodes) ? item.riskReasonCodes : []).map(memoryRiskReasonLabel).map(escape).join('; ');
        const id = escape(item.id);
        return `<article class="memory-recall-card" data-skill-quarantine-card="${id}">
          <header><strong>${escape(draft.name || 'Untitled skill draft')}</strong><span class="memory-standing">Pending review</span></header>
          <p><strong>Agent:</strong> ${escape(label(selectedAgent || { name: 'Selected agent' }))}</p>
          <p><strong>Source:</strong> Link <code>${escape(item.linkId || 'unknown')}</code> · ${escape(formatTime(item.createdAt))}</p>
          <p><strong>Request:</strong> ${operation}</p>
          <p><strong>Agent reason:</strong> ${escape(intent.why || 'No reason supplied')}</p>
          <p><strong>Review flags:</strong> ${reasons || 'Requires inspection'}</p>
          <p><strong>Requested standing:</strong> ${escape(draft.status || 'active')}</p>
          <p><strong>Use when:</strong> ${escape(draft.whenToUse)}</p>
          <p><strong>Procedure:</strong></p><pre>${escape(draft.procedure)}</pre>
          <p><strong>Success check:</strong> ${escape(draft.successCheck)}</p>
          <div class="memory-review-actions"><input type="text" maxlength="500" required data-skill-quarantine-reason="${id}" aria-label="Reason to reject skill draft ${id}" placeholder="Reason to reject"><button class="secondary-button" type="button" data-skill-quarantine-reject="${id}" ${skillQuarantineBusy.has(item.id) ? 'disabled' : ''}>Reject draft</button></div>
          <p role="status" data-skill-quarantine-feedback="${id}"></p>
        </article>`;
      }).join('');
    }
    async function loadSkillQuarantines(agentId, ownGeneration) {
      skillQuarantineLoading = true;
      skillQuarantineError = '';
      renderSkillQuarantines();
      try {
        const response = await request(`/api/agents/${encodeURIComponent(agentId)}/skill-quarantines`);
        if (ownGeneration !== generation || picker.value !== agentId || !isSkills()) return;
        skillQuarantines = (Array.isArray(response.drafts) ? response.drafts : []).filter(item => item?.status === 'pending');
      } catch (error) {
        if (ownGeneration !== generation || picker.value !== agentId || !isSkills()) return;
        skillQuarantines = [];
        skillQuarantineError = error.message || 'request failed';
      } finally {
        if (ownGeneration === generation && picker.value === agentId && isSkills()) {
          skillQuarantineLoading = false;
          renderSkillQuarantines();
        }
      }
    }
    function render() {
      if (loading || failed) return;
      syncFactControls();
      find('#memoryRecallQuery').placeholder = isSkills() ? 'Find a skill, procedure or success check' : isFacts() ? selectedKind() === 'mistakes' ? 'Find a past mistake or correction' : 'Find a fact, project or condition' : 'Find a note, category or condition';
      const query = find('#memoryRecallQuery').value.trim().toLowerCase();
      const standing = find('#memoryRecallStanding').value;
      const depth = Number(find('#memoryRecallDepth').value);
      if (isSkills()) {
        const matches = notes.filter(skill => (standing === 'all' || skill.status === standing) && [skill.name, skill.whenToUse, skill.procedure, skill.successCheck, skill.id].some(value => String(value || '').toLowerCase().includes(query)));
        status.textContent = !picker.value ? 'Add an agent to begin.' : `${matches.length} matching skills from ${notes.length} loaded. ${nextCursor ? 'Load more to search the remaining skills.' : 'All skills in this standing loaded.'}`;
        const describe = skill => `<p><b>Use when:</b> ${escape(skill.whenToUse)}</p><p class="memory-fact-text">${escape(skill.procedure)}</p><p><b>Success check:</b> ${escape(skill.successCheck)}</p>`;
        list.innerHTML = matches.map(skill => `<article class="memory-recall-card"><header><strong>${escape(skill.name)}</strong><span class="memory-standing">${escape(skill.status)} · version ${escape(skill.revision)}</span></header>${describe(skill)}<footer><span>${escape(formatTime(skill.updatedAt))}</span><code>${escape(skill.id)}</code></footer>
          <p>Provenance: ${escape(skill.provenance || 'legacy-or-unspecified')} · Verification: ${escape(skill.verification || 'unverified')}</p>${skill.warning ? `<div class="warning-callout" role="note"><strong>Skill trust warning</strong><p>${escape(skill.warning)}</p></div>` : ''}
          ${skill.history ? `<details class="memory-recall-history" open><summary>Version history (${escape(skill.history.length)} loaded)</summary>${skill.history.map(revision => `<section><strong>Version ${escape(revision.revision)} · ${escape(formatTime(revision.at))}</strong><p>${escape(revision.why)} · ${escape(revision.by)}</p><p>Provenance: ${escape(revision.provenance || 'legacy-or-unspecified')} · Verification: ${escape(revision.verification || 'unverified')}</p>${revision.warning ? `<div class="warning-callout" role="note"><strong>Version trust warning</strong><p>${escape(revision.warning)}</p></div>` : ''}<b>${escape(revision.name)} · ${escape(revision.status)}</b>${describe(revision)}</section>`).join('')}</details>` : ''}
          ${!skill.history || skill.nextBefore ? `<button class="secondary-button" data-skill-history="${escape(skill.id)}" ${skill.nextBefore ? `data-before-revision="${skill.nextBefore}"` : ''}>${skill.history ? 'Load older versions' : 'Read version history'}</button>` : ''}${ask ? `<button class="secondary-button" data-skill-edit="${escape(skill.id)}">Edit skill</button>${skill.status === 'quarantined' ? '' : `<button class="text-button" data-skill-standing="${escape(skill.id)}">${skill.status === 'active' ? 'Retire skill' : 'Restore skill'}</button>`}` : ''}<p role="status" data-skill-history-status="${escape(skill.id)}"></p></article>`).join('') || '<div class="empty-state"><strong>No matching agent skills</strong><p>Try another search, agent or standing, or choose another Store. Skills are versioned procedures, separate from memory facts.</p></div>';
        find('#memoryRecallMore').classList.toggle('hidden', !nextCursor);
        return;
      }
      const matches = isFacts() ? notes
        : notes.filter((note) => (standing === 'inactive' ? note.inactiveIndex === true : standing === 'all' || note.status === standing) && (note.inactiveIndex === true || [note.content, note.category, note.valid_while, note.id].some((value) => String(value || '').toLowerCase().includes(query))));
      const facetHints = [
        ...(truncatedCategoryFacets ? ['Some categories are omitted; narrow the search to see more.'] : []),
        ...(truncatedScopeFacets ? ['Some scopes are omitted; narrow the search to see more.'] : [])
      ].join(' ');
      const factResultLabel = selectedKind() === 'mistakes' ? 'past mistakes' : 'dated facts';
      status.textContent = !picker.value ? 'Add an agent to begin.' : isFacts()
        ? `Showing ${Math.min(visible, matches.length)} of ${total} matching ${factResultLabel}. ${nextCursor ? 'Load more results to continue.' : 'All matching results loaded.'} Search stays on this device.${facetHints ? ` ${facetHints}` : ''}`
        : standing === 'inactive' ? `Showing ${Math.min(visible, matches.length)} of ${total} inactive note IDs. ${nextCursor ? '' : total > notes.length ? 'Only the first 100 are listed; narrow the search.' : 'All matching IDs loaded.'} Excluded from current recall; use the human agent profile to review retained text/history.` : `Showing ${Math.min(visible, matches.length)} of ${matches.length} matching notes. Search stays on this device.`;
      const emptyState = isFacts()
        ? selectedKind() === 'mistakes'
          ? ['No matching past mistakes', 'Try another search, category, scope or standing, or choose All facts in Record kind.']
          : ['No matching dated facts', 'Try another search, agent, category, scope or standing, or change Record kind.']
        : standing === 'inactive'
          ? ['No inactive note IDs match', 'Search retained text, category, condition or ID, or choose Active + conditional.']
          : notes.length
          ? ['No matching owner notes', 'Try another search, agent or standing, or choose another Store.']
          : ['No owner notes for this agent and standing', 'Choose another agent or standing, or switch Store to browse facts or learned skills.'];
      list.innerHTML = matches.slice(0, visible).map((note) => {
        const mistake = isFacts() ? memoryMistakeRecord(note) : null;
        const recurrenceIds = mistake?.recurrenceOf.filter(reference => reference && typeof reference.id === 'string').map(reference => reference.id) || [];
        const body = mistake ? `<div class="memory-mistake-fields">
          <p class="memory-fact-text"><strong>What went wrong</strong><br>${escape(mistake.whatWentWrong)}</p>
          <p class="memory-fact-text"><strong>Correction</strong><br>${escape(mistake.correction)}</p>
          <p class="memory-fact-text"><strong>Resulting fix</strong><br>${escape(mistake.resultingFix)}</p>
          <p class="memory-condition"><strong>Evidence source</strong> ${escape(mistake.evidence.kind)} · <code>${escape(mistake.evidence.id)}</code> · observed ${escape(formatTime(mistake.evidence.observedAt))}</p>
          <p class="memory-condition"><strong>Provenance</strong> ${escape(mistake.author.kind)} · ${escape(mistake.author.id)} · recorded ${escape(formatTime(mistake.createdAt))}</p>
          ${recurrenceIds.length ? `<p class="memory-condition"><strong>Recurring from</strong> ${recurrenceIds.map(id => `<code>${escape(id)}</code>`).join(', ')}</p>` : ''}
        </div>` : note.inactiveIndex ? '<p class="memory-condition memory-stale"><strong>Inactive note</strong> · Historical context, excluded from current recall. Use the human agent profile to review retained text and history; signed agents can use get-owner-note-history.</p>' : `<p class="memory-fact-text">${escape(note.content)}</p>`;
        const headerStatus = mistake || note.inactiveIndex
          ? `${escape(note.status || 'historical')} · revision ${escape(note.inactiveIndex ? note.revision_count ?? 0 : note.revision ?? 0)}`
          : `${escape(note.status || 'active')} · ${note.verification === 'owner-confirmed' ? 'Owner-confirmed' : 'Unverified'}`;
        const recordId = mistake?.id || note.id;
        const evidenceExcerpt = depth >= 2 ? note.evidence_excerpt || mistake?.evidence?.excerpt || '' : '';
        const canReconfirmOwnerNote = !isFacts() && !isSkills() && ask && note.verification === 'owner-confirmed' &&
          note.stale === true && ['active', 'conditional'].includes(note.status);
        return `<article class="memory-recall-card">
        <header><strong>${mistake ? 'Past mistake' : escape(note.category || 'Context')}</strong><span class="memory-standing">${headerStatus}</span></header>
        ${body}
        ${isFacts() ? `<p class="memory-condition"><strong>Scope</strong> ${escape(factScopeLabel(note))}${mistake ? '' : ` · <strong>Origin</strong> ${escape(factOriginLabel(note))}`}</p>` : ''}
        ${note.valid_while ? `<p class="memory-condition"><strong>Valid while</strong> ${escape(note.valid_while)}</p>` : ''}
        ${note.conflictCount ? `<p class="memory-condition memory-stale"><strong>Conflicts recorded:</strong> ${escape(note.conflictCount)}. Choose Facts + history + evidence to review the links below before relying on this fact.</p>` : ''}
        ${isFacts() && depth >= 1 && note.conflicts?.length ? `<details class="memory-recall-evidence"><summary>Conflict links (${escape(note.conflictCount || note.conflicts.length)})</summary>${note.conflicts.slice(0, 20).map(link => `<div class="memory-condition"><p><strong>${escape(link.relation)}</strong> · linked fact <code>${escape(link.otherId)}</code></p><p>Reason: ${escape(link.why || 'No reason retained.')}</p>${depth >= 2 ? `<blockquote>${escape(link.evidence?.text || 'No conflict evidence excerpt retained.')}</blockquote>` : '<p>Choose Facts + history + evidence for the source excerpt.</p>'}</div>`).join('')}${note.conflicts.length > 20 ? `<p>${escape(note.conflicts.length - 20)} more links. Read this exact fact at depth 2 through the memory API for the complete link history.</p>` : ''}</details>` : ''}
        ${note.verify_by ? `<p class="memory-condition ${note.stale ? 'memory-stale' : ''}"><strong>Recheck by</strong> ${escape(note.verify_by)}${note.stale ? ' · Re-verify before acting' : ''}</p>` : ''}
        ${note.stale && !note.verify_by ? '<p class="memory-condition memory-stale"><strong>Recheck needed</strong> · Category lifetime passed. Verify this memory before relying on it.</p>' : ''}
        <footer><span>${escape(formatTime(note.updatedAt || note.createdAt || mistake?.createdAt))}</span><code>${escape(recordId)}</code></footer>
        ${depth >= 1 && !note.inactiveIndex ? `<details class="memory-recall-history"><summary>Revision history (${escape(note.revision_count ?? note.revisions?.length ?? 0)})${note.revisions_truncated ? ' · recent revisions only' : ''}</summary>${(note.revisions || []).map((revision) => `<section><strong>${escape(formatTime(revision.at || revision.createdAt))}</strong><p>${escape(revision.why || 'Reason not recorded')} · ${escape(revision.by || 'Author not recorded')}</p>${Object.entries(revision.changes || {}).filter(([key]) => key !== 'source').map(([key, value]) => `<p><b>${escape(changeLabel(key))}:</b> ${escape(changeText(value))}</p>`).join('')}</section>`).join('') || '<p>No revisions recorded.</p>'}</details>` : ''}
        ${depth >= 2 && (isFacts() || note.evidence_excerpt) ? `<details class="memory-recall-evidence"><summary>Source evidence</summary>${evidenceExcerpt ? `<blockquote>${escape(evidenceExcerpt)}</blockquote>` : '<p>No evidence excerpt recorded.</p>'}</details>` : ''}
        ${canReconfirmOwnerNote ? `<div class="memory-recall-actions"><button class="secondary-button" type="button" data-owner-memory-reconfirm="${escape(note.id)}" ${ownerMemoryReconfirmBusy ? 'disabled' : ''}>Recheck &amp; confirm</button></div>` : ''}
        ${ask && !isFacts() && !isSkills() && ['active', 'conditional'].includes(note.status) ? `<div class="memory-recall-actions"><button class="text-button" type="button" data-owner-memory-retire="${escape(note.id)}" ${ownerMemoryRetireBusy ? 'disabled' : ''}>Retire note</button></div>` : ''}
        ${ask && isFacts() ? `<div class="memory-recall-actions">${mistake ? '' : `<button class="secondary-button" type="button" data-fact-edit="${escape(note.id)}" ${factActionBusy ? 'disabled' : ''}>Edit fact</button>`}${!mistake && (note.status === 'disputed' || note.conflictCount) ? `<button class="secondary-button" type="button" data-fact-review="${escape(note.id)}" ${factActionBusy ? 'disabled' : ''}>Review standing</button>` : ''}${!mistake && note.conflictCount && ['active', 'conditional'].includes(note.status) ? `<button class="secondary-button" type="button" data-fact-supersede="${escape(note.id)}" ${factActionBusy ? 'disabled' : ''}>Replace older fact</button>` : ''}${note.status === 'rejected' ? '' : `<button class="text-button" type="button" data-fact-reject="${escape(note.id)}" ${factActionBusy ? 'disabled' : ''}>${mistake ? 'Reject record' : 'Reject from recall'}</button>`}</div><p role="status" data-fact-action-status="${escape(note.id)}"></p>` : ''}
      </article>`;
      }).join('') || `<div class="empty-state"><strong>${emptyState[0]}</strong><p>${emptyState[1]}</p></div>`;
      find('#memoryRecallMore').classList.toggle('hidden', matches.length <= visible && !nextCursor);
    }
    async function refresh({ more = false } = {}) {
      clearTimeout(searchTimer);
      const prior = picker.value;
      picker.innerHTML = agents().map((agent) => `<option value="${escape(agent.id)}">${escape(label(agent))}</option>`).join('');
      if (agents().some((agent) => agent.id === prior)) picker.value = prior;
      const agentId = picker.value;
      if (agentId !== activeAgentId) {
        healthVersion++;
        renderHealth(healthReports().find(report => report.agentId === agentId));
        if (healthCheck) healthCheck.disabled = !agentId || healthPending;
        activeAgentId = agentId;
        disputedCount = 0;
        truncatedCategoryFacets = false;
        truncatedScopeFacets = false;
        setKindOptions('all');
        setFilterOptions(categoryFilter.select, 'All categories', [], '');
        setFilterOptions(scopeFilter.select, 'All scopes', [], '');
      }
      const ownGeneration = ++generation;
      if (!more) void refreshRollback(agentId);
      if (!more) { notes = []; visible = 30; nextCursor = null; }
      failed = false;
      find('#memoryRecallProfile').disabled = !agentId;
      find('#memoryRecallMore').classList.add('hidden');
      if (!agentId) { loading = false; render(); renderSkillQuarantines(); return; }
      loading = true; status.textContent = 'Reading private local memory…'; if (!more) list.innerHTML = '';
      syncFactControls();
      find('#memoryRecallRefresh').disabled = true;
      try {
        const quarantineRead = isSkills() && ask ? loadSkillQuarantines(agentId, ownGeneration) : null;
        const params = new URLSearchParams({ depth: find('#memoryRecallDepth').value });
        if (isFacts()) {
          params.set('query', find('#memoryRecallQuery').value);
          params.set('kind', selectedKind());
          params.set('standing', find('#memoryRecallStanding').value);
          params.set('limit', '30');
          if (categoryFilter.select?.value) params.set('category', categoryFilter.select.value);
          if (scopeFilter.select?.value) params.set('scope', scopeFilter.select.value);
          if (more && nextCursor) params.set('after', nextCursor);
        }
        if (!isFacts() && !isSkills() && find('#memoryRecallStanding').value === 'inactive') { params.set('standing', 'inactive'); params.set('query', find('#memoryRecallQuery').value); }
        if (isSkills()) { params.delete('depth'); params.set('limit', '20'); params.set('includeRetired', find('#memoryRecallStanding').value === 'active' ? '0' : '1'); if (more && nextCursor) params.set('after', nextCursor); }
        const response = await request(`/api/agents/${encodeURIComponent(agentId)}/${isFacts() ? 'memory-facts' : isSkills() ? 'skills' : 'memories'}?${params}`);
        if (ownGeneration !== generation) return;
        if (quarantineRead) await quarantineRead;
        if (ownGeneration !== generation) return;
        const page = isFacts() ? (response.facts || []).map((fact) => ({ ...fact, content: fact.text, category: factCategory(fact) })) : isSkills() ? response.skills || [] : response.memories || [];
        notes = more ? [...new Map([...notes, ...page].map((note) => [note.id, note])).values()] : page;
        if (isFacts()) {
          refreshFactFilterOptions(response.facets || {});
          disputedCount = Number.isSafeInteger(response.disputedCount) && response.disputedCount >= 0 ? response.disputedCount : 0;
        }
        nextCursor = response.nextCursor || null; total = response.total ?? notes.length;
        if (more) visible = notes.length;
        loading = false; render();
      } catch (error) {
        if (ownGeneration !== generation) return;
        loading = false; failed = true; status.textContent = `Memory could not be read: ${error.message}. Refresh to retry.`;
      } finally { if (ownGeneration === generation) find('#memoryRecallRefresh').disabled = false; }
    }
    picker.addEventListener('change', () => { void refresh(); });
    find('#memoryRecallDepth').addEventListener('change', () => { void refresh(); });
    find('#memoryRecallQuery').addEventListener('input', () => { if (isFacts() || (!isSkills() && find('#memoryRecallStanding').value === 'inactive')) { clearTimeout(searchTimer); ++generation; list.innerHTML = ''; status.textContent = 'Searching local memory…'; searchTimer = setTimeout(() => { void refresh(); }, 300); } else { visible = 30; render(); } });
    find('#memoryRecallStanding').addEventListener('change', () => { void refresh(); });
    kindFilter.select?.addEventListener('change', () => {
      if (selectedKind() === 'mistakes') find('#memoryRecallStanding').value = 'all';
      void refresh();
    });
    categoryFilter.select?.addEventListener('change', () => { void refresh(); });
    scopeFilter.select?.addEventListener('change', () => { void refresh(); });
    reviewDisputedButton.addEventListener('click', () => {
      if (!isFacts() || reviewDisputedButton.disabled || disputedCount < 1) return;
      find('#memoryRecallQuery').value = '';
      find('#memoryRecallStanding').value = 'disputed';
      if (categoryFilter.select) categoryFilter.select.value = '';
      if (scopeFilter.select) scopeFilter.select.value = '';
      void refresh();
    });
    function configureStoreControls() {
      clearTimeout(searchTimer);
      if (!isFacts()) setKindOptions('all');
      find('#memoryRecallDepth').disabled = isSkills();
      find('#memoryRecallDepth').closest?.('label')?.classList.toggle('hidden', isSkills());
      find('#memoryRecallCreateSkill')?.classList.toggle('hidden', !isSkills() || !ask);
      renderSkillQuarantines();
      find('#memoryRecallStanding').innerHTML = isSkills() ? '<option value="active">Active skills</option><option value="all">Active + retired skills</option><option value="retired">Retired skills</option>' : isFacts() ? '<option value="current">Active + conditional</option><option value="all">All standings</option>' + ['active','conditional','superseded','disputed','rejected','historical'].map((value) => `<option value="${value}">${value}</option>`).join('') : '<option value="all">Active + conditional</option><option value="active">Active</option><option value="conditional">Conditional</option><option value="inactive">Inactive note IDs</option>';
    }
    find('#memoryRecallStore')?.addEventListener('change', () => {
      configureStoreControls();
      find('#memoryRecallQuery').value = ''; void refresh();
    });
    find('#memoryRecallRefresh').addEventListener('click', () => { void refresh(); });
    find('#memoryRecallMore').addEventListener('click', () => { if (isFacts() || isSkills()) { if (!loading) void refresh({ more: true }); } else { visible += 30; render(); } });
    function sameOwnerMemoryView(agentId, store, ownGeneration) {
      return ownGeneration === generation && picker.value === agentId && find('#memoryRecallStore')?.value === store && !isFacts() && !isSkills();
    }
    function validFutureReviewDate(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value &&
        value > new Date().toISOString().slice(0, 10);
    }
    async function retireOwnerMemory(button, selectedNote) {
      if (ownerMemoryRetireBusy || button.disabled || !ask || isFacts() || isSkills()) return;
      const agentId = picker.value, store = find('#memoryRecallStore')?.value, ownGeneration = generation;
      const target = agents().find(agent => agent.id === agentId);
      if (!target || !['active', 'conditional'].includes(selectedNote.status)) return;
      ownerMemoryRetireBusy = true; button.disabled = true;
      let feedback = '';
      try {
        status.textContent = 'Reading the current note before retirement…';
        const detail = await request(`/api/agents/${encodeURIComponent(agentId)}/memories?depth=2`);
        if (!sameOwnerMemoryView(agentId, store, ownGeneration)) return;
        const current = (detail.memories || []).find(note => note.id === selectedNote.id);
        if (!current || current.agentId !== agentId || current.status !== selectedNote.status ||
          current.content !== selectedNote.content || current.updatedAt !== selectedNote.updatedAt ||
          !Number.isInteger(current.revision_count)) {
          feedback = 'This note changed or is no longer current. Refresh and review it again.'; return;
        }
        const accepted = await ask({ title: 'Retire this owner note?',
          message: `For ${label(target)}. The note stops being used in current recall. Its history stays local; restore it from the agent profile by editing its standing.`,
          accept: 'Retire note', fields: [{ label: 'Exact note', value: current.content, multiline: true, readonly: true },
            { label: 'Validity condition', value: current.valid_while || '', multiline: true, readonly: true }] });
        if (!accepted) { feedback = 'Retirement canceled. The note is unchanged.'; return; }
        if (!sameOwnerMemoryView(agentId, store, ownGeneration)) return;
        const result = await request(`/api/memories/${encodeURIComponent(current.id)}`, {
          method: 'DELETE', body: JSON.stringify({ expectedRevision: current.revision_count }) });
        if (!sameOwnerMemoryView(agentId, store, ownGeneration)) return;
        const matched = result?.memory?.id === current.id && result.memory.agentId === agentId && result.memory.status === 'historical';
        await refresh();
        if (picker.value !== agentId || find('#memoryRecallStore')?.value !== store) return;
        feedback = matched ? failed ? 'The note was retired, but the list could not refresh. Refresh before taking another action.'
          : 'Note retired from current recall. Its history remains in the agent profile.'
          : 'The result did not match this note. Refresh to verify its current standing.';
      } catch (error) {
        if (sameOwnerMemoryView(agentId, store, ownGeneration)) feedback = `Retirement did not return a confirmed result: ${error.message}. Refresh to verify the note before retrying.`;
      } finally {
        ownerMemoryRetireBusy = false; button.disabled = false;
        render(); if (feedback) status.textContent = feedback;
      }
    }
    async function reconfirmOwnerMemory(button, selectedNote) {
      if (ownerMemoryReconfirmBusy || button.disabled || !ask || isFacts() || isSkills()) return;
      const agentId = picker.value, store = find('#memoryRecallStore')?.value, ownGeneration = generation;
      const selectedStanding = find('#memoryRecallStanding').value;
      const target = agents().find(agent => agent.id === agentId);
      if (!agentId || !target || selectedNote.verification !== 'owner-confirmed' || selectedNote.stale !== true ||
          !['active', 'conditional'].includes(selectedNote.status)) return;
      ownerMemoryReconfirmBusy = true;
      button.disabled = true;
      let feedback = '';
      try {
        status.textContent = 'Reading the current owner note before recheck…';
        const detailResponse = await request(`/api/agents/${encodeURIComponent(agentId)}/memories?depth=2`);
        if (!sameOwnerMemoryView(agentId, store, ownGeneration)) return;
        const current = (detailResponse.memories || []).find(note => note.id === selectedNote.id);
        if (!current || current.id !== selectedNote.id || current.agentId !== agentId || current.status !== selectedNote.status ||
            !['active', 'conditional'].includes(current.status) ||
            (selectedStanding !== 'all' && selectedStanding !== 'current' && selectedStanding !== current.status) ||
            current.verification !== 'owner-confirmed' || current.stale !== true || !Number.isInteger(current.revision_count)) {
          feedback = 'This owner note is no longer the same current, confirmed, stale note. Refresh the list and review it again.';
          return;
        }
        const values = await ask({
          title: 'Recheck this owner note?',
          message: `For ${label(target)}. Review the exact note and its source again. Reconfirmation appends a new review date and owner confirmation while preserving the note and its standing.`,
          accept: 'Recheck & confirm',
          fields: [
            { label: 'Exact note', value: current.content, multiline: true, readonly: true },
            { label: 'Source', value: current.source || 'unknown', readonly: true },
            { label: 'Validity condition', value: current.valid_while || '', multiline: true, readonly: true },
            { label: 'Source evidence excerpt', value: current.evidence_excerpt || '', multiline: true, readonly: true },
            { label: 'Previous recheck date', value: current.verify_by || 'No date recorded', readonly: true },
            { label: 'New recheck date (YYYY-MM-DD)', type: 'date', required: true },
            { label: 'Why was this note rechecked?', required: true }
          ]
        });
        if (!values) { feedback = 'Recheck canceled. This note remains marked stale.'; return; }
        if (!sameOwnerMemoryView(agentId, store, ownGeneration)) return;
        const nextVerifyBy = String(values[5] || '').trim();
        const why = String(values[6] || '').trim();
        if (!validFutureReviewDate(nextVerifyBy)) {
          feedback = 'Choose a valid future calendar date. The note was not changed and remains marked stale.';
          return;
        }
        if (!why) {
          feedback = 'Enter why you rechecked this note. It was not changed and remains marked stale.';
          return;
        }
        const result = await request(`/api/memories/${encodeURIComponent(current.id)}/confirm`, {
          method: 'POST', body: JSON.stringify({ expectedRevision: current.revision_count, why, approved: true, nextVerifyBy })
        });
        if (!sameOwnerMemoryView(agentId, store, ownGeneration)) return;
        const saved = result?.memory;
        const responseMatches = saved?.id === current.id && saved.agentId === agentId && saved.verification === 'owner-confirmed' && saved.verify_by === nextVerifyBy;
        await refresh();
        if (picker.value !== agentId || find('#memoryRecallStore')?.value !== store || isFacts() || isSkills()) return;
        if (failed) {
          feedback = responseMatches
            ? 'The note was reconfirmed, but the updated list could not be loaded. Refresh before relying on it.'
            : 'The server returned an unmatched result and the list could not be loaded. Refresh before relying on this note.';
        } else if (responseMatches) feedback = `Owner note rechecked and confirmed. Next review date: ${nextVerifyBy}.`;
        else feedback = 'The response did not match this owner note. Review the refreshed state before relying on it.';
      } catch (error) {
        if (sameOwnerMemoryView(agentId, store, ownGeneration)) {
          feedback = `Reconfirmation did not return a result: ${error.message || 'unexpected error'}. Reload to verify its current state; keep treating the note as stale until then.`;
        }
      } finally {
        ownerMemoryReconfirmBusy = false;
        render();
        if (feedback) status.textContent = feedback;
      }
    }
    async function runFactAction(button, action) {
      if (factActionBusy || button.disabled) return;
      factActionBusy = true;
      button.disabled = true;
      syncFactControls();
      try { await action(); }
      catch (error) { status.textContent = `Memory action could not be completed: ${error.message || 'unexpected error'}. No further action was taken.`; }
      finally {
        factActionBusy = false;
        button.disabled = false;
        const message = status.textContent;
        render();
        status.textContent = message;
        syncFactControls();
      }
    }
    createFactButton.addEventListener('click', () => { void runFactAction(createFactButton, () => editFact()); });
    list.addEventListener('click', async event => {
      const retireButton = event.target.closest('[data-owner-memory-retire]');
      if (retireButton && !isFacts() && !isSkills()) {
        const selectedNote = notes.find(item => item.id === retireButton.dataset.ownerMemoryRetire);
        if (selectedNote) await retireOwnerMemory(retireButton, selectedNote);
        return;
      }
      const reconfirmButton = event.target.closest('[data-owner-memory-reconfirm]');
      if (reconfirmButton && !isFacts() && !isSkills()) {
        const selectedNote = notes.find(item => item.id === reconfirmButton.dataset.ownerMemoryReconfirm);
        if (selectedNote) await reconfirmOwnerMemory(reconfirmButton, selectedNote);
        return;
      }
      const factAction = event.target.closest('[data-fact-edit], [data-fact-reject], [data-fact-review], [data-fact-supersede]');
      if (factAction && isFacts() && !factAction.disabled) {
        const selectedFact = notes.find(item => item.id === (factAction.dataset.factEdit || factAction.dataset.factReject || factAction.dataset.factReview || factAction.dataset.factSupersede));
        if (selectedFact) await runFactAction(factAction, () => factAction.dataset.factSupersede ? supersedeOlderFact(selectedFact) : factAction.dataset.factReview ? reviewFactStanding(selectedFact) : editFact(selectedFact, Boolean(factAction.dataset.factReject)));
        return;
      }
      const edit = event.target.closest('[data-skill-edit], [data-skill-standing]');
      if (edit && isSkills()) { const skill = notes.find(item => item.id === (edit.dataset.skillEdit || edit.dataset.skillStanding)); if (skill) await editSkill(skill, Boolean(edit.dataset.skillStanding)); return; }
      const button = event.target.closest('[data-skill-history]');
      if (!button || !isSkills() || button.disabled) return;
      const id = button.dataset.skillHistory, ownerGeneration = generation;
      const skill = notes.find(item => item.id === id);
      if (!skill) return;
      button.disabled = true;
      const feedback = list.querySelector(`[data-skill-history-status="${id}"]`);
      if (feedback) feedback.textContent = 'Reading version history…';
      try {
        const params = new URLSearchParams({ depth: '1', limit: '5' });
        if (button.dataset.beforeRevision) params.set('beforeRevision', button.dataset.beforeRevision);
        const response = await request(`/api/agents/${encodeURIComponent(picker.value)}/skills/${encodeURIComponent(id)}?${params}`);
        if (ownerGeneration !== generation || !isSkills()) return;
        if (response.skill?.id === id && response.skill.revision >= skill.revision) Object.assign(skill, response.skill);
        skill.history = [...new Map([...(skill.history || []), ...(response.revisions || [])].map(item => [item.revision, item])).values()];
        skill.nextBefore = response.nextBeforeRevision || null;
        render();
      } catch (error) {
        if (ownerGeneration !== generation || !isSkills()) return;
        button.disabled = false;
        if (feedback) feedback.textContent = `History could not be read: ${error.message}. Try again.`;
      }
    });
    find('#memoryRecallProfile').addEventListener('click', () => { if (picker.value) openProfile(picker.value); });
    async function readFact(agentId, memoryId) {
      const response = await request(`/api/agents/${encodeURIComponent(agentId)}/memory-facts/${encodeURIComponent(memoryId)}?depth=2`);
      if (response.memory?.id !== memoryId) throw new Error('The current fact detail did not match the selected record. Refresh memory and try again.');
      return response.memory;
    }
    function rememberFact(fact) {
      const item = { ...fact, content: fact.text, category: factCategory(fact) };
      const index = notes.findIndex((note) => note.id === item.id);
      if (index >= 0) notes[index] = item;
      else notes.unshift(item);
      return item;
    }
    const factPath = (agentId) => `/api/agents/${encodeURIComponent(agentId)}/memory-commit`;
    async function supersedeOlderFact(fact) {
      if (!ask || !picker.value || !isFacts()) return;
      const agentId = picker.value, ownGeneration = generation, draftKey = `${agentId}:${fact.id}:supersede`;
      const sameView = () => ownGeneration === generation && picker.value === agentId && isFacts();
      const isCurrent = item => ['active', 'conditional'].includes(item.status);
      const sameScope = (a, b) => a.contextScope && b.contextScope && a.contextScope.projectId === b.contextScope.projectId &&
        Object.hasOwn(a.contextScope, 'topicId') === Object.hasOwn(b.contextScope, 'topicId') && a.contextScope.topicId === b.contextScope.topicId;
      let current, candidates;
      try {
        current = await readFact(agentId, fact.id);
        if (!isCurrent(current)) throw new Error('Review this fact to a current standing before replacing another fact');
        const ids = [...new Set((current.conflicts || []).filter(link => link.relation === 'contradicts').map(link => link.otherId))];
        const details = await Promise.allSettled(ids.slice(0, 8).map(id => readFact(agentId, id)));
        candidates = details.filter(item => item.status === 'fulfilled').map(item => item.value)
          .filter(item => item.id !== current.id && isCurrent(item) && sameScope(item, current));
        if (!candidates.length) throw new Error('No current linked fact in the same exact scope is available. Review its standing or inspect the conflict first');
        if (!sameView()) return;
        const draft = factDrafts.get(draftKey)?.values || [];
        const excerpt = (value, limit) => { const points = Array.from(String(value || '')); return points.length > limit ? points.slice(0, limit).join('') + '\n[Excerpt truncated; inspect this exact fact at depth 2 for complete detail.]' : points.join(''); };
        const describe = item => [item.id, excerpt(item.text, 2000),
          `Standing: ${item.status} · ${item.verification || 'unverified'}`, item.warning || '',
          `Valid while: ${item.valid_while || 'No condition recorded.'}`,
          item.valid_from ? `Valid from: ${item.valid_from}` : '', item.valid_until ? `Valid until: ${item.valid_until}` : '',
          `Evidence: ${excerpt(item.evidence_excerpt || 'No excerpt retained.', 1000)}`].filter(Boolean).join('\n');
        const values = await ask({ title: 'Replace an older fact', accept: 'Record replacement',
          message: `The selected fact becomes the successor. Choose its older linked fact and the exact time the new fact became true. This closes the older validity window and preserves both texts and history; it does not certify the successor. Up to eight linked facts are checked (${ids.length} ${ids.length === 1 ? 'link' : 'links'} total). Unavailable, inactive or differently scoped records are excluded.`,
          fields: [
            { label: 'Successor fact and evidence', value: describe(current), readonly: true, multiline: true },
            { label: 'Older fact to supersede', options: candidates.map(item => item.id), value: candidates.some(item => item.id === draft[1]) ? draft[1] : candidates[0].id },
            { label: 'Older linked facts and evidence', value: candidates.map(describe).join('\n\n'), readonly: true, multiline: true },
            { label: 'New fact became true at (UTC)', value: current.valid_from || draft[3] || '', placeholder: '2026-10-04T12:00:00.000Z', required: true, readonly: Boolean(current.valid_from) },
            { label: 'Reason for this replacement', value: draft[4] || '', required: true, multiline: true },
            { label: 'Evidence you used for this decision', value: draft[5] || '', required: true, multiline: true }
          ] });
        if (!values || !sameView()) return;
        factDrafts.set(draftKey, { values });
        const older = candidates.find(item => item.id === values[1]);
        const boundary = String(values[3] || '').trim(), why = String(values[4] || '').trim(), evidence = String(values[5] || '').trim();
        if (!older || !why || !evidence || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(boundary) || !Number.isFinite(Date.parse(boundary)) || new Date(boundary).toISOString() !== boundary || current.valid_from && current.valid_from !== boundary) {
          status.textContent = 'Choose the older fact, an exact UTC boundary, reason and evidence. Nothing was changed; your draft is retained.'; return;
        }
        const result = await request(factPath(agentId), { method: 'POST', body: JSON.stringify({ operation: 'conflict',
          fromId: current.id, toId: older.id, relation: 'supersedes', expectedFromRevision: current.revision,
          expectedToRevision: older.revision, valid_from: boundary, why, source: { kind: 'owner-feedback', text: evidence }, approved: true }) });
        if (!sameView()) return;
        if (result?.committed !== true || result.fromId !== current.id || result.toId !== older.id || result.relation !== 'supersedes' || !result.linkId) throw new Error('The replacement receipt did not match these two facts');
        factDrafts.delete(draftKey); await refresh();
        if (picker.value === agentId && isFacts() && generation === ownGeneration + 1) status.textContent = 'Replacement recorded. The older fact is superseded; both texts, conditions and decision evidence remain in history.';
      } catch (error) {
        if (sameView()) status.textContent = `Replacement was not confirmed: ${error.message}. Nothing is retried automatically; reopen Replace older fact to review fresh revisions and your retained draft.`;
      }
    }
    async function reviewFactStanding(fact) {
      if (!ask || !picker.value || !isFacts()) return;
      const agentId = picker.value, ownGeneration = generation, draftKey = `${agentId}:${fact.id}:review`;
      const sameView = () => ownGeneration === generation && picker.value === agentId && isFacts();
      let current;
      try { current = await readFact(agentId, fact.id); }
      catch (error) { if (sameView()) status.textContent = `Review could not load: ${error.message}. Nothing was changed.`; return; }
      if (!sameView()) return;
      const draft = factDrafts.get(draftKey) || {};
      const currentStanding = current.valid_while ? 'conditional' : 'active';
      const options = ['disputed', currentStanding, 'rejected'];
      const links = (current.conflicts || []).slice(0, 20).map(link =>
        `${link.relation} · ${link.otherId}\n${link.why || ''}\n${link.evidence?.text || 'No conflict evidence excerpt retained.'}`);
      const values = await ask({ title: 'Review memory standing', accept: 'Save standing',
        message: `Current revision ${current.revision}. Choose how this exact fact may be used. Disputed and rejected facts stay out of ordinary recall. Returning it to ${currentStanding} preserves its conditions and does not certify it, choose a winner, or erase conflicting records.`,
        fields: [
          { label: 'Fact, condition and source', value: [current.id, current.text, `Standing: ${current.status} · ${current.verification || 'unverified'}`, current.warning || '',
            `Valid while: ${current.valid_while || 'No condition recorded.'}`, current.valid_from ? `Valid from: ${current.valid_from}` : '',
            current.valid_until ? `Valid until: ${current.valid_until}` : '', current.verify_by ? `Recheck by: ${current.verify_by}` : '',
            `Source evidence: ${current.evidence_excerpt || 'No excerpt retained.'}`].filter(Boolean).join('\n'), readonly: true, multiline: true },
          { label: 'Linked conflicts and evidence', value: (links.join('\n\n') || 'No conflict links recorded.') + (current.conflicts?.length > 20 ? '\n\nMore links remain: read this exact fact at depth 2 for the complete history.' : ''), readonly: true, multiline: true },
          { label: 'Standing after review', value: options.includes(draft.values?.[2]) ? draft.values[2] : options.includes(current.status) ? current.status : 'disputed', options },
          { label: 'Evidence-backed reason for this decision', value: draft.values?.[3] || '', required: true, multiline: true, rows: 3 }
        ] });
      if (!values || !sameView()) return;
      const nextStatus = String(values[2] || ''), why = String(values[3] || '').trim();
      factDrafts.set(draftKey, { values });
      if (!options.includes(nextStatus) || !why) { status.textContent = 'Choose a standing and explain the evidence for your decision. Nothing was changed.'; return; }
      if (nextStatus === current.status) { factDrafts.delete(draftKey); status.textContent = 'Standing is unchanged. No revision was added.'; return; }
      try {
        const result = await request(factPath(agentId), { method: 'POST', body: JSON.stringify({ operation: 'revise', id: current.id,
          expectedRevision: current.revision, changes: { status: nextStatus }, why, approved: true }) });
        if (!sameView()) return;
        if (result?.committed !== true || result.id !== current.id || result.revision !== current.revision + 1) throw new Error('The returned revision did not match this fact; refresh its history before retrying');
        factDrafts.delete(draftKey); await refresh();
        if (picker.value !== agentId || !isFacts() || generation !== ownGeneration + 1) return;
        status.textContent = `Review saved as ${nextStatus}. Earlier standing, source evidence and linked records remain in history.`;
      } catch (error) {
        if (!sameView()) return;
        if (await handleFactRevisionConflict(error, { agentId, memoryId: current.id, draftKey, draft: { values }, ownGeneration })) return;
        status.textContent = `Standing was not confirmed: ${error.message}. Your reason is retained; reopen Review standing to retry.`;
      }
    }
    async function editFact(fact = null, reject = false) {
      if (!ask || !picker.value || !isFacts()) return;
      const agentId = picker.value, ownGeneration = generation, memoryId = fact?.id || null;
      const draftKey = `${agentId}:${memoryId || 'new'}:${reject ? 'reject' : 'edit'}`;
      let draft = factDrafts.get(draftKey) || {};
      let current = null;
      if (fact) {
        status.textContent = `Loading current detail for ${factCategory(fact)}…`;
        try { current = await readFact(agentId, memoryId); }
        catch (error) {
          if (ownGeneration === generation && picker.value === agentId) status.textContent = `Fact detail could not be loaded: ${error.message}. Nothing was changed.`;
          return;
        }
        if (ownGeneration !== generation || picker.value !== agentId || !isFacts()) return;
        fact = rememberFact(current);
        render();
      }
      const target = agents().find((item) => item.id === agentId);
      if (!target) return;
      if (reject) {
        const mistake = memoryMistakeRecord(fact);
        const values = await ask({
          title: mistake ? 'Reject this past-mistake record?' : 'Reject this fact from recall?',
          message: mistake
            ? `For ${label(target)}. This appends a rejected standing and keeps the record in local history. Rejected records are excluded from future mistake warnings. Current revision: ${fact.revision}.`
            : `For ${label(target)}. This appends a rejected standing so the fact is excluded from ordinary recall. It remains in local history; nothing is physically erased. Current revision: ${fact.revision}.`,
          accept: mistake ? 'Reject record' : 'Reject from recall', danger: true,
          fields: [{ label: 'Reason for rejection', value: draft.values?.[0] || '', required: true, multiline: true, rows: 3 }]
        });
        if (!values || ownGeneration !== generation || picker.value !== agentId || !isFacts()) return;
        draft = { ...draft, values };
        factDrafts.set(draftKey, draft);
        const why = String(values[0] || '').trim();
        if (!why) { status.textContent = 'Enter a reason. The fact was not changed.'; return; }
        try {
          await request(factPath(agentId), { method: 'POST', body: JSON.stringify({ operation: 'revise', id: memoryId, expectedRevision: fact.revision, why, changes: { status: 'rejected' }, approved: true }) });
          if (ownGeneration !== generation) return;
          factDrafts.delete(draftKey);
          await refresh();
          status.textContent = mistake
            ? 'Past-mistake record rejected. Its history remains saved and it is excluded from future mistake warnings.'
            : 'Fact rejected from ordinary recall. Its revision history remains saved.';
        } catch (error) {
          if (ownGeneration !== generation) return;
          if (await handleFactRevisionConflict(error, { agentId, memoryId, draftKey, draft, ownGeneration })) return;
          status.textContent = `Fact was not rejected: ${error.message.replace(/\.+$/, '')}. The reason is retained; reopen Reject from recall to retry.`;
        }
        return;
      }

      const baseFields = [
        { label: 'Fact', value: draft.values?.[0] ?? current?.text ?? '', required: true, multiline: true, rows: 4 },
        { label: 'Category', value: draft.values?.[1] ?? current?.metadata?.category ?? '', required: false },
        { label: 'Project / scope key', value: draft.values?.[2] ?? current?.contextScope?.projectId ?? '', required: false, description: 'Optional. Use a short key with letters, digits, dots, dashes, underscores or colons.' },
        { label: 'Topic key', value: draft.values?.[3] ?? current?.contextScope?.topicId ?? '', required: false },
        { label: 'Standing', value: draft.values?.[4] ?? current?.status ?? 'active', options: ['active', 'conditional', 'superseded', 'disputed', 'rejected', 'historical'] },
        { label: 'Valid while', value: draft.values?.[5] ?? current?.valid_while ?? '', required: false, multiline: true, rows: 2 },
        { label: 'Recheck by (ISO date or timestamp)', value: draft.values?.[6] ?? current?.verify_by ?? '', required: false },
        { label: 'Source evidence excerpt', value: draft.values?.[7] ?? current?.evidence_excerpt ?? '', required: false, multiline: true, rows: 3 }
      ];
      const values = await ask({
        title: fact ? 'Edit versioned fact' : 'Create memory fact',
        message: fact
          ? `For ${label(target)}. Current revision ${current.revision} and evidence are loaded. Saving appends a revision and keeps earlier versions in history; it does not turn the prior text into a separate superseded record. Review history/evidence using Detail → Facts + history + evidence.`
          : `For ${label(target)}. The new fact is saved locally as unverified. It can be used in recall only within its selected scope and standing.`,
        accept: fact ? 'Save revision' : 'Create fact',
        fields: fact ? [...baseFields, { label: 'Reason for this revision', value: draft.values?.[8] || '', required: true, multiline: true, rows: 3 }] : baseFields
      });
      if (!values || ownGeneration !== generation || picker.value !== agentId || !isFacts()) return;
      draft = { ...draft, id: draft.id || (fact ? memoryId : `memory-${crypto.randomUUID()}`), values };
      factDrafts.set(draftKey, draft);
      const text = String(values[0] || '').trim();
      const category = String(values[1] || '').trim();
      const projectId = String(values[2] || '').trim();
      const topicId = String(values[3] || '').trim();
      const nextStatus = String(values[4] || 'active');
      const validWhile = String(values[5] || '').trim();
      const verifyBy = String(values[6] || '').trim();
      const evidenceExcerpt = String(values[7] || '').trim();
      const scopeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
      if ((!projectId && topicId) || (projectId && !scopeIdPattern.test(projectId)) || (topicId && !scopeIdPattern.test(topicId))) {
        status.textContent = 'Use a valid project key before a topic key. Scope keys start with a letter or number and contain at most 128 letters, digits, dots, dashes, underscores or colons.';
        return;
      }
      if (nextStatus === 'conditional' && !validWhile) { status.textContent = 'Conditional facts need a “Valid while” condition.'; return; }
      const contextScope = projectId ? { projectId, ...(topicId ? { topicId } : {}) } : null;
      const metadata = { ...(current?.metadata || {}) };
      if (category) metadata.category = category; else delete metadata.category;
      const why = fact ? String(values[8] || '').trim() : '';
      if (fact && !why) { status.textContent = 'Enter a reason for this revision. The fact was not changed.'; return; }
      const body = fact
        ? { operation: 'revise', id: memoryId, expectedRevision: current.revision, why, changes: { text, metadata, contextScope, status: nextStatus, valid_while: validWhile, verify_by: verifyBy || null, evidence_excerpt: evidenceExcerpt } }
        : { operation: 'create', id: draft.id, text, metadata: { ...metadata, category: category || 'General' }, contextScope, status: nextStatus, valid_while: validWhile, verify_by: verifyBy || null, evidence_excerpt: evidenceExcerpt };
      try {
        await request(factPath(agentId), { method: 'POST', body: JSON.stringify({ ...body, approved: true }) });
        if (ownGeneration !== generation) return;
        factDrafts.delete(draftKey);
        await refresh();
        status.textContent = fact ? 'Fact revision saved. Earlier versions remain in history.' : 'Fact created locally as unverified.';
      } catch (error) {
        if (ownGeneration !== generation) return;
        if (fact && await handleFactRevisionConflict(error, { agentId, memoryId, draftKey, draft, ownGeneration })) return;
        status.textContent = `${fact ? 'Fact was not saved' : 'Fact may not have been saved'}: ${error.message.replace(/\.+$/, '')}. Your draft is retained; reopen the same action to review it.`;
      }
    }
    async function handleFactRevisionConflict(error, { agentId, memoryId, draftKey, draft, ownGeneration }) {
      const conflictMessage = error.message || error.body?.error || '';
      const revisionConflict = /memory revision conflict/i.test(conflictMessage) ||
        (error.status === 409 && /memory.*(?:revision|conflict)|(?:revision|conflict).*memory/i.test(conflictMessage));
      if (!revisionConflict) return false;
      try {
        const latest = await readFact(agentId, memoryId);
        if (ownGeneration !== generation || picker.value !== agentId) return true;
        rememberFact(latest);
        factDrafts.set(draftKey, draft);
        render();
        status.textContent = `This fact changed while you were editing. Revision ${latest.revision} is now loaded and your attempted values are retained. Review the current history and click ${draftKey.endsWith(':reject') ? 'Reject from recall' : draftKey.endsWith(':review') ? 'Review standing' : 'Edit fact'} again; nothing was overwritten.`;
      } catch (reloadError) {
        if (ownGeneration === generation) status.textContent = `This fact changed while you were editing, and current detail could not be reloaded: ${reloadError.message}. Your draft is retained; refresh before trying again.`;
      }
      return true;
    }
    async function editSkill(skill, standingOnly = false) {
      if (!ask || !picker.value) return;
      const agentId = picker.value, ownGeneration = generation;
      const nextStatus = skill?.status === 'active' ? 'retired' : 'active';
      const draftKey = `${agentId}:${skill?.id || 'new'}:${standingOnly}`;
      const draft = skillDrafts.get(draftKey);
      const fields = standingOnly ? [{ label: 'Reason', value: draft?.[0] || '', required: true }] : [
        { label: 'Skill name', value: draft?.[0] ?? skill?.name ?? '', required: true },
        { label: 'Use when', value: draft?.[1] ?? skill?.whenToUse ?? '', required: true, multiline: true, rows: 3 },
        { label: 'Procedure', value: draft?.[2] ?? skill?.procedure ?? '', required: true, multiline: true, rows: 3 },
        { label: 'Success check', value: draft?.[3] ?? skill?.successCheck ?? '', required: true, multiline: true, rows: 3 },
        { label: 'Reason', value: draft?.[4] || '', required: true }
      ];
      const target = agents().find(agent => agent.id === agentId);
      if (!target) return;
      const values = await ask({ title: standingOnly ? `${nextStatus === 'retired' ? 'Retire' : 'Restore'} this skill?` : skill ? 'Edit versioned skill' : 'Create versioned skill',
        message: `For ${label(target)}. Saves a local version with its reason; it does not run the procedure. Existing Build-mode and write policy must allow this change. Retired skills retain their history.`,
        accept: standingOnly ? nextStatus === 'retired' ? 'Retire skill' : 'Restore skill' : 'Save skill', fields });
      if (!values || ownGeneration !== generation || picker.value !== agentId) return;
      skillDrafts.set(draftKey, values);
      const changes = standingOnly ? { status: nextStatus } : { name: values[0], whenToUse: values[1], procedure: values[2], successCheck: values[3] };
      const body = skill ? { changes, expectedRevision: skill.revision, why: values.at(-1), approved: true } : { ...changes, why: values.at(-1), approved: true };
      try {
        await request(`/api/agents/${encodeURIComponent(agentId)}/skills${skill ? `/${encodeURIComponent(skill.id)}/revise` : ''}`, { method: 'POST', body: JSON.stringify(body) });
        if (ownGeneration !== generation) return;
        skillDrafts.delete(draftKey);
        await refresh();
        status.textContent += ' Skill version saved.';
      } catch (error) { if (ownGeneration === generation) status.textContent = `Skill was not saved: ${error.message.replace(/\.+$/, '')}. Your draft is retained; reopen the same action to review it.`; }
    }
    find('#memoryRecallCreateSkill')?.addEventListener('click', () => { void editSkill(); });
    skillQuarantineList?.addEventListener('click', async event => {
      const button = event.target.closest('[data-skill-quarantine-reject]');
      const item = skillQuarantines.find(candidate => candidate.id === button?.dataset.skillQuarantineReject);
      if (!button || button.disabled || !item || !ask || !isSkills()) return;
      const card = button.closest('[data-skill-quarantine-card]');
      const reasonInput = card?.querySelector('[data-skill-quarantine-reason]');
      const reason = String(reasonInput?.value || '').trim();
      if (!reason) {
        skillQuarantineStatus.textContent = 'Enter a reason before rejecting this draft.';
        reasonInput?.focus?.();
        return;
      }
      const agentId = picker.value, ownGeneration = generation;
      skillQuarantineBusy.add(item.id);
      button.disabled = true;
      try {
        await request(`/api/agents/${encodeURIComponent(agentId)}/skill-quarantines/${encodeURIComponent(item.id)}`, {
          method: 'POST', body: JSON.stringify({ decision: 'rejected', reason, approved: true })
        });
        if (ownGeneration !== generation || picker.value !== agentId || !isSkills()) return;
        skillQuarantines = skillQuarantines.filter(candidate => candidate.id !== item.id);
        skillQuarantineBusy.delete(item.id);
        renderSkillQuarantines();
        skillQuarantineStatus.textContent = 'Draft rejected. Its contents were not applied.';
      } catch (error) {
        if (ownGeneration === generation && picker.value === agentId && isSkills()) {
          const feedback = card?.querySelector('[data-skill-quarantine-feedback]');
          if (feedback) feedback.textContent = `Draft was not rejected: ${error.message || 'request failed'}. The reason is still available to edit.`;
          button.disabled = false;
        }
      } finally {
        skillQuarantineBusy.delete(item.id);
      }
    });
    return { refresh };
  }

  function memoryRiskReasonLabel(reason) {
    return ({ delayed_prompt_injection: 'Instructions trying to override future decisions',
      high_confidence_ssn: 'Possible government identification number',
      payment_card_number: 'Possible payment card number',
      unsupported_shape: 'Unsupported memory format', input_too_large: 'Content exceeds the review limit',
      write_spike: 'Unusual burst of memory writes — review before using' })[reason] || 'Requires inspection';
  }

  function createMemoryReview({ root, request, agents = () => [] }) {
    const find = (selector) => root.querySelector(selector);
    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
    const list = find('#memoryReviewList');
    const count = find('#memoryReviewCount');
    const status = find('#memoryReviewStatus');
    let proposals = [];
    let loading = null;
    const isCapturePending = (proposal) => proposal?.capturePending === true &&
      proposal.kind === 'owner-memory-correction' && proposal.quarantined !== true;
    function render() {
      count.textContent = `(${proposals.length})`;
      list.innerHTML = proposals.map((proposal) => {
        const agent = agents().find((item) => item.id === proposal.agentId);
        const quarantined = proposal.kind === 'risk-quarantine' || proposal.quarantined === true;
        const capturePending = isCapturePending(proposal);
        const captureRetryUnavailable = capturePending && proposal.captureRetryUnavailable === true;
        const kind = quarantined ? 'Quarantined candidate' : capturePending ? 'Saved owner note · correction record unfinished' : proposal.kind === 'create' ? 'New fact' : proposal.kind === 'correction' ? 'Fact correction' : 'Owner note correction';
        const payload = proposal.payload || {};
        const source = payload.source || {};
        return `<details class="memory-review-item" data-memory-review-id="${escape(proposal.id)}"><summary>${escape(agent?.name || 'Agent')} · ${escape(kind)}</summary>
          <small>${escape(proposal.id)} · ${escape(payload.contextScope?.projectId || 'Agent memory')} · ${escape(proposal.createdAt || '')}</small>
          ${quarantined ? `<p>Excluded from memory and recall. This candidate cannot be approved. Detection: ${escape((proposal.riskReasonCodes || []).map(memoryRiskReasonLabel).join('; '))}.</p>` : ''}
          ${proposal.writeLimitReason === 'write_spike' ? '<p>This change is waiting for your review because the agent reached its short-term change limit. Review it here; the limit prevents an automated burst from changing memory repeatedly.</p>' : ''}
          ${capturePending ? captureRetryUnavailable ? '<p>This correction belongs to an inactive or replaced agent lineage. It cannot be finished here. Stop retry leaves the saved note and any existing correction evidence unchanged.</p>' : '<p>The owner note is already saved. Finish the correction record to retain its evidence, or stop retrying it. Stopping the retry leaves the saved note and any existing correction evidence unchanged.</p>' : ''}
          <pre>${escape(payload.text || payload.changes?.text || '')}</pre>
          ${payload.valid_while ? `<p>Valid while: ${escape(payload.valid_while)}</p>` : ''}
          ${payload.verify_by ? `<p>Recheck by: ${escape(payload.verify_by)}</p>` : ''}
          ${payload.why ? `<p>Reason: ${escape(payload.why)}</p>` : ''}
          ${payload.expectedNextBehavior ? `<p>Expected behavior: ${escape(payload.expectedNextBehavior)}</p>` : ''}
          ${payload.evidence_excerpt ? `<p>Evidence excerpt: ${escape(payload.evidence_excerpt)}</p>` : ''}
          ${source.text ? `<p>Agent's source message (verify independently): ${escape(source.text)}</p>` : ''}
          <div class="memory-review-actions">${quarantined || captureRetryUnavailable ? '' : `<button class="secondary-button" type="button" data-memory-decision="approve">${capturePending ? 'Finish correction record' : 'Approve as unverified'}</button>`}${capturePending ? `<button class="ghost-button" type="button" data-memory-decision="discard-capture">Stop retry</button>` : `<input aria-label="Reason to reject ${escape(proposal.id)}" maxlength="1000" placeholder="Reason to reject"><button class="ghost-button" type="button" data-memory-decision="reject">Reject</button>`}</div>
        </details>`;
      }).join('') || '<p>No memory proposals need review.</p>';
    }
    function refresh() {
      if (loading) return loading;
      status.textContent = 'Checking proposals…';
      find('#memoryReviewRefresh').disabled = true;
      loading = (async () => {
        try {
          proposals = (await request('/api/memory-proposals')).proposals || [];
          render();
          status.textContent = '';
          return true;
        } catch (error) {
          proposals = [];
          count.textContent = '(?)';
          list.innerHTML = '<p>Proposals could not be loaded. Refresh to retry.</p>';
          status.textContent = error.message;
          return false;
        } finally {
          find('#memoryReviewRefresh').disabled = false;
          loading = null;
        }
      })();
      return loading;
    }
    find('#memoryReviewRefresh').addEventListener('click', () => { void refresh(); });
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-memory-decision]');
      const card = button?.closest('[data-memory-review-id]');
      const proposal = proposals.find((item) => item.id === card?.dataset.memoryReviewId);
      if (!button || button.disabled || !proposal) return;
      const decision = button.dataset.memoryDecision;
      if (!['approve', 'reject', 'discard-capture'].includes(decision)) return;
      const capturePending = isCapturePending(proposal);
      if (capturePending && proposal.captureRetryUnavailable === true && decision === 'approve') {
        status.textContent = 'This correction belongs to an inactive or replaced agent lineage. You can stop its retry without changing the saved note.';
        return;
      }
      if (capturePending && decision === 'reject') {
        status.textContent = 'The owner note is already saved. Finish the correction record or stop its retry; it cannot be rejected as though the note were undone.';
        return;
      }
      if (!capturePending && decision === 'discard-capture') {
        status.textContent = 'There is no unfinished correction record to stop.';
        return;
      }
      if (decision === 'approve' && (proposal.kind === 'risk-quarantine' || proposal.quarantined === true)) {
        status.textContent = 'Quarantined candidates cannot be approved or recalled.';
        return;
      }
      const reason = decision === 'reject' ? card.querySelector('input')?.value.trim() || '' : '';
      if (decision === 'reject' && !reason) { status.textContent = 'Enter a short rejection reason first.'; return; }
      for (const action of card.querySelectorAll('button')) action.disabled = true;
      try {
        const result = await request(`/api/memory-proposals/${encodeURIComponent(proposal.id)}/decision`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, ...(decision === 'reject' ? { reason } : {}) })
        });
        const refreshed = await refresh();
        const captureComplete = result.ownerNote && (result.captureComplete === true || result.ownerNoteCaptureState === 'complete');
        const captureDiscarded = result.captureDiscarded === true || result.ownerNoteCaptureState === 'discarded';
        const stillPending = proposals.some(item => item.id === proposal.id && isCapturePending(item));
        const discardConfirmed = captureDiscarded && refreshed && !stillPending;
        const message = capturePending && discardConfirmed
          ? 'The saved owner note remains. Its correction-record retry stopped; any existing correction evidence remains unchanged.'
          : capturePending && decision === 'discard-capture'
            ? captureDiscarded && !refreshed
              ? 'The stop request was saved, but the proposal list could not be refreshed. Refresh to verify the correction-record retry was removed.'
              : refreshed && !stillPending
                ? 'The capture is no longer pending, but the stop request was not confirmed. Refresh to inspect its current state.'
                : 'The correction record still appears unfinished. Refresh to verify before retrying.'
          : capturePending
          ? captureComplete
            ? 'The owner note is saved and the correction record is finished.'
            : 'Note saved; correction record is still unfinished. Retry when available.'
          : result.status === 'approved'
          ? `Saved as ${result.ownerNote ? 'an owner note' : 'unverified memory'}.${result.indexed === false ? ' Search indexing is pending; text recall remains available.' : ''}`
          : 'Proposal rejected.';
        status.textContent = message + (refreshed ? '' : ' Refresh to reload the remaining proposals.');
      } catch (error) {
        if (decision === 'discard-capture') {
          const refreshed = await refresh();
          const stillPending = proposals.some(item => item.id === proposal.id && isCapturePending(item));
          status.textContent = refreshed && stillPending
            ? `The correction-record retry remains pending. ${error.message}`
            : refreshed
              ? `Could not verify that the retry stopped; the capture is no longer pending. Refresh to inspect its current state. ${error.message}`
              : `Could not verify that the retry stopped. Refresh to inspect the capture's current state. ${error.message}`;
        } else status.textContent = error.message;
        for (const action of card.querySelectorAll('button')) action.disabled = false;
      }
    });
    return { refresh };
  }

  window.HexiGridViewRenderers = { renderOverview, renderUsage, renderModels, renderSetup, renderAccess, renderActivity, renderSettings, renderNetwork, agentCatalogEntries, agentWorkRecords, taskHistoryHtml, agentUsageReport, createMemoryReview, createMemoryRecall, memoryRiskReasonLabel, linkPresence, orderAgents, agentSelectionStanding };
})();

(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  function create({ root, request, agents, links }) {
    root.innerHTML = `<div class="memory-review-heading"><div><h3>Shared memory</h3><p>Give another agent read access to one project or topic. Other memories stay private; sharing does not certify that a fact is true.</p></div><button type="button" class="secondary-button" data-share-refresh>Refresh shares</button></div>
      <form data-share-form><div class="memory-share-controls"><label>Source agent<select data-share-source required></select></label><label>Project or topic<select data-share-scope required></select></label><label>Receiving agent Link<select data-share-target required></select></label></div>
      <button type="button" class="text-button" data-share-more hidden>Load more scopes</button><p data-share-scope-help></p><p data-share-target-help></p><button type="submit" class="secondary-button" data-share-submit disabled>Review sharing</button></form>
      <div data-share-confirm hidden><p data-share-summary></p><button type="button" class="secondary-button" data-share-confirm-button>Confirm sharing</button><button type="button" class="text-button" data-share-cancel>Cancel</button></div>
      <p data-share-status role="status" aria-live="polite"></p><div data-share-list></div>`;
    const find = name => root.querySelector(`[data-share-${name}]`);
    const source = find('source'), target = find('target'), scope = find('scope'), status = find('status');
    let shares = [], scopes = [], cursor = null, generation = 0, loading = false, mutating = false, pending = null;
    const name = id => agents().find(agent => agent.id === id)?.name || 'Unavailable agent';
    const eligible = () => links().filter(link => (link.authorizationStatus || link.status) === 'connected' && link.agentId !== source.value && link.capabilities?.includes('memory-read'));
    function cancel() { pending = null; find('confirm').hidden = true; }
    function readiness() { find('submit').disabled = loading || mutating || scope.value === '' || !scopes[Number(scope.value)] || !eligible().some(link => link.id === target.value); }
    function targets() {
      const selected = target.value;
      target.innerHTML = '<option value="">Select a receiving Link</option>' + eligible().map(link => `<option value="${escape(link.id)}">${escape(name(link.agentId))} · ${escape(link.id.slice(-8))}</option>`).join('');
      if (eligible().some(link => link.id === selected)) target.value = selected;
      find('target-help').textContent = eligible().length ? 'Choose the exact receiving Link. Only connected Links with memory read are listed.' : 'Connect another agent with memory read enabled before sharing.';
      readiness();
    }
    function render() {
      find('list').innerHTML = shares.map(share => `<article class="memory-recall-card"><header><strong>${escape(name(share.sourceAgentId))} → ${escape(name(share.targetAgentId))}</strong><span>${escape(share.status)}</span></header><p>${escape(share.scope.projectId)}${share.scope.topicId ? ` / ${escape(share.scope.topicId)}` : ''}</p><small>Link ${escape(share.targetLinkId.slice(-8))}</small>${share.status === 'active' ? `<button type="button" class="text-button" data-share-revoke="${escape(share.id)}">Review revocation</button>` : ''}</article>`).join('') || '<p>No memory is shared. Each agent’s memory is private.</p>';
    }
    async function loadScopes(more = false) {
      const read = ++generation, agentId = source.value;
      cancel(); loading = true; readiness();
      if (!more) { scopes = []; cursor = null; scope.innerHTML = '<option value="">Select a project or topic</option>'; }
      find('scope-help').textContent = agentId ? 'Loading current memory scopes…' : agents().length ? 'Choose a source agent to load its projects and topics.' : 'Add an agent to begin.';
      find('more').hidden = true;
      try {
        if (!agentId) return;
        const result = await request(`/api/agents/${encodeURIComponent(agentId)}/memory-mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list-context-scopes', arguments: { maxBytes: 8192, ...(more && cursor ? { cursor } : {}) } } }) });
        if (read !== generation) return;
        if (result.error) throw new Error(result.error.message || 'Scope discovery failed.');
        const packet = result.result?.structuredContent;
        if (!packet || !Array.isArray(packet.scopes)) throw new Error('Scope discovery returned no inventory.');
        scopes.push(...packet.scopes); cursor = packet.nextCursor;
        const selected = scope.value;
        scope.innerHTML = '<option value="">Select a project or topic</option>' + scopes.map((item, index) => `<option value="${index}">${escape(item.projectId)}${item.topicId ? ` / ${escape(item.topicId)}` : ''}</option>`).join('');
        if (more) scope.value = selected;
        find('more').hidden = !cursor;
        find('scope-help').textContent = scopes.length ? `${scopes.length} current scopes loaded. Unscoped memories are not shared here.` : 'No current project or topic facts. Tag a memory with its project before sharing it.';
      } catch (error) { if (read === generation) { find('scope-help').textContent = `${error.message} Refresh to retry.`; scopes = []; scope.innerHTML = '<option value="">Unavailable</option>'; } }
      finally { if (read === generation) { loading = false; readiness(); } }
    }
    async function refresh() {
      if (mutating) return;
      cancel(); find('refresh').disabled = true;
      try {
        const result = await request('/api/memory-shares');
        shares = result.shares || []; render(); status.textContent = '';
        const selected = source.value;
        source.innerHTML = '<option value="">Select a source agent</option>' + agents().map(agent => `<option value="${escape(agent.id)}">${escape(agent.name)} · ${escape(agent.id.slice(-6))}</option>`).join('');
        if (agents().some(agent => agent.id === selected)) source.value = selected;
        targets(); await loadScopes();
      } catch (error) { ++generation; scopes = []; loading = false; readiness(); find('list').innerHTML = ''; status.textContent = `${error.message} Use Refresh shares to retry.`; }
      finally { find('refresh').disabled = false; }
    }
    function review(action) { pending = action; find('summary').textContent = action.summary; find('confirm-button').textContent = action.revoke ? 'Confirm revocation' : 'Confirm sharing'; find('confirm').hidden = false; }
    find('form').addEventListener('submit', event => {
      event.preventDefault(); readiness(); if (find('submit').disabled) return;
      const selected = scopes[Number(scope.value)], link = eligible().find(item => item.id === target.value);
      review({ body: { sourceAgentId: source.value, targetLinkId: link.id, scope: { projectId: selected.projectId, ...(selected.topicId ? { topicId: selected.topicId } : {}) }, approved: true }, summary: `Share ${name(source.value)}’s ${selected.projectId}${selected.topicId ? ' / ' + selected.topicId : ''} with ${name(link.agentId)} on Link ${link.id.slice(-8)}? This grants read access only.` });
    });
    find('confirm-button').addEventListener('click', async () => {
      if (!pending || mutating) return;
      const action = pending; mutating = true; find('confirm-button').disabled = true; readiness();
      try { await request(action.revoke ? `/api/memory-shares/${encodeURIComponent(action.revoke)}/revoke` : '/api/memory-shares', { method: 'POST', body: JSON.stringify(action.body) }); cancel(); mutating = false; await refresh(); status.textContent = action.revoke ? 'Read access revoked. Memory history is retained.' : 'Read access shared for that exact Link and scope.'; }
      catch (error) { status.textContent = `${error.message} The action was not retried. Refresh shares to inspect its standing.`; cancel(); }
      finally { mutating = false; find('confirm-button').disabled = false; readiness(); }
    });
    find('list').addEventListener('click', event => {
      const button = event.target.closest('[data-share-revoke]');
      const share = button && shares.find(item => item.id === button.dataset.shareRevoke && item.status === 'active');
      if (share && !mutating) review({ revoke: share.id, body: { approved: true }, summary: `Revoke ${name(share.targetAgentId)}’s access to ${name(share.sourceAgentId)}’s ${share.scope.projectId}${share.scope.topicId ? ' / ' + share.scope.topicId : ''} on Link ${share.targetLinkId.slice(-8)}?` });
    });
    source.addEventListener('change', () => { targets(); void loadScopes(); });
    for (const picker of [target, scope]) picker.addEventListener('change', () => { cancel(); readiness(); });
    find('refresh').addEventListener('click', () => { void refresh(); });
    find('more').addEventListener('click', () => { if (!loading) void loadScopes(true); });
    find('cancel').addEventListener('click', cancel);
    return { refresh };
  }
  window.HexiGridMemorySharing = { create };
})();

(() => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[character]);
  function create() {
    const modalRoot = document.createElement('div');
    modalRoot.id = 'hexigridModal';
    modalRoot.className = 'hexigrid-modal hidden';
    modalRoot.innerHTML = '<div class="modal-surface" role="dialog" aria-modal="true" aria-labelledby="confirmModalTitle"><div class="modal-signal"></div><div class="eyebrow" id="confirmModalKicker">CONFIRM</div><h2 id="confirmModalTitle"></h2><p id="confirmModalMessage"></p><div id="confirmModalFields" class="modal-fields"></div><div class="modal-actions"><button class="ghost-button" id="confirmModalCancel" type="button">Cancel</button><button class="primary-button" id="confirmModalAccept" type="button">Continue</button></div></div>';
    document.body.append(modalRoot);
    const backgroundInert = new Map();

    function setBackgroundInert(enabled) {
      if (window.HexiGridInertScopes?.set) {
        window.HexiGridInertScopes.set('confirm-modal', enabled, modalRoot);
        return;
      }
      if (enabled) {
        for (const element of document.body.children) {
          if (element === modalRoot || backgroundInert.has(element)) continue;
          backgroundInert.set(element, element.inert);
          element.inert = true;
        }
      } else {
        for (const [element, wasInert] of backgroundInert) element.inert = wasInert;
        backgroundInert.clear();
      }
    }

    function focusableControls(root) {
      return [...root.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')]
        .filter(control => !control.hidden && control.getClientRects().length);
    }

    function modalRequest({ title, message = '', accept = 'Continue', danger = false, fields = [] }) {
      function restoreAuthGateInertness() {
        const gate = document.getElementById?.('authGate');
        if (!gate || gate.classList.contains('hidden')) return;
        window.HexiGridInertScopes?.set('auth', true, [gate, document.getElementById?.('offlineState')]);
      }
      return new Promise((resolve) => {
        const root = document.querySelector('#hexigridModal');
        document.querySelector('#confirmModalTitle').textContent = title;
        document.querySelector('#confirmModalMessage').textContent = message;
        const fieldRoot = document.querySelector('#confirmModalFields');
        fieldRoot.innerHTML = fields.map((field, index) => {
          const help = field.description ? `<small>${escapeHtml(field.description)}</small>` : '';
          if (Array.isArray(field.options)) return `<label>${escapeHtml(field.label)}<select data-modal-field="${index}">${field.options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}</select>${help}</label>`;
          if (field.type === 'checkbox') return `<label class="checkbox-control"><input data-modal-field="${index}" type="checkbox" ${field.required ? 'required' : ''}><span>${escapeHtml(field.label)}${help}</span></label>`;
          return `<label>${escapeHtml(field.label)}<${field.multiline ? 'textarea' : 'input'} aria-label="${escapeHtml(field.label)}" data-modal-field="${index}" ${field.multiline ? `rows="${Math.max(3, Math.min(16, Number(field.rows) || 5))}"` : `type="${field.type || 'text'}"`} placeholder="${escapeHtml(field.placeholder || '')}" ${Number.isSafeInteger(field.minLength) && field.minLength > 0 ? `minlength="${field.minLength}"` : ''} ${field.required ? 'required' : ''} ${field.readonly ? 'readonly' : ''}>${field.multiline ? escapeHtml(field.value || '') : ''}</${field.multiline ? 'textarea' : 'input'}>${help}</label>`;
        }).join('');
        fields.forEach((field, index) => { const input = fieldRoot.querySelector(`[data-modal-field="${index}"]`); if (field.type === 'checkbox') input.checked = field.value === true; else if (!field.multiline) input.value = field.value ?? ''; if (!Array.isArray(field.options) && Number.isSafeInteger(field.maxLength) && field.maxLength > 0) input.maxLength = field.maxLength; });
        const acceptButton = document.querySelector('#confirmModalAccept'); acceptButton.textContent = accept; acceptButton.classList.toggle('danger-button', danger);
        const opener = document.activeElement;
        root.classList.remove('hidden'); document.body.classList.add('overlay-open'); setBackgroundInert(true);
        // The auth scope was applied before this dynamically opened dialog existed,
        // so it may have marked the dialog itself inert. The modal scope now owns
        // background inertness; suspend auth's stale snapshot until this dialog closes.
        const authGate = document.getElementById?.('authGate');
        if (authGate && !authGate.classList.contains('hidden')) window.HexiGridInertScopes?.set('auth', false);
        const onKeyDown = event => {
          if (event.key !== 'Tab') return;
          const controls = focusableControls(root);
          if (!controls.length) return;
          const first = controls[0], last = controls[controls.length - 1];
          if (!controls.includes(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        };
        document.addEventListener('keydown', onKeyDown);
        const close = (value) => {
          root.classList.add('hidden'); document.body.classList.remove('overlay-open'); setBackgroundInert(false);
          restoreAuthGateInertness();
          document.removeEventListener('keydown', onKeyDown);
          acceptButton.onclick = null; document.querySelector('#confirmModalCancel').onclick = null;
          opener?.focus?.({ preventScroll: true });
          resolve(value);
        };
        document.querySelector('#confirmModalCancel').onclick = () => close(null);
        acceptButton.onclick = () => {
          for (const control of fieldRoot.querySelectorAll('input,textarea,select')) {
            control.setCustomValidity(control.value && control.minLength > 0 && control.value.length < control.minLength ? `Use at least ${control.minLength} characters.` : '');
            if (!control.reportValidity()) return;
          }
          const values = fields.map((field, index) => { const control = fieldRoot.querySelector(`[data-modal-field="${index}"]`); return field.type === 'checkbox' ? control.checked : control.value; });
          if (fields.some((field, index) => field.required && String(values[index]).trim() === '')) return;
          close(values);
        };
        (fieldRoot.querySelector('input,textarea,select') || focusableControls(root)[0])?.focus();
      });
    }
    return modalRequest;
  }
  window.HexiGridModal = { create };
})();
