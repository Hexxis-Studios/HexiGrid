const taskRoot = document.createElement('section');
taskRoot.id = 'view-tasks';
taskRoot.className = 'view';
taskRoot.innerHTML = `<div class="page-intro"><div><div class="eyebrow">AUTONOMOUS WORK</div><h2>Bounded tasks</h2><p>Give an agent one repeatable outcome, choose its limits, then pause or stop it whenever you want.</p></div><span class="status-badge">LOCAL WORKER</span></div>
<div class="task-workbench"><form id="taskForm" class="panel stack-form"><div class="eyebrow" id="taskFormStanding">NEW TASK</div><h3>What should keep moving?</h3><div class="task-goal-draft"><p id="taskGoalContext" class="panel-copy"></p><button type="button" class="secondary-button" data-task-from-goal>Use shared goal</button></div><label>Name<input id="taskName" maxlength="120" placeholder="Daily research check" required></label><label>Agent<select id="taskAgent" required></select></label><label>Instructions<textarea id="taskPrompt" rows="6" placeholder="Check the approved source, compare changes, and write a short note in the workspace." required></textarea></label><label>When<select id="taskSchedule"><option value="0">Once</option><option value="900">Every 15 minutes</option><option value="3600">Every hour</option><option value="86400">Every day</option><option value="custom">Custom interval</option></select></label><div id="taskRepeatOptions" class="form-grid two-col" hidden><label id="taskCustomInterval" hidden>Interval<input id="taskInterval" type="number" min="1" max="1440" step="1" value="60"><select id="taskIntervalUnit" aria-label="Interval unit"><option value="60">Minutes</option><option value="3600">Hours</option><option value="1">Seconds</option></select></label><label>Stop after this many runs<input id="taskMaxRuns" type="number" min="0" max="10000" step="1" value="10"><small>0 means no run limit; the schedule continues until paused or stopped.</small></label></div><details><summary>Retry options</summary><label>Retries after a failure<input id="taskMaxRetries" type="number" min="0" max="10" step="1" value="0"></label><p class="panel-copy">Retries wait progressively longer, up to five minutes.</p></details><p class="panel-copy">Created paused. Run it once or start its schedule when ready. Each run uses the current mode, permissions and approval profile.</p><button id="taskSubmit" class="primary-button" type="submit">Create paused task</button><button type="button" id="taskEditCancel" class="text-button" data-task-edit-cancel hidden>Cancel editing</button><p id="taskFeedback" role="status"></p></form><div class="panel"><div class="panel-heading"><div><div class="eyebrow">TASKS</div><h3>What is running</h3></div><button class="ghost-button" data-control-action="refresh-tasks">Refresh</button></div><div id="taskList"></div></div></div>`;
document.querySelector('.main-content').append(taskRoot);
taskRoot.querySelector('.page-intro').insertAdjacentHTML('beforeend', '<button class="danger-button secondary-button" data-control-action="emergency-stop">Emergency stop all</button>');
taskRoot.insertAdjacentHTML('beforeend', `<section id="harnessJobPanel" class="panel one-shot-panel" aria-labelledby="harnessJobHeading"><div class="panel-heading"><div><div class="eyebrow">ONE-SHOT LOCAL JOB</div><h3 id="harnessJobHeading">Run one harness job</h3></div></div><form id="harnessJobForm" class="stack-form"><label>Local agent<select id="harnessJobAgent" required></select></label><label>Prompt · up to 8,000 characters<textarea id="harnessJobPrompt" rows="5" maxlength="8000" required placeholder="Describe one bounded request for this agent."></textarea></label><p class="panel-copy">Choose a local profile; its selected AI connection still controls routing and cost. Jobs remain available for manual recovery for up to 30 minutes. After reloading, choose Load recent jobs and open one to restore its status and output. Opening never runs it again; progress is checked manually.</p><div class="provider-actions"><button id="harnessJobRun" class="primary-button" type="submit">Run once</button><button id="harnessJobCheck" class="secondary-button" type="button" disabled>Check progress</button><button id="harnessJobStop" class="ghost-button" type="button" disabled>Stop current job</button></div><div class="provider-actions"><button id="harnessJobLoadRecent" class="secondary-button" type="button">Load recent jobs</button><label>Recent local jobs<select id="harnessJobRecent"><option value="">Load recent jobs to choose</option></select></label><button id="harnessJobOpenRecent" class="secondary-button" type="button" disabled>Open selected job</button></div></form><p id="harnessJobFeedback" role="status"></p><p id="harnessJobStatus" class="panel-copy" role="status" aria-live="polite">No current job selected. After reload, load recent jobs and open one manually.</p><p id="harnessJobError" class="panel-copy"></p><details><summary>Latest output</summary><pre id="harnessJobOutput"></pre></details></section>`);

