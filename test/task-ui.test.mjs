import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/task-ui.js', import.meta.url), 'utf8');
const rendererSource = await fs.readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
function ui() {
  const elements = new Map(), clicks = [], calls = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', listeners: {}, addEventListener(type, cb) { this.listeners[type] = cb; }, focus() {}, scrollIntoView() {} });
    return elements.get(id);
  }
  element('#taskSchedule').value = '0'; element('#taskInterval').value = '60'; element('#taskIntervalUnit').value = '60';
  element('#taskMaxRuns').value = '10'; element('#taskMaxRetries').value = '0';
  const context = { document: { querySelector: element, addEventListener: (type, cb) => { if (type === 'click') clicks.push(cb); } },
    state: { data: { agents: [{ id: 'agent-a', name: 'A' }, { id: 'agent-b', name: 'B' }], tasks: [] } },
    api: async (path, options) => { calls.push({ path, method: options.method, body: JSON.parse(options.body) }); }, refresh: async () => {}, notify: () => {}, window: {},
    escapeHtml: (value) => String(value).replaceAll('<', '&lt;'), agentListLabel: (agent) => agent.name };
  vm.runInNewContext(rendererSource, context);
  vm.runInNewContext(source, context);
  return { context, element, calls, clicks };
}

test('one-time form sends a bounded single run and recurring presets use real seconds', async () => {
  const qa = ui(); qa.element('#taskAgent').value = 'agent-b'; qa.element('#taskPrompt').value = 'Check local notes';
  await qa.element('#taskForm').listeners.submit({ preventDefault() {} });
  assert.equal(qa.calls[0].body.intervalSeconds, 0); assert.equal(qa.calls[0].body.maxRuns, 1);
  assert.equal(qa.element('#taskRepeatOptions').hidden, true);
  qa.element('#taskSchedule').value = '3600'; qa.context.updateTaskSchedule();
  assert.equal(qa.element('#taskRepeatOptions').hidden, false); assert.equal(qa.element('#taskInterval').disabled, true);
  await qa.element('#taskForm').listeners.submit({ preventDefault() {} });
  assert.equal(qa.calls[1].body.intervalSeconds, 3600); assert.equal(qa.calls[1].body.maxRuns, 10);
  qa.element('#taskSchedule').value = 'custom'; qa.element('#taskInterval').value = '2'; qa.element('#taskIntervalUnit').value = '3600';
  qa.context.updateTaskSchedule(); assert.equal(qa.context.taskScheduleSeconds(), 7200); assert.equal(qa.element('#taskInterval').max, '24');
});

test('empty task list points to the task form or agent setup as appropriate', () => {
  const qa = ui();
  qa.context.renderTasks();
  let html = qa.element('#taskList').innerHTML;
  assert.match(html, /Use the task form on this page/);
  assert.match(html, /New tasks start paused/);
  assert.doesNotMatch(html, /data-view-target="agents"/);

  qa.context.state.data.agents = [];
  qa.context.renderTasks();
  html = qa.element('#taskList').innerHTML;
  assert.match(html, /Create or connect an agent first/);
  assert.match(html, /data-view-target="agents"/);
  assert.match(html, /New tasks start paused/);
});

