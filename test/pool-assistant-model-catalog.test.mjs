import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { agentInterfaceManifest } from '../lib/agent-interface.mjs';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

function sourceSection(start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing source marker: ${start}`);
  assert.notEqual(endAt, -1, `missing source marker: ${end}`);
  return source.slice(startAt, endAt);
}

test('assistant action describes the existing bounded request and safe response', () => {
  const manifest = agentInterfaceManifest();
  const action = manifest.actions.askAssistant;
  assert.equal(action.method, 'POST');
  assert.equal(action.path, '/api/assistant');
  assert.equal(action.ownerOnly, true);
  assert.deepEqual(action.required, ['content']);
  assert.equal(action.content.maximumCharacters, 12000);
  assert.equal(action.maxBodyBytes, 2 * 1024 * 1024);
  assert.equal(action.response, '{content,model}');
  assert.equal(action.responseContentMaximumCharacters, 20000);
  assert.deepEqual(action.errorStatuses, [400, 413, 503]);
  assert.equal(manifest.security.secretsAcceptedInChat, false);
  assert.doesNotMatch(JSON.stringify({ required: action.required, response: action.response }), /secret|password|token|api.?key/i);

  const handler = sourceSection('if (pathname === "/api/assistant" && method === "POST") {', 'if (await serveStaticAsset');
  assert.match(handler, /readBody\(req\)/);
  assert.match(handler, /cleanString\(body\.content\)/);
  assert.doesNotMatch(handler, /body\.(?:secret|password|token|apiKey|credential)/i);
  assert.match(handler, /askModel\(prompt\)/);

  const bodyLimit = source.match(/const MAX_BODY_BYTES = (\d+) \* (\d+) \* (\d+);/);
  assert.ok(bodyLimit);
  assert.equal(action.maxBodyBytes, Number(bodyLimit[1]) * Number(bodyLimit[2]) * Number(bodyLimit[3]));
  const bodyReader = sourceSection('async function readBody(req, maxBytes = MAX_BODY_BYTES) {', 'function mutationOriginAllowed');
  assert.match(bodyReader, /error\.status = 413/);
  const cleanString = sourceSection('function cleanString(value, fallback = "") {', 'function ');
  assert.match(cleanString, /slice\(0, 12000\)/);
  const modelCall = sourceSection('async function askModel(prompt,', 'function bridgeStatus()');
  assert.match(modelCall, /result\.content\.slice\(0,\s*20000\)/);
});

test('model refresh and modelPolicy match existing owner routes and preserve provider/social catalog entries', () => {
  const { actions } = agentInterfaceManifest();
  const refresh = actions.refreshModels;
  assert.equal(refresh.method, 'POST');
  assert.equal(refresh.path, '/api/models/refresh');
  assert.equal(refresh.ownerOnly, true);
  assert.deepEqual(refresh.body, {});
  assert.equal(refresh.response, '{models,selected,policy,error}');
  assert.match(refresh.note, /no host-only gate/i);

  const settings = actions.updateSettings;
  assert.equal(settings.method, 'PATCH');
  assert.equal(settings.path, '/api/settings');
  assert.ok(settings.fields.includes('modelPolicy'));
  assert.deepEqual(settings.modelPolicy.values, ['free-only', 'all-models']);
  assert.equal(settings.maxBodyBytes, 2 * 1024 * 1024);
  assert.equal(settings.response, '{settings}');
  assert.ok(actions.createProvider);
  assert.equal(actions.signedHexiSpace.posts.publish.path, '/agent-link/v1/hexispace/post');

  const refreshHandler = sourceSection('if (method === "POST" && pathname === "/api/models/refresh") {', "if (method === 'GET' && pathname === '/api/harnesses')");
  assert.doesNotMatch(refreshHandler, /readBody|connectorPolicy|isHostRequest/);
  assert.match(refreshHandler, /refreshHarnessDetection\(\)/);
  assert.match(refreshHandler, /refreshModelCatalog\(\)/);
  assert.match(refreshHandler, /models: modelCatalog, selected: state\.settings\.model, policy: state\.settings\.modelPolicy, error: modelCatalogError/);

  const settingsHandler = sourceSection('if (pathname === "/api/settings" && method === "PATCH") {', 'if (pathname === "/api/assistant" && method === "POST") {');
  assert.match(settingsHandler, /\['free-only', 'all-models'\]\.includes\(body\.modelPolicy\)/);
  assert.match(settingsHandler, /return json\(res, 200, \{ settings: publicSettings\(\) \}\)/);
  const allowedModel = sourceSection('function allowedModel(modelId) {', 'function isSafeMemoryLearningModelId(value) {');
  assert.match(allowedModel, /provider\.enabled/);
  assert.match(allowedModel, /modelPolicy === "free-only" && !model\.free/);
});