const pluginRoot = document.createElement('section');
pluginRoot.id = 'view-plugins';
pluginRoot.className = 'view';
pluginRoot.innerHTML = `<div class="page-intro"><div><div class="eyebrow">PLUGINS & TOOLS</div><h2>Plugins and tools</h2><p>Install a verified package, review each exact capability, and enable it only when the access makes sense.</p></div><span class="status-badge">BROKERED SANDBOX</span></div>
<section class="panel"><div class="panel-heading"><div><div class="eyebrow">MCP TOOL SERVERS</div><h3>Connect agent tools</h3></div></div><p class="panel-copy">Add tool servers and review their tools in Settings → Connections. New servers start disabled.</p><button class="secondary-button" type="button" data-view-target="integrations" data-open-mcp-tools>Open MCP tools</button></section>
<div class="plugin-workbench"><form id="pluginForm" class="panel stack-form"><div class="eyebrow">INSTALL VERSION 2 PACKAGE</div><h3>Add a local plugin</h3><p class="panel-copy">Choose plugin.json and all package files. Signed publishers are verified with Ed25519. Unsigned local packages require an explicit owner review.</p><input id="pluginFiles" type="file" multiple accept=".json,.js,.mjs" required><label class="toggle-row"><span><strong>I created or reviewed this unsigned package</strong><small>Leave off for a publisher-signed package. This never weakens its sandbox.</small></span><input id="pluginLocalTrust" type="checkbox"></label><button class="primary-button" type="submit">Verify, install, and review</button><p id="pluginFeedback" role="status"></p></form><div class="panel"><div class="panel-heading"><div><div class="eyebrow">INSTALLED</div><h3>Verified capabilities</h3></div><button class="ghost-button" data-control-action="refresh-plugins">Refresh</button></div><div id="pluginList"></div><div class="section-heading compact-heading"><div><div class="eyebrow">TRUSTED PUBLISHERS</div><h3>Signing keys</h3></div></div><div id="pluginPublisherList"></div></div></div>`;
document.querySelector('.main-content').append(pluginRoot);
pluginRoot.querySelector('[data-open-mcp-tools]').addEventListener('click', () => {
  requestAnimationFrame(() => {
    const heading = document.querySelector('#mcpToolsHeading');
    if (!heading) return;
    (document.querySelector('#mcpToolsSection') || heading).scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  });
});
const hexikeysPanel = document.createElement('section');
hexikeysPanel.className = 'panel';
hexikeysPanel.setAttribute('data-hexikeys-addon', '');
pluginRoot.querySelector('.plugin-workbench').before(hexikeysPanel);
document.querySelector('#pluginFiles').setAttribute('webkitdirectory', '');
document.querySelector('#pluginFiles').setAttribute('directory', '');
protectHostOnlyControls(document.querySelector('#pluginForm'), 'Install plugin bundles only on the computer running HexiGrid. Remote devices can review, enable, disable, and run already-installed capabilities within policy.');

const subagentPanel = [...document.querySelectorAll('#view-access .panel')].find((panel) => panel.querySelector('.eyebrow')?.textContent === 'SUBAGENTS');
if (subagentPanel && !subagentPanel.querySelector('#subagentsEnabled')) subagentPanel.insertAdjacentHTML('beforeend', '<label class="toggle-row"><span><strong>Allow subagents</strong><small>Agents may create focused helpers.</small></span><input id="subagentsEnabled" type="checkbox"></label><label class="range-row"><span>Maximum running at once</span><input id="subagentLimit" type="number" min="1" max="16" value="4"></label><button class="secondary-button full-button" data-action="save-subagents">Save subagent settings</button>');

const settingsGrid = document.querySelector('#view-settings .settings-grid');
const securityPanel = document.createElement('div');
securityPanel.id = 'securityTools';
securityPanel.className = 'panel security-tools';
settingsGrid.append(securityPanel);
const releasePanel = document.createElement('section');
releasePanel.id = 'localReleaseRecovery';
releasePanel.className = 'panel security-tools local-release-tools';
releasePanel.setAttribute('aria-labelledby', 'localReleaseHeading');
settingsGrid.append(releasePanel);
const syncPanel = document.createElement('div');
syncPanel.id = 'syncTools';
syncPanel.className = 'panel security-tools';
settingsGrid.append(syncPanel);