test('owner and agent readers retain completed results alongside errors and exact bounded run history', () => {
  const qa = ui();
  const task = { id: 'qa', agentId: 'agent-a', name: 'QA', prompt: 'Instructions', status: 'failed', maxRuns: 3,
    lastError: 'Latest attempt failed', lastOutput: '<completed>Earlier result</completed>' };
  const runs = [
    { id: 'latest', taskId: task.id, status: 'failed', error: '<error>Failure</error>', output: 'Retained partial result', startedAt: '2026-10-03' },
    { id: 'interrupted', taskId: task.id, status: 'interrupted', error: 'Restarted', output: '' },
    { id: 'active', taskId: task.id, status: 'running', output: '' },
    ...Array.from({ length: 10 }, (_, index) => ({ id: `older-${index}`, taskId: task.id, status: 'completed', output: `Previous result ${index}` })),
    { id: 'foreign', taskId: 'foreign-task', status: 'completed', output: 'Foreign output must not appear' }
  ];
  qa.context.state.data.tasks = [task]; qa.context.state.data.taskRuns = runs;
  qa.context.renderTasks();
  const owner = qa.element('#taskList').innerHTML;
  const agent = qa.context.window.HexiGridViewRenderers.agentWorkRecords(qa.context.state.data).tasks;
  for (const html of [owner, agent]) {
    assert.match(html, /Latest attempt failed/);
    assert.match(html, /Last completed result/);
    assert.match(html, /&lt;completed&gt;Earlier result/);
    assert.match(html, /Recent runs \(10\)/);
    assert.match(html, /&lt;error&gt;Failure/);
    assert.match(html, /Retained partial result/);
    assert.match(html, /Execution is in progress; no completed result yet/);
    assert.match(html, /interrupted/);
    assert.doesNotMatch(html, /<completed>|<error>|Foreign output|older-9/);
  }
  assert.equal(qa.calls.length, 0, 'reading retained results never executes a task');
  task.lastError = ''; task.lastOutput = 'Long result '.repeat(100);
  qa.context.renderTasks();
  const bounded = qa.element('#taskList').innerHTML;
  const preview = bounded.match(/<p>(.*?)<\/p>/s)[1];
  assert.equal(preview.length, 241);
  assert.ok(preview.endsWith('…'));
  assert.ok(bounded.includes(`<pre>${task.lastOutput}</pre>`), 'the full completed result remains available on expansion');
});

test('task picker prioritizes paired/local profiles while preserving exact selection and exposing idle/unlinked standing', () => {
  const qa=ui();
  qa.context.state.data.agents=[{id:'old',name:'ExampleAgent old',transport:'agent-link',status:'connected'}, {id:'local',name:'Codex',status:'local_ready'}, {id:'paired',name:'ExampleAgent current',transport:'local-opencode'}];
  qa.context.state.data.agentLinks=[{agentId:'old',authorizationStatus:'revoked',heartbeat:{state:'online'}},{agentId:'paired',authorizationStatus:'connected',heartbeat:{state:'offline'}}];
  qa.element('#taskAgent').value='local'; qa.context.renderTasks();
  const html=qa.element('#taskAgent').innerHTML;
  assert.ok(html.indexOf('value="paired"')<html.indexOf('value="local"'));
  assert.ok(html.indexOf('value="local"')<html.indexOf('value="old"'));
  assert.match(html,/ExampleAgent current · Paired · heartbeat idle/);
  assert.match(html,/ExampleAgent old · No active link/);
  assert.match(html,/Codex · Local ready/);
  assert.equal(qa.element('#taskAgent').value,'local');
  assert.equal(qa.calls.length,0);
  qa.element('#taskAgent').value=''; qa.context.renderTasks();
  assert.equal(qa.element('#taskAgent').value,'old','sorting does not silently change the original default agent');
});

test('refresh preserves the selected agent and completed tasks offer a copy without changing history', async () => {
  const qa = ui(); qa.element('#taskAgent').value = 'agent-b';
  const task = { id: 'task-a', agentId: 'agent-b', name: 'Notes', prompt: '<private instructions>', intervalSeconds: 5, maxRuns: 2, maxRetries: 1, status: 'completed', runCount: 2 };
  qa.context.state.data.tasks = [task]; qa.context.renderTasks();
  assert.equal(qa.element('#taskAgent').value, 'agent-b');
  assert.match(qa.element('#taskList').innerHTML, /data-task-copy="task-a"/); assert.doesNotMatch(qa.element('#taskList').innerHTML, /data-task-toggle/);
  assert.match(qa.element('#taskList').innerHTML, /&lt;private instructions>/);
  await qa.clicks[0]({ target: { closest: () => ({ dataset: { taskCopy: 'task-a' } }) } });
  assert.equal(qa.element('#taskPrompt').value, task.prompt); assert.equal(qa.context.taskScheduleSeconds(), 5);
  assert.equal(qa.calls.length, 0); assert.equal(task.status, 'completed'); assert.equal(task.runCount, 2);
});

