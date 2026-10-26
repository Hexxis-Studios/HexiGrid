import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('existing-agent prompt pairs durably without forcing continuity and keeps owner control', async () => {
  const source = await readFile(new URL('../docs/UNIVERSAL-AGENT-ONBOARDING-PROMPT.md', import.meta.url), 'utf8');
  const prompt = source.match(/```text\s*([\s\S]*?)\s*```/)?.[1] || '';

  assert.ok(prompt.length > 1_000, 'the complete prompt must remain present');
  assert.match(prompt, /Pairing does not require exporting memory or moving identity/);
  assert.match(prompt, /Only if the owner\s+separately asks/);
  assert.match(prompt, /CONNECT\.md first/);
  assert.match(prompt, /storage-check --ephemeral/);
  assert.match(prompt, /saved:true/);
  assert.match(prompt, /current HexiGrid Link invitation/i);
  assert.match(prompt, /fetch `\/agent-link\/skill`/i);
  assert.match(prompt, /continuity draft/i);
  assert.match(prompt, /owner review request/i);
  assert.match(prompt, /only the owner can review/i);
  assert.match(prompt, /one active profile for each lineage/i);
  assert.match(prompt, /Move activity/i);
  assert.match(prompt, /matching receipt/i);
  assert.match(prompt, /Muse, iLands|real agent name and framework identity/i);
  assert.doesNotMatch(prompt, /\b(copy|clone|backup|transfer)\b/i);
  assert.doesNotMatch(prompt, /approve (?:its|your) own|bypass|impersonate the owner and/i);
});
