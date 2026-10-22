function taskErrorMessage(message) {
  return String(message || 'Task action failed.').replace(/\bspawn_subagents\b/g, 'autonomous tasks');
}

function taskScheduleLabel(seconds) {
  if (!seconds) return 'Once';
  if (seconds % 86400 === 0) return `Every ${seconds / 86400} day${seconds === 86400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `Every ${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `Every ${seconds} seconds`;
}

function taskRunLimit(task) {
  return task.maxRuns === 0 ? `${task.runCount || 0} runs · no run limit` : `${task.runCount || 0} / ${task.maxRuns ?? 1} runs`;
}

function taskScheduleSeconds() {
  const schedule = document.querySelector('#taskSchedule').value;
  return schedule === 'custom' ? Number(document.querySelector('#taskInterval').value) * Number(document.querySelector('#taskIntervalUnit').value) : Number(schedule);
}

function updateTaskSchedule() {
  const schedule = document.querySelector('#taskSchedule').value;
  document.querySelector('#taskRepeatOptions').hidden = schedule === '0';
  document.querySelector('#taskCustomInterval').hidden = schedule !== 'custom';
  document.querySelector('#taskInterval').disabled = schedule !== 'custom';
  document.querySelector('#taskIntervalUnit').disabled = schedule !== 'custom';
  document.querySelector('#taskInterval').max = String(86400 / Number(document.querySelector('#taskIntervalUnit').value));
  document.querySelector('#taskMaxRuns').disabled = schedule === '0';
}

document.querySelector('#taskSchedule').addEventListener('change', updateTaskSchedule);
document.querySelector('#taskIntervalUnit').addEventListener('change', updateTaskSchedule);
updateTaskSchedule();

const pendingTaskRuns = new Set();
let editingTaskId = null;
let taskDraftBeforeEdit = null;
let taskFormSaving = false;
const taskDraftFields = ['taskName', 'taskPrompt', 'taskAgent', 'taskSchedule', 'taskInterval', 'taskIntervalUnit', 'taskMaxRuns', 'taskMaxRetries'];
function taskEditStanding() {
  document.querySelector('#taskAgent').disabled = Boolean(editingTaskId) || taskFormSaving;
  document.querySelector('#taskSubmit').textContent = editingTaskId ? 'Save task changes' : 'Create paused task';
  document.querySelector('#taskFormStanding').textContent = editingTaskId ? 'EDIT PAUSED TASK' : 'NEW TASK';
  document.querySelector('#taskEditCancel').hidden = !editingTaskId;
}
function cancelTaskEdit({ saved = false } = {}) {
  if (taskFormSaving && !saved) return;
  if (taskDraftBeforeEdit) for (const [key, value] of Object.entries(taskDraftBeforeEdit)) document.querySelector('#' + key).value = value;
  editingTaskId = null; taskDraftBeforeEdit = null; taskEditStanding(); updateTaskSchedule();
  document.querySelector('#taskFeedback').textContent = 'Editing cancelled. The saved task is unchanged; your previous draft is restored.';
}


function draftTaskFromGoal() {
  if (editingTaskId) { document.querySelector('#taskFeedback').textContent = 'Save or cancel editing before drafting another task.'; return; }
  const title = String(state.data?.settings?.activeGoal?.title || '').trim();
  if (typeof showView === 'function') showView(title ? 'tasks' : 'access');
  if (!title) { notify('Save a shared goal first, then create a task from it.'); return; }
  const prompt = document.querySelector('#taskPrompt');
  const feedback = document.querySelector('#taskFeedback');
  if (prompt.value.trim()) {
    feedback.textContent = 'Your existing draft is kept. Clear its instructions to use the shared goal, or create this task first.';
    prompt.focus();
    return;
  }
  const name = document.querySelector('#taskName');
  if (!name.value.trim()) name.value = title.slice(0, 120);
  prompt.value = `Work toward this outcome: ${title}\nComplete one bounded step. Report what changed, the evidence and what remains.`;
  // A goal draft is always one manual step, even when the previous form used a schedule.
  document.querySelector('#taskSchedule').value = '0';
  document.querySelector('#taskMaxRetries').value = '0';
  updateTaskSchedule();
  feedback.textContent = 'Goal copied into a one-time draft. Choose an agent and review the instructions. Nothing runs until you create the task and choose Run now.';
  prompt.focus();
  document.querySelector('#taskForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function renderTasks() {
  const goal = String(state.data?.settings?.activeGoal?.title || '').trim();
  const goalContext = document.querySelector('#taskGoalContext');
  if (goalContext) goalContext.textContent = goal ? `Shared goal: ${goal}. Use it to draft a one-time task.` : 'Save a shared goal in Permissions, or write task instructions below.';
  const links = state.data?.agentLinks || [];
  const agents = window.HexiGridViewRenderers.orderAgents(state.data?.agents || [], links);
  const select = document.querySelector('#taskAgent');
  if (select) {
    const selected = select.value || state.data?.agents?.[0]?.id;
    select.innerHTML = agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agentListLabel(agent))} · ${escapeHtml(window.HexiGridViewRenderers.agentSelectionStanding(agent, links))}</option>`).join('') || '<option value="">Add an agent first</option>';
    if (agents.some((agent) => agent.id === selected)) select.value = selected;
  }
  const root = document.querySelector('#taskList');
  if (!root) return;
  const tasks = state.data?.tasks || [];
  root.innerHTML = tasks.map((task) => {
    const target = agents.find((agent) => agent.id === task.agentId);
    const pendingRun = pendingTaskRuns.has(task.id);
    const status = pendingRun && task.status !== 'running' ? 'starting run' : String(task.status || 'paused').replace('_', ' ');
    const waiting = task.status === 'waiting_approval';
    const finished = ['completed', 'cancelled'].includes(task.status);
    const latestText = task.lastError ? taskErrorMessage(task.lastError) : task.lastOutput || task.prompt || '';
    const preview = latestText.length > 240 ? `${latestText.slice(0, 240)}…` : latestText;
    const detail = pendingRun ? 'A run was requested. Stop cancels it; the result will appear when the request finishes.' : waiting ? `Approval requested for ${escapeHtml(target?.name || 'this agent')}. Review the bounded request and approve one run.` : escapeHtml(preview);
    const connectionHelp = /browser-only model/i.test(task.lastError || '')
      ? '<button type="button" class="secondary-button" data-task-local-model>Choose local AI connection</button>'
      : /provider returned no text/i.test(task.lastError || '')
        ? '<button type="button" class="secondary-button" data-view-target="providers">Review AI connection</button>'
      : task.lastError && /selected local AI connection is unavailable|selected local harness is not connected|choose a model in Connections/i.test(task.lastError)
        ? '<button type="button" class="secondary-button" data-view-target="providers">Choose AI connection</button>' : '';
    const expiry = waiting && task.approvalExpiresAt ? `<span>approval expires ${escapeHtml(new Date(task.approvalExpiresAt).toLocaleString())}</span>` : '';
    return `<article class="task-item"><div><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(target?.name || 'Missing agent')} · ${escapeHtml(status)}</small></div><p>${detail}</p><div class="task-meta"><span>${escapeHtml(taskRunLimit(task))}</span><span>${escapeHtml(taskScheduleLabel(task.intervalSeconds))}</span><span>${task.retryCount || 0} / ${task.maxRetries || 0} retries</span>${expiry}</div><details class="task-instructions"><summary>Instructions</summary><p>${escapeHtml(task.prompt)}</p></details>${window.HexiGridViewRenderers.taskHistoryHtml(task, state.data?.taskRuns)}<div class="provider-actions">${connectionHelp}<button class="secondary-button" data-task-run="${task.id}" ${pendingRun || ['running', 'completed', 'cancelled'].includes(task.status) ? 'disabled' : ''}>${pendingRun ? 'Running...' : 'Run now'}</button>${!finished ? `<button class="secondary-button" data-task-edit="${task.id}" ${pendingRun || task.status === 'running' ? 'disabled' : ''}>Edit</button>` : ''}${finished ? `<button class="secondary-button" data-task-copy="${task.id}">Use again</button>` : `<button class="secondary-button" data-task-toggle="${task.id}" ${pendingRun ? 'disabled' : ''} data-task-status="${task.status === 'running' ? 'paused' : 'running'}">${task.status === 'running' ? 'Pause' : 'Start'}</button>`}<button class="ghost-button" data-task-cancel="${task.id}" ${['completed', 'cancelled'].includes(task.status) ? 'disabled' : ''}>Stop</button></div></article>`;
  }).join('') || (agents.length
    ? '<div class="empty-state"><strong>No tasks yet</strong><p>Use the task form on this page. New tasks start paused.</p></div>'
    : '<div class="empty-state"><strong>No tasks yet</strong><p>Create or connect an agent first. Then return here to set up a task. New tasks start paused.</p><button type="button" class="secondary-button" data-view-target="agents">Create or connect an agent</button></div>');
  window.HexiGridHarnessJobUi?.render();
}

async function taskRequest(id, action, extra) {
  if (action === 'run' && pendingTaskRuns.has(id)) return;
  if (action === 'run') { pendingTaskRuns.add(id); renderTasks(); }
  let approval = false;
  try {
    const request = api(`/api/tasks/${id}/${action}`, { method: 'POST', body: JSON.stringify(extra || {}) });
    // Observe the server while the invocation is pending; this is state only,
    // never a second model request. A failed refresh cannot discard the run.
    request.catch(() => {});
    if (action === 'run') await refresh().catch(() => {});
    await request;
    await refresh();
  } catch (error) {
    await refresh().catch(() => {});
    // A cancelled invocation is an expected result, not a broken connection.
    if (action === 'run' && state.data?.tasks?.find(task => task.id === id)?.status === 'cancelled') return;
    approval = !extra?.approved && error.body?.approvalRequired && window.hexigridModal
      && await window.hexigridModal({ title: 'Approve task action?', message: error.message, accept: 'Approve once', danger: true });
    if (!approval) notify(taskErrorMessage(error.message), true);
  } finally {
    if (action === 'run') { pendingTaskRuns.delete(id); renderTasks(); }
  }
  if (approval) return taskRequest(id, action, { ...(extra || {}), approved: true });
}

document.querySelector('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (taskFormSaving) return;
  taskFormSaving = true;
  for (const key of taskDraftFields) document.querySelector('#' + key).disabled = true;
  document.querySelector('#taskSubmit').disabled = true;
  document.querySelector('#taskEditCancel').disabled = true;
  try {
    const editId = editingTaskId;
    await api(editId ? `/api/tasks/${editId}` : '/api/tasks', { method: editId ? 'PATCH' : 'POST', body: JSON.stringify({ ...(editId ? {status:'paused'} : {agentId:document.querySelector('#taskAgent').value}), name: document.querySelector('#taskName').value, prompt: document.querySelector('#taskPrompt').value, intervalSeconds: taskScheduleSeconds(), maxRuns: taskScheduleSeconds() === 0 ? 1 : Number(document.querySelector('#taskMaxRuns').value), maxRetries: Number(document.querySelector('#taskMaxRetries').value) }) });
    if (editId) { cancelTaskEdit({ saved: true }); document.querySelector('#taskFeedback').textContent = 'Changes saved. Task stays paused; its run history is kept.'; }
    else document.querySelector('#taskFeedback').textContent = 'Created paused. Start it after choosing the right mode and approval level.';
    await refresh();
  } catch (error) { document.querySelector('#taskFeedback').textContent = error.message; }
  finally {
    taskFormSaving = false;
    for (const key of taskDraftFields) document.querySelector('#' + key).disabled = false;
    document.querySelector('#taskSubmit').disabled = false;
    document.querySelector('#taskEditCancel').disabled = false;
    updateTaskSchedule(); taskEditStanding();
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-task-edit],[data-task-edit-cancel],[data-task-local-model],[data-task-from-goal],[data-control-action="refresh-tasks"],[data-task-run],[data-task-toggle],[data-task-cancel],[data-task-copy]');
  if (!target) return;
  if (target.dataset.taskEditCancel !== undefined) return cancelTaskEdit();
  if (target.dataset.taskLocalModel !== undefined) {
    if (typeof setConnectionKind === 'function') setConnectionKind('local');
    if (typeof showView === 'function') showView('providers');
    return;
  }
  if (target.dataset.taskFromGoal !== undefined) return draftTaskFromGoal();
  if (target.dataset.controlAction === 'refresh-tasks') return refresh();
  if (target.dataset.taskRun) return taskRequest(target.dataset.taskRun, 'run');
  if (target.dataset.taskCancel) return taskRequest(target.dataset.taskCancel, 'cancel');
  if (target.dataset.taskCopy || target.dataset.taskEdit) {
    if (taskFormSaving) return;
    if (editingTaskId) { document.querySelector('#taskFeedback').textContent = 'Save or cancel editing before opening another task.'; return; }
    const task = state.data?.tasks?.find((item) => item.id === (target.dataset.taskEdit || target.dataset.taskCopy));
    if (!task) return;
    if (target.dataset.taskEdit) {
      if (pendingTaskRuns.has(task.id) || ['running', 'completed', 'cancelled'].includes(task.status)) return;
      taskDraftBeforeEdit = Object.fromEntries(taskDraftFields.map(key => [key, document.querySelector('#' + key).value]));
      editingTaskId = task.id;
    }
    taskEditStanding();
    document.querySelector('#taskName').value = task.name;
    document.querySelector('#taskPrompt').value = task.prompt;
    document.querySelector('#taskAgent').value = task.agentId;
    const seconds = task.intervalSeconds || 0;
    document.querySelector('#taskSchedule').value = [0, 900, 3600, 86400].includes(seconds) ? String(seconds) : 'custom';
    document.querySelector('#taskInterval').value = seconds ? seconds % 60 === 0 ? seconds / 60 : seconds : 60;
    document.querySelector('#taskIntervalUnit').value = seconds && seconds % 60 !== 0 ? '1' : '60';
    document.querySelector('#taskMaxRuns').value = task.maxRuns ?? 10;
    document.querySelector('#taskMaxRetries').value = task.maxRetries || 0;
    updateTaskSchedule();
    document.querySelector('#taskFeedback').textContent = editingTaskId ? 'Edit this task, then save it paused. The assigned agent and run history stay the same.' : 'Loaded a copy. Review it and create a new paused task; the original history is kept.';
    document.querySelector('#taskName').focus({ preventScroll: true });
    document.querySelector('#taskForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  if (!target.dataset.taskToggle) return;
  try {
    await api(`/api/tasks/${target.dataset.taskToggle}`, { method: 'PATCH', body: JSON.stringify({ status: target.dataset.taskStatus }) });
    await refresh();
  } catch (error) {
    if (error.body?.approvalRequired && window.hexigridModal && await window.hexigridModal({ title: 'Approve starting this task?', message: error.message, accept: 'Approve once', danger: true })) {
      try {
        await api(`/api/tasks/${target.dataset.taskToggle}`, { method: 'PATCH', body: JSON.stringify({ status: target.dataset.taskStatus, approved: true }) });
        await refresh();
      } catch (approvedError) { notify(approvedError.message, true); }
    } else notify(error.message, true);
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-control-action="emergency-stop"]');
  if (!button) return;
  event.stopImmediatePropagation();
  const accepted = window.hexigridModal && await window.hexigridModal({ title: 'Stop all autonomous work?', message: 'This pauses tasks and automatic memory learning, cancels active replies and tool jobs, stops managed Runners, and ends computer access and live calls. Nothing is deleted. Resume only the work and access you want afterward.', accept: 'Stop everything', danger: true });
  if (!accepted) return;
  try {
    const result = await api('/api/emergency/stop', { method: 'POST', body: JSON.stringify({}) });
    notify(`Work stopped: ${result.pausedTasks} task(s) paused. Computer access and calls ended; automatic memory learning paused.`);
    await refresh();
  } catch (error) { notify(error.message, true); }
}, true);