test('denied task run refreshes authoritative standing and retains the original error', async () => {
  const qa = ui(), messages = [];
  const task = { id: 'qa', agentId: 'agent-a', name: 'QA', prompt: 'Reply only', status: 'paused', maxRuns: 1 };
  qa.context.state.data.tasks = [task];
  qa.context.api = async () => { throw new Error('Connect mode blocks task execution.'); };
  qa.context.refresh = async () => { task.status = 'blocked'; task.lastError = 'Connect mode blocks task execution.'; qa.context.renderTasks(); };
  qa.context.notify = message => messages.push(message);
  await qa.context.taskRequest('qa', 'run');
  assert.match(qa.element('#taskList').innerHTML, /blocked/);
  assert.deepEqual(messages, ['Connect mode blocks task execution.']);
  qa.context.refresh = async () => { throw new Error('Refresh unavailable'); };
  await qa.context.taskRequest('qa', 'run');
  assert.equal(messages[1], messages[0], 'refresh failure must not replace the actual execution error');
  assert.equal(qa.context.taskErrorMessage('Connect mode does not permit spawn_subagents.'), 'Connect mode does not permit autonomous tasks.');
});

test('model-unavailable tasks expose setup without confusing policy failures with connection failures', () => {
  const qa = ui();
  const task = { id: 'qa', agentId: 'agent-a', name: 'QA', prompt: 'Keep these instructions', status: 'failed', maxRuns: 1,
    lastError: 'The selected local AI connection is unavailable: The selected local harness is not connected. Choose a model in Connections.' };
  qa.context.state.data.tasks = [task]; qa.context.renderTasks();
  assert.match(qa.element('#taskList').innerHTML, /data-view-target="providers">Choose AI connection/);
  assert.match(qa.element('#taskList').innerHTML, /Keep these instructions/);
  task.lastError = 'Provider returned no text. Check that this model supports text chat.'; qa.context.renderTasks();
  assert.match(qa.element('#taskList').innerHTML, /data-view-target="providers">Review AI connection/);
  task.lastError = 'Connect mode blocks task execution.'; qa.context.renderTasks();
  assert.doesNotMatch(qa.element('#taskList').innerHTML, /(?:Choose|Review) AI connection/);
  assert.equal(qa.calls.length, 0);
});

test('pending execution exposes progress, suppresses duplicate runs and permits cancellation', async () => {
  const qa = ui();
  qa.context.state.data.tasks = [{ id: 'qa', agentId: 'agent-a', name: 'QA', prompt: 'Reply only', status: 'paused', maxRuns: 1 }];
  let finish;
  qa.context.api = async (path) => {
    qa.calls.push(path);
    if (path.endsWith('/run')) await new Promise(resolve => { finish = resolve; });
  };
  const first = qa.context.taskRequest('qa', 'run');
  await Promise.resolve();
  assert.match(qa.element('#taskList').innerHTML, /starting run/);
  assert.match(qa.element('#taskList').innerHTML, /disabled>Running\.\.\./);
  await qa.context.taskRequest('qa', 'run');
  await qa.context.taskRequest('qa', 'cancel');
  assert.deepEqual(qa.calls, ['/api/tasks/qa/run', '/api/tasks/qa/cancel']);
  finish(); await first;
  assert.doesNotMatch(qa.element('#taskList').innerHTML, /starting run/);
});

test('deliberate cancellation does not report a broken model connection', async () => {
  const qa = ui(), notices = [];
  qa.context.state.data.tasks = [{ id: 'qa', agentId: 'agent-a', status: 'running', prompt: 'Reply only' }];
  qa.context.api = async () => { throw new Error('The selected local AI connection is unavailable: The agent run was stopped.'); };
  qa.context.refresh = async () => { qa.context.state.data.tasks[0].status = 'cancelled'; };
  qa.context.notify = message => notices.push(message);
  await qa.context.taskRequest('qa', 'run');
  assert.deepEqual(notices, []);
  assert.match(qa.element('#taskList').innerHTML, /cancelled/);
});

