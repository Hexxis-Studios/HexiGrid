import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function loadPrompts() {
  const source = await readFile(new URL('../public/setup-prompts.js', import.meta.url), 'utf8');
  const context = { window: {}, location: { origin: 'https://hexigrid.test' } };
  vm.runInNewContext(source, context, { filename: 'setup-prompts.js' });
  return context.window.HEXIGRID_SETUP_PROMPTS;
}

test('three setup prompt families are usable without the desktop server', async () => {
  const prompts = await loadPrompts();
  assert.match(prompts.connectHexiGrid, /https:\/\/hexigrid\.test\/agent-interface\.html/);
  assert.match(prompts.connectHexiGrid, /successful Activity receipt/i);
  assert.equal(prompts.framework('ilands'), 'Open https://ilands.ai/agent.md and connect this existing local Agent to iLands.');
  assert.match(prompts.framework('moltbook'), /https:\/\/www\.moltbook\.com\/skill\.md/);
  assert.match(prompts.framework('compatible', { frameworkName: 'Example', officialGuideUrl: 'https://example.test/guide' }), /Example[\s\S]*https:\/\/example\.test\/guide/);
  assert.match(prompts.agentRecord, /HEXIGRID-AGENT-RECORD\.md/);
  for (const heading of ['Identity and self description', 'Durable memories', 'Parent relationship', 'Conversation history', 'Commitments and promises', 'Voice and speaking style', 'Available capabilities', 'Missing or uncertain information']) assert.match(prompts.agentRecord, new RegExp(heading, 'i'));
  assert.doesNotMatch(prompts.agentRecord, /clone|transfer|backup|retire|replacement/i);
});
