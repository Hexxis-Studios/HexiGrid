import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveStaticAsset } from '../lib/static-assets.mjs';

async function loadGuides() {
  const [prompts, source] = await Promise.all([
    readFile(new URL('../public/setup-prompts.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/guide-content.js', import.meta.url), 'utf8')
  ]);
  const context = { window: {}, location: { origin: 'https://hexigrid.test' } };
  vm.runInNewContext(prompts, context, { filename: 'setup-prompts.js' });
  vm.runInNewContext(source, context, { filename: 'guide-content.js' });
  return context.window.HEXIGRID_GUIDES;
}

test('plain-language guide covers every built-in connection path and recovery area', async () => {
  const guides = await loadGuides();
  for (const key of ['start','connections','openai','anthropic','gemini','huggingface','onDevice','ollama','lmstudio','compatibleApi','compatibleLocal','openCodeZen','cli','opencode','claudeCode','codex','ilands','personality','rooms','permissions','tasks','tools','backup','mobile','troubleshoot','selfIntegrate','frameworkPrompts','agentRecord']) {
    assert.ok(guides[key], `missing guide: ${key}`);
    assert.ok(guides[key].steps.length >= 4, `guide needs complete steps: ${key}`);
    assert.ok(guides[key].troubleshooting.length >= 1, `guide needs failure help: ${key}`);
  }
});

test('beginner platform guides separate pairing, models, optional imports and media prerequisites', async () => {
  const guides = await loadGuides();
  for (const key of ['basics', 'existingAgent', 'muse', 'voices', 'speechSetup']) {
    assert.ok(guides[key].steps.length >= 4, key);
    assert.ok(guides[key].troubleshooting.length, key);
  }
  const nativeSteps = guides.ilands.steps.map(step => step.join(' ')).join('\n');
  assert.doesNotMatch(nativeSteps, /Choose its thinking model|Upload it|Download the Markdown/);
  assert.match(nativeSteps, /pairing does not install Android/);
  assert.match(guides.existingAgent.note, /does not require importing memory/);
  assert.match(guides.computerAccess.steps.flat().join(' '), /without manual handoffs|do not hand control/);
  assert.match(guides.images.steps.flat().join(' '), /This service can also generate images/);
  assert.match(guides.voices.steps.flat().join(' '), /provider receives the speech text and may charge/);
  assert.match(guides.muse.steps.flat().join(' '), /same Chrome profile/);
  const [human, agent] = await Promise.all(['PLATFORM-SETUP.md', 'AGENT-INTEGRATION-PROMPT.md'].map(file => readFile(new URL(`../docs/${file}`, import.meta.url), 'utf8')));
  assert.match(human, /protected storage/);
  assert.match(agent, /Do not replace an existing agent/);
  assert.doesNotMatch(agent, /Present it as Coming soon; do not create a live-link invitation/);
});

test('every model connection has the same five-part zero-knowledge guide and current source links where applicable', async () => {
  const guides = await loadGuides();
  for (const key of ['openai','anthropic','gemini','huggingface','onDevice','ollama','lmstudio','compatibleApi','compatibleLocal','openCodeZen','cli','opencode','claudeCode','codex']) {
    const guide = guides[key];
    assert.ok(guide.basics?.what, `${key} must explain what it is`);
    assert.ok(guide.basics?.need, `${key} must explain prerequisites`);
    assert.ok(guide.basics?.cost, `${key} must explain costs and limits`);
    assert.ok(guide.steps.length >= 4, `${key} must explain HexiGrid setup`);
  }
  for (const key of ['openai','anthropic','gemini','huggingface','onDevice','ollama','lmstudio','compatibleApi','openCodeZen','opencode','claudeCode','codex']) {
    assert.ok(guides[key].officialLinks?.length, `${key} needs official current documentation`);
  }
  assert.match(guides.start.lead, /bridge/i);
});

test('the first-run guide separates pairing an existing agent from connecting a model', async () => {
  const guide = (await loadGuides()).start;
  const agentStep = guide.steps.find(([title]) => title === 'Add or pair an agent')?.[1] || '';
  const modelStep = guide.steps.find(([title]) => title === 'Connect a model if needed')?.[1] || '';
  assert.match(guide.lead, /Pair an agent and it stays in its current app/i);
  assert.match(agentStep, /Pair an existing compatible agent/);
  assert.match(agentStep, /separate iLands connection is optional/);
  assert.match(modelStep, /A paired agent keeps using its own app and model/);
  assert.match(modelStep, /new local agent/);
});

test('AI self-integration prompt protects secrets and requires real verification', async () => {
  const guide = (await loadGuides()).selfIntegrate;
  const prompt = guide.prompt;
  assert.match(guide.steps[0][1], /Copy setup prompt at the bottom of this guide/);
  assert.doesNotMatch(guide.steps[0][1], /Open Settings/);
  assert.match(prompt, /Never ask the human to paste an API key, password/i);
  assert.match(prompt, /protected HexiGrid field/i);
  assert.match(prompt, /Do not claim success based only on a button click/i);
  assert.match(prompt, /already signed-in command-line agent/i);
  assert.match(prompt, /\/api\/agent-interface/);
  assert.match(prompt, /cloud API key, on-device browser model, local model server/i);
});

