import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
const appScript = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const pageMarkup = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const at = Date.parse('2026-09-30T01:00:00Z');
function fixture({ hostileLocale = false } = {}) {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', dataset: {} }); return nodes.get(id); };
  const state = { usagePeriod: 'day', data: { agents: [{ id: 'a', name: 'Same', label: 'Same · a' }, { id: 'b', name: 'Same', label: 'Same · b' }], usage: [] } };
  class Clock extends Date {
    static now() { return at; }
    toLocaleTimeString(...args) { return hostileLocale ? '<hour & "label">' : super.toLocaleTimeString(...args); }
    toLocaleDateString(...args) { return hostileLocale ? '<date & "label">' : super.toLocaleDateString(...args); }
    toLocaleString(...args) { return hostileLocale ? '<local & "interval">' : super.toLocaleString(...args); }
  }
  const context = { window: {}, Date: Clock, agentListLabel: item => item.label };
  vm.runInNewContext(script, context);
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  const render = () => context.window.HexiGridViewRenderers.renderUsage({ state, $, $$: () => [], escapeHtml, agent: id => state.data.agents.find(item => item.id === id), avatarMarkup: () => '', levelClass: () => 'level' });
  const record = (agentId, hoursAgo, inputTokens, outputTokens, estimated) => ({ agentId, createdAt: new Date(at - hoursAgo * 3600000).toISOString(), inputTokens, outputTokens, estimated });
  return { state, $, render, record, report: options => context.window.HexiGridViewRenderers.agentUsageReport(state.data, { endAt: at, ...options }) };
}
function attribute(markup, name) {
  const value = markup.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  return value?.replaceAll('&quot;', '"').replaceAll('&#039;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&') ?? null;
}
test('rolling usage totals and chart include exact boundary once and exclude future/expired records', () => {
  const { state, $, render, record } = fixture();
  state.data.usage = [record('a', 24, 10, 1, false), record('a', 2, 20, 2, false), record('a', 0, 30, 3, false), record('a', 25, 999, 0, false), record('a', -1, 999, 0, false)];
  render();
  assert.equal($('#usageTotal').textContent, '66');
  assert.match($('#usageChartTitle').textContent, /Last 24 hours.*2-hour intervals/);
  const controls = [...$('#usageChart').innerHTML.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
  const chartCounts = controls.map(markup => Number(attribute(markup, 'aria-label').match(/ · ([\d,]+) tokens · Local interval:/)[1].replaceAll(',', '')));
  assert.equal(chartCounts.length, 12);
  assert.equal(chartCounts.reduce((sum, count) => sum + count, 0), 66);
  const latest = controls.at(-1);
  const localOptions = { dateStyle: 'medium', timeStyle: 'short' };
  const expectedDetail = `${new Date(at).toLocaleTimeString([], { hour: 'numeric' })} · 55 tokens · Local interval: ${new Date(at - 2 * 3600000).toLocaleString([], localOptions)} → ${new Date(at).toLocaleString([], localOptions)}`;
  assert.equal(attribute(latest, 'aria-label'), expectedDetail);
  assert.equal(attribute(latest, 'data-usage-detail'), expectedDetail);
  assert.match(latest, /type="button"/);
  assert.equal($('#usageChart').dataset.columns, '12');
});

test('chart buttons expose zero values, safely escaped labels, and native focus semantics', () => {
  const { $, render } = fixture({ hostileLocale: true });
  render();
  const controls = [...$('#usageChart').innerHTML.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
  assert.equal(controls.length, 12);
  assert.ok(controls.every(markup => /aria-label=".*0 tokens · Local interval:/.test(markup)));
  assert.match($('#usageChart').innerHTML, /<span class="usage-bar-value">0<\/span>/);
  assert.match(controls[0], /data-usage-detail="&lt;hour &amp; &quot;label&quot;&gt; · 0 tokens · Local interval: &lt;local &amp; &quot;interval&quot;&gt; → &lt;local &amp; &quot;interval&quot;&gt;"/);
  assert.doesNotMatch(controls[0], /(?:aria-label|data-usage-detail)="</);
  assert.match(appScript, /document\.addEventListener\("focusin", \(event\) => \{[\s\S]*?#usageChartDetail/);
  assert.match(appScript, /const usageBar = event\.target\.closest\("#usageChart \[data-usage-detail\]"\);/);
  assert.match(pageMarkup, /id="usageChartDetail" class="usage-chart-detail" role="status"/);
  assert.match(pageMarkup, /id="usageChart"[\s\S]*?role="group"/);
});

test('rendering a new period or agent filter clears the previous chart detail', () => {
  const { state, $, render } = fixture();
  render();
  $('#usageChartDetail').textContent = 'Old chart value';
  state.usagePeriod = 'week';
  render();
  assert.equal($('#usageChartDetail').textContent, 'Tap or focus a bar to see its exact token count and local interval.');
  assert.equal($('#usageChart').dataset.columns, '7');
  $('#usageChartDetail').textContent = 'Old chart value';
  $('#usageAgentFilter').value = 'a';
  render();
  assert.equal($('#usageChartDetail').textContent, 'Tap or focus a bar to see its exact token count and local interval.');
  assert.equal($('#usageAgentFilter').value, 'a');
  state.usagePeriod = 'month';
  render();
  assert.equal($('#usageChart').dataset.columns, '30');
});
test('agent filter and metering labels agree for exact, estimated and unattributed records', () => {
  const { state, $, render, record } = fixture();
  state.data.usage = [record('a', 1, 10, 1, false), record('b', 1, 20, 2, true), record('gone', 1, 30, 3, undefined)];
  render();
  assert.match($('#usageAgentBreakdown').innerHTML, /Same · a.*11 tokens · Provider-reported tokens/);
  assert.match($('#usageAgentBreakdown').innerHTML, /Same · b.*22 tokens · Includes estimates/);
  assert.match($('#usageAgentBreakdown').innerHTML, /Removed agent · gone.*33 tokens · Metering source not recorded/);
  $('#usageAgentFilter').value = 'a'; render();
  assert.equal($('#usageTotal').textContent, '11');
  assert.match($('#usageLegend').innerHTML, /Provider-reported tokens/);
  assert.doesNotMatch($('#usageAgentBreakdown').innerHTML, /Same · b/);
});
test('removed selected agent resets to all before accounting; empty known agent stays empty', () => {
  const { state, $, render, record } = fixture();
  state.data.usage = [record('a', 1, 10, 1, false)];
  $('#usageAgentFilter').value = 'removed'; render();
  assert.equal($('#usageAgentFilter').value, 'all');
  assert.equal($('#usageTotal').textContent, '11');
  $('#usageAgentFilter').value = 'b'; render();
  assert.equal($('#usageTotal').textContent, '0');
  assert.match($('#usageAgentBreakdown').innerHTML, /No requests recorded/);
});

test('assistant usage can be isolated without including other agents or expired records', () => {
  const { state, $, render, record } = fixture();
  state.data.usage = [record(null, 1, 10, 2, true), record('a', 1, 50, 5, false), record(null, 25, 999, 0, true)];
  $('#usageAgentFilter').value = 'assistant'; render();
  assert.equal($('#usageAgentFilter').value, 'assistant');
  assert.equal($('#usageTotal').textContent, '12');
  assert.match($('#usageAgentBreakdown').innerHTML, /HexiGrid assistant.*12 tokens · Includes estimates/);
  assert.doesNotMatch($('#usageAgentBreakdown').innerHTML, /Same · a/);
});
test('structured agent report preserves exact identity and counts without copying private usage fields', () => {
  const { state, record, report } = fixture();
  state.data.usage = [{ ...record('a', 1, 10, 1, false), inputText: 'private prompt', outputText: 'private reply', credential: 'private secret' }, record('b', 1, 20, 2, true), record('a', 25, 50, 5, false)];
  const day = report({ days: 1 });
  assert.equal(day.requests, 2);
  assert.equal(day.inputTokens + day.outputTokens, 33);
  assert.deepEqual(Array.from(day.agents, item => item.agentId), ['a', 'b']);
  assert.equal(day.agents[0].metering, 'Provider-reported tokens');
  assert.equal(day.agents[1].metering, 'Includes estimates');
  assert.equal(report({ days: 7 }).requests, 3);
  assert.doesNotMatch(JSON.stringify(day), /private|inputText|outputText|credential/);
});

test('usage refresh preserves an edited budget and its stale-write baseline until explicitly reloaded', () => {
  const { state, $, render } = fixture();
  const input = $('#usageBudgetInput'); input.dataset = {};
  state.data.usageBudget = { limit: 100, flag: 'under-budget', remaining: 100 };
  render(); assert.equal(input.value, 100); assert.equal(input.dataset.expectedTokens, '100');
  input.value = '200'; input.dataset.edited = 'true';
  state.data.usageBudget.limit = 300;
  render(); assert.equal(input.value, '200'); assert.equal(input.dataset.expectedTokens, '100');
  input.dataset.edited = 'false'; render();
  assert.equal(input.value, 300); assert.equal(input.dataset.expectedTokens, '300');
});