test('Use again preserves unlimited and bounded schedule limits and reveals instructions after an error',async()=>{
  for (const maxRuns of [0,1,37]) {
    const qa=ui();
    const task={id:'task-qa',agentId:'agent-b',name:'QA',prompt:'<original instructions>',intervalSeconds:3600,maxRuns,maxRetries:0,status:'cancelled',runCount:0,lastError:'A previous error'};
    qa.context.state.data.tasks=[task];qa.context.renderTasks();
    assert.match(qa.element('#taskList').innerHTML,/<summary>Instructions<\/summary><p>&lt;original instructions>/);
    if(maxRuns===0)assert.match(qa.element('#taskList').innerHTML,/no run limit/);
    await qa.clicks[0]({target:{closest:()=>({dataset:{taskCopy:task.id}})}});
    assert.equal(Number(qa.element('#taskMaxRuns').value),maxRuns);
    assert.equal(qa.element('#taskPrompt').value,task.prompt);
    assert.equal(qa.context.taskScheduleSeconds(),3600);
    assert.equal(qa.calls.length,0,'loading a copy does not mutate or execute');
    await qa.element('#taskForm').listeners.submit({preventDefault(){}});
    assert.equal(qa.calls[0].body.maxRuns,maxRuns);assert.equal(task.status,'cancelled');
  }
});


test('shared goal becomes a bounded draft without dispatch or schedule carryover', () => {
  const qa = ui(); const views = [];
  qa.context.showView = view => views.push(view);
  qa.context.state.data.settings = { activeGoal: { title: 'Inspect synthetic notes' } };
  qa.element('#taskSchedule').value = '3600'; qa.element('#taskMaxRetries').value = '3';
  qa.context.draftTaskFromGoal();
  assert.deepEqual(views, ['tasks']);
  assert.equal(qa.element('#taskName').value, 'Inspect synthetic notes');
  assert.match(qa.element('#taskPrompt').value, /Inspect synthetic notes/);
  assert.equal(qa.context.taskScheduleSeconds(), 0);
  assert.equal(qa.element('#taskMaxRetries').value, '0');
  assert.match(qa.element('#taskFeedback').textContent, /Nothing runs/);
  assert.equal(qa.calls.length, 0);
});

test('goal draft preserves existing instructions, name and selected agent', () => {
  const qa = ui(); qa.context.state.data.settings = { activeGoal: { title: 'New outcome' } };
  qa.element('#taskName').value = 'My draft'; qa.element('#taskAgent').value = 'agent-b';
  qa.element('#taskPrompt').value = 'Keep my instructions'; qa.element('#taskSchedule').value = '3600';
  qa.context.draftTaskFromGoal();
  assert.equal(qa.element('#taskPrompt').value, 'Keep my instructions');
  assert.equal(qa.element('#taskName').value, 'My draft');
  assert.equal(qa.element('#taskAgent').value, 'agent-b');
  assert.equal(qa.context.taskScheduleSeconds(), 3600);
  assert.match(qa.element('#taskFeedback').textContent, /existing draft is kept/);
  assert.equal(qa.calls.length, 0);
});

test('missing shared goal goes to setup without drafting or dispatching', () => {
  const qa = ui(); const views = [], messages = [];
  qa.context.showView = view => views.push(view); qa.context.notify = message => messages.push(message);
  qa.context.draftTaskFromGoal();
  assert.deepEqual(views, ['access']); assert.match(messages[0], /Save a shared goal first/);
  assert.equal(qa.element('#taskPrompt').value, ''); assert.equal(qa.calls.length, 0);
});


test('browser-only background failure offers the existing AI connection setup', () => {
  const qa = ui(); qa.context.state.data.tasks = [{ id: 'qa', name: 'Goal step', agentId: 'agent-a', status: 'blocked', prompt: 'Retained step', lastError: 'This agent uses a browser-only model. Background tasks need a model service or CLI connection on this computer.' }];
  qa.context.renderTasks();
  assert.match(qa.element('#taskList').innerHTML, /data-task-local-model>Choose local AI connection/);
  assert.match(qa.element('#taskList').innerHTML, /Retained step/);
  assert.equal(qa.calls.length, 0);
});