(() => {
  const primary = [
    { view: 'overview', label: 'Home', icon: 'home' },
    { view: 'agents', label: 'Agents', icon: 'agents' },
    { view: 'room', label: 'Chat', icon: 'chat' },
    { view: 'live', label: 'Calls', icon: 'phone' },
    { view: 'memory', label: 'Memory', icon: 'models' },
    { view: 'workspace', label: 'Workspace', icon: 'folder' },
    { view: 'settings', label: 'Settings', icon: 'settings' }
  ];
  const settingsGroups = [
    {
      label: 'Connections',
      views: [
        { view: 'providers', label: 'AI providers', icon: 'link' },
        { view: 'integrations', label: 'Tools & integrations', icon: 'tools' },
        { view: 'setup', label: 'Accounts & devices', icon: 'device' }
      ]
    },
    {
      label: 'Usage & activity',
      views: [
        { view: 'usage', label: 'AI usage', icon: 'usage' },
        { view: 'activity', label: 'Activity', icon: 'activity' }
      ]
    },
    {
      label: 'Agent settings',
      views: [
        { view: 'models', label: 'AI models', icon: 'models' },
        { view: 'assistant', label: 'Assistant', icon: 'assistant' },
        { view: 'access', label: 'Permissions', icon: 'shield' },
        { view: 'tasks', label: 'Tasks', icon: 'tasks' },
        { view: 'plugins', label: 'Plugins & tools', icon: 'plugin' }
      ]
    },
    {
      label: 'Help',
      views: [
        { view: 'guide', label: 'Help', icon: 'help' },
        { view: 'communication', label: 'How agents talk', icon: 'speech' }
      ],
      links: [{ href: '/agent-interface.html', label: 'Agent interface', icon: 'assistant' }]
    }
  ];

  function install() {
    const nav = document.querySelector('.primary-nav');
    if (!nav || nav.dataset.simpleNavigation === 'true') return;
    const agentCount = nav.querySelector('#agentCountNav');
    const settingsSubmenu = document.createElement('div');
    settingsSubmenu.className = 'settings-nav-submenu settings-page-nav';
    settingsSubmenu.id = 'settingsNavigationItems';
    settingsSubmenu.hidden = true;
    settingsSubmenu.setAttribute('aria-label', 'Settings pages');
    const settingsViews = new Set(['settings']);
    const makeIcon = (name) => window.HexiIcons?.make(name) || document.createElement('span');
    const makeViewButton = (item, isPrimary = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-item';
      button.dataset.view = item.view;
      button.title = item.label;
      button.setAttribute('aria-label', item.label);
      if (isPrimary) button.dataset.primaryView = 'true';
      const label = document.createElement('span');
      label.className = 'nav-label';
      label.textContent = item.label;
      button.append(makeIcon(item.icon), label);
      if (item.view === 'agents' && agentCount) button.append(agentCount);
      return button;
    };

    nav.replaceChildren();
    for (const item of primary) {
      const button = makeViewButton(item, true);
      nav.append(button);
    }
    document.querySelector('#view-settings .settings-grid').before(settingsSubmenu);

    for (const group of settingsGroups) {
      const details = document.createElement('details');
      details.className = 'settings-nav-group';
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = group.label;
      const items = document.createElement('div');
      items.className = 'settings-nav-group-items';
      details.append(summary, items);
      for (const item of group.views || []) {
        settingsViews.add(item.view);
        items.append(makeViewButton(item));
      }
      for (const item of group.links || []) {
        const link = document.createElement('a');
        link.className = 'nav-item nav-link';
        link.href = item.href;
        link.title = item.label;
        link.append(makeIcon(item.icon), document.createTextNode(item.label));
        items.append(link);
      }
      settingsSubmenu.append(details);
    }

    function activate(view) {
      const inSettings = settingsViews.has(view);
      document.body.classList.toggle('settings-detail', inSettings && view !== 'settings');
      settingsSubmenu.hidden = view !== 'settings';
      nav.querySelectorAll('[data-view]').forEach((button) => {
        const active = button.dataset.view === view || (button.dataset.view === 'settings' && inSettings);
        button.classList.toggle('active', active);
        if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    }

    nav.dataset.simpleNavigation = 'true';
    window.HexiGridNavigation = Object.freeze({ activate });
    activate(window.location.hash.slice(1) || 'overview');
  }

  if (document.readyState === 'loading' || document.readyState === 'interactive') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else install();
})();