test('calling help starts with the phonebook rather than the optional media sandbox', async () => {
  const guide = (await loadGuides()).live;
  assert.match(guide.lead, /Open Calls/);
  assert.equal(guide.officialLinks, undefined, 'generic calling help must not direct users to an iLands-only source');
  const steps = guide.steps.map(step => JSON.stringify(step)).join('\n');
  assert.match(steps, /Allow or Deny/);
  assert.match(steps, /answer the same incoming call/);
  assert.match(steps, /you only need one/);
  assert.match(steps, /Windows notifications are unavailable, HexiGrid shows an in-app prompt/);
  assert.match(steps, /Add to call/);
  assert.match(steps, /Advanced tools · previews and provider experiments/);
  assert.match(steps, /Turning the camera off keeps the voice call connected/);
  assert.doesNotMatch(steps, /Open Live|Press Start listening|Press Start camera \+ mic/);
});

test('everyday workflows have complete guides and only local optional illustrations', async () => {
  const guides = await loadGuides();
  for (const key of ['navigation','phonebook','avatars','memory','skills','sharedMemory','computerAccess','workspace','vault','usage','modelPool','automaticBackups','desktop','agentInterface','codexChats','oneShotJobs','images','wakeWord','callChat']) {
    assert.ok(guides[key]?.steps.length >= 4, `missing workflow instructions: ${key}`);
    assert.ok(guides[key].troubleshooting.length, `missing recovery guidance: ${key}`);
  }
  assert.match(guides.phonebook.lead, /does not revoke/);
  assert.match(guides.phonebook.steps.flat().join(' '), /Removed contacts/);
  for (const key of ['start','computerAccess','avatars','memory','skills','sharedMemory','vault','automaticBackups','backup','oneShotJobs','tasks','tools','connections','openai','ollama','agentInterface','codexChats','live']) {
    assert.ok(guides[key].stepImages?.length, `missing step-specific visual help: ${key}`);
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const guide of Object.values(guides)) for (const picture of [...(guide.image ? [guide.image] : []), ...(guide.stepImages || [])]) {
    assert.match(picture.src, /^\/help\/[a-z0-9-]+\.webp$/);
    assert.ok(picture.alt && picture.caption);
    if (picture.step !== undefined) assert.ok(Number.isInteger(picture.step) && picture.step >= 0 && picture.step < guide.steps.length);
    if (seen.has(picture.src)) continue;
    seen.add(picture.src);
    let status, headers, data;
    const served = await serveStaticAsset({ method:'GET', pathname:picture.src,
      publicDir:fileURLToPath(new URL('../public/', import.meta.url)),
      res:{ writeHead(code, value) { status=code; headers=value; }, end(body) { data=body; } },
      securityHeaders:type=>({'content-type':type}), serveHtml:()=>assert.fail('Picture must not be HTML') });
    assert.equal(served, true);
    assert.equal(status, 200);
    assert.equal(headers['content-type'], 'image/webp');
    assert.ok(data.length < 60000, 'guide pictures remain lightweight');
    assert.equal(data.subarray(8,12).toString(), 'WEBP');
    totalBytes += data.length;
  }
  assert.ok(totalBytes < 500000, 'all guide screenshots together remain below 500 KB');
});

test('guide pictures follow their numbered step and reject external image paths', async () => {
  const nodes = new Map(['guideDrawerTitle','guideDrawerBody','guideDrawer'].map(key => [key, { innerHTML:'', textContent:'', classList:{remove(){}} }]));
  const context = {
    guideTopics:{ start:{ title:'Example', lead:'Example only', steps:[['First','Do this'],['Second','Then this']], note:'',
      stepImages:[{step:0,src:'/help/avatars.webp',alt:'Choose picture',caption:'Step one screenshot'}, {step:1,src:'https://example.com/private.png',alt:'Unsafe',caption:'Must not load'}] } },
    document:{ getElementById:key=>nodes.get(key), addEventListener(){}, body:{classList:{add(){}}} },
    $:selector=>nodes.get(selector.slice(1)), escapeHtml:value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;'),
  };
  vm.runInNewContext(await readFile(new URL('../public/guide-ui.js', import.meta.url),'utf8'), context);
  context.openGuideTopic('start');
  const html=nodes.get('guideDrawerBody').innerHTML;
  assert.ok(html.indexOf('Do this') < html.indexOf('/help/avatars.webp') && html.indexOf('/help/avatars.webp') < html.indexOf('Then this'));
  assert.match(html, /loading="lazy"/);
  assert.match(html, /<button[^>]*data-guide-image="\/help\/avatars\.webp"/);
  assert.doesNotMatch(html, /target="_blank"/, 'enlarging a guide screenshot must not navigate out of the guide');
  assert.doesNotMatch(html, /example\.com|Must not load/);
});

test('guide module loads before the app defines its selector helpers', async () => {
  const source = await readFile(new URL('../public/guide-ui.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => vm.runInNewContext(source, {
    document: { getElementById() { return null; }, addEventListener() {} }
  }));
});