test('background setup opens the no-cost local provider path without calling inference', async () => {
  const qa = ui(); const kinds = [], views = [];
  qa.context.setConnectionKind = kind => kinds.push(kind); qa.context.showView = view => views.push(view);
  await qa.clicks[0]({ target: { closest: () => ({ dataset: { taskLocalModel: '' } }) } });
  assert.deepEqual(kinds, ['local']); assert.deepEqual(views, ['providers']); assert.equal(qa.calls.length, 0);
});


test('paused task editing saves the exact task paused and restores the preexisting draft', async () => {
  const qa=ui(); const task={id:'edit-a',agentId:'agent-b',name:'Paused',prompt:'Original',status:'paused',intervalSeconds:60,maxRuns:3,maxRetries:0};
  qa.context.state.data.tasks=[task]; qa.element('#taskName').value='Unsaved new task';qa.element('#taskPrompt').value='Keep my draft';
  await qa.clicks[0]({target:{closest:()=>({dataset:{taskEdit:task.id}})}});
  assert.equal(qa.element('#taskAgent').disabled,true);assert.equal(qa.element('#taskSubmit').textContent,'Save task changes');
  qa.element('#taskPrompt').value='Changed harmless instructions';
  await qa.element('#taskForm').listeners.submit({preventDefault(){}});
  assert.equal(qa.calls[0].method,'PATCH');assert.equal(qa.calls[0].path,'/api/tasks/edit-a');assert.equal(qa.calls[0].body.status,'paused');assert.equal(qa.calls[0].body.prompt,'Changed harmless instructions');
  assert.equal(qa.calls.length,1);assert.equal(qa.element('#taskPrompt').value,'Keep my draft');assert.equal(task.prompt,'Original','UI does not mutate snapshot or history before refresh');
  assert.equal(qa.element('#taskAgent').disabled,false);
});

test('failed save retains edit draft; cancellation restores new-task draft without dispatch', async () => {
  const qa=ui();const task={id:'edit-a',agentId:'agent-a',name:'Paused',prompt:'Original',status:'paused'};qa.context.state.data.tasks=[task];qa.element('#taskPrompt').value='Previous draft';
  await qa.clicks[0]({target:{closest:()=>({dataset:{taskEdit:task.id}})}});qa.element('#taskPrompt').value='Unsaved edit';
  qa.context.api=async()=>{throw Error('Task is already running.');};await qa.element('#taskForm').listeners.submit({preventDefault(){}});
  assert.equal(qa.element('#taskPrompt').value,'Unsaved edit');assert.equal(qa.element('#taskFeedback').textContent,'Task is already running.');
  qa.context.cancelTaskEdit();assert.equal(qa.element('#taskPrompt').value,'Previous draft');assert.equal(qa.calls.length,0);assert.equal(task.prompt,'Original');
});

test('running and terminal tasks cannot enter editing or change the active draft',async()=>{
 for(const status of ['running','completed','cancelled']){const qa=ui();qa.context.state.data.tasks=[{id:'x',status}];qa.element('#taskPrompt').value='Keep';await qa.clicks[0]({target:{closest:()=>({dataset:{taskEdit:'x'}})}});assert.equal(qa.element('#taskPrompt').value,'Keep');assert.equal(qa.calls.length,0);}
});


test('pending task save is single-flight and cannot discard its edit draft',async()=>{
 const qa=ui();qa.context.state.data.tasks=[{id:'x',agentId:'agent-a',status:'paused',name:'X',prompt:'Original'}];
 await qa.clicks[0]({target:{closest:()=>({dataset:{taskEdit:'x'}})}});qa.element('#taskPrompt').value='Save this';
 let release,dispatches=0;qa.context.api=async()=>{dispatches++;await new Promise(r=>release=r);};
 const pending=qa.element('#taskForm').listeners.submit({preventDefault(){}});await qa.element('#taskForm').listeners.submit({preventDefault(){}});
 qa.context.cancelTaskEdit();assert.equal(qa.element('#taskPrompt').value,'Save this');assert.equal(qa.element('#taskSubmit').disabled,true);assert.equal(dispatches,1);
 release();await pending;assert.equal(qa.element('#taskSubmit').disabled,false);assert.equal(dispatches,1);
});
