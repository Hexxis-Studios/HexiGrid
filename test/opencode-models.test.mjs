import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenCodeModels } from '../lib/opencode-models.mjs';

test('OpenCode verbose discovery uses live metadata instead of filename guesses', () => {
  const output = `warning that should be ignored
opencode/free-current
{
  "id": "free-current",
  "providerID": "opencode",
  "name": "Current Free Model",
  "status": "active",
  "cost": { "input": 0, "output": 0 },
  "limit": { "context": 200000 },
  "capabilities": { "reasoning": true, "toolcall": true, "input": { "image": true } }
}
opencode/metered-current
{
  "id": "metered-current",
  "providerID": "opencode",
  "name": "Current Metered Model",
  "status": "active",
  "cost": { "input": 1.5, "output": 7.5 },
  "limit": { "context": 100000 },
  "capabilities": { "reasoning": false, "toolcall": true, "input": { "image": false } }
}`;
  const models = parseOpenCodeModels(output);
  assert.equal(models.length, 2);
  assert.equal(models[0].label, 'Current Free Model');
  assert.equal(models[0].free, true);
  assert.deepEqual(models[0].pricing, { input: 0, output: 0 });
  assert.deepEqual(models[0].capabilities, { reasoning: true, tools: true, images: true });
  assert.equal(models[1].free, false);
  assert.deepEqual(models[1].pricing, { input: 1.5, output: 7.5 });
});

test('malformed OpenCode entries are skipped without creating fake models', () => {
  assert.deepEqual(parseOpenCodeModels('opencode/broken\n{ "cost":'), []);
  assert.deepEqual(parseOpenCodeModels('command failed'), []);
});

test('unknown, coerced and negative prices never qualify a model for free-only routing', () => {
  for (const cost of [{input:null,output:null},{input:'',output:''},{input:false,output:false},
    {input:'0',output:'0'},{input:0},{input:0,output:null},{input:-1,output:0},{}]) {
    const [model] = parseOpenCodeModels(`opencode/unknown\n${JSON.stringify({cost},null,2)}`);
    assert.equal(model.free,false); assert.equal(model.pricing,null);
  }
  const [numeric] = parseOpenCodeModels(`opencode/explicit-zero\n${JSON.stringify({cost:{input:0,output:0}},null,2)}`);
  assert.equal(numeric.free,true); assert.deepEqual(numeric.pricing,{input:0,output:0});
});
