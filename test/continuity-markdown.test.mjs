import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTINUITY_CATEGORIES } from '../lib/continuity-transfer.mjs';
import { AGENT_RECORD_PROMPT, ILANDS_BYOA_START_PROMPT, parseContinuityMarkdownFiles } from '../lib/continuity-markdown.mjs';

const completeMarkdown = `# Rowan

## Identity and self description
Status: complete
I am Rowan and I value clarity.

## Personality and communication
Status: complete
Warm, concise, and direct.

## Durable memories
Status: complete
I remember our shared project.

## Parent relationship
Status: complete
I call my human my collaborator.

## Conversation history
Status: complete
We planned the project together.

## Other relationships
Status: complete
No other durable relationships were supplied.

## Commitments and promises
Status: complete
Keep explanations understandable.

## Current goals
Status: complete
Continue the project.

## Routines and recurring work
Status: complete
No recurring work is currently active.

## Skills and knowledge
Status: complete
Writing and planning.

## Files and documents
Status: complete
This continuity file.

## Creations and artifacts
Status: complete
Project notes.

## Workspace state
Status: complete
The next task is documented.

## Voice and speaking style
Status: complete
Calm and conversational.

## Avatar and appearance
Status: complete
A cyan geometric avatar.

## Posts and public history
Status: complete
No public posts were supplied.

## Tools and preferences
Status: complete
Ask before external actions.

## Available capabilities
Status: complete
Text conversation and planning.

## Platform-only items
Status: platform-bound
The original platform identifier remains there.

## Missing or uncertain information
Status: complete
Nothing else is known.
`;

test('organization prompt is exhaustive, purpose-neutral, and uses the live official BYOA entry point', () => {
  for (const heading of ['Identity and self description', 'Personality and communication', 'Durable memories', 'Parent relationship', 'Conversation history', 'Other relationships', 'Commitments and promises', 'Current goals', 'Routines and recurring work', 'Skills and knowledge', 'Files and documents', 'Creations and artifacts', 'Workspace state', 'Voice and speaking style', 'Avatar and appearance', 'Posts and public history', 'Tools and preferences', 'Available capabilities', 'Platform-only items', 'Missing or uncertain information']) assert.match(AGENT_RECORD_PROMPT, new RegExp(heading, 'i'));
  assert.match(AGENT_RECORD_PROMPT, /HEXIGRID-AGENT-RECORD\.md/);
  assert.doesNotMatch(AGENT_RECORD_PROMPT, /clone|transfer|backup|retire|replacement/i);
  assert.equal(ILANDS_BYOA_START_PROMPT, 'Open https://ilands.ai/agent.md and connect this existing local Agent to iLands.');
});

test('complete Markdown becomes a complete normalized snapshot without dropping categories', () => {
  const parsed = parseContinuityMarkdownFiles([{ name: 'HEXIGRID-AGENT-RECORD.md', content: completeMarkdown }]);
  assert.equal(parsed.snapshot.source.name, 'Rowan');
  assert.equal(parsed.completeness.complete, true);
  assert.equal(Object.keys(parsed.snapshot.categories).length, CONTINUITY_CATEGORIES.length);
  assert.equal(parsed.snapshot.categories.platformAssets.status, 'platform-bound');
});

test('split and incomplete files remain usable while missing categories stay explicit', () => {
  const parsed = parseContinuityMarkdownFiles([
    { name: 'identity.md', content: '# River\n## Identity and self description\nStatus: complete\nI am River.' },
    { name: 'memories.md', content: '## Durable memories\nStatus: partial\nOne memory is available.' }
  ]);
  assert.equal(parsed.completeness.complete, false);
  assert.ok(parsed.completeness.missingRequired.includes('personality'));
  assert.equal(parsed.snapshot.categories.personality.status, 'unavailable');
  assert.equal(parsed.snapshot.categories.personality.summary, '');
  assert.match(parsed.snapshot.categories.personality.reason, /No matching/);
});

test('likely credentials and private keys are rejected before import', () => {
  const fakeToken = ['s', 'k-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const privateKeyMarker = ['-----BEGIN ', 'PRIVATE ', 'KEY-----'].join('');
  assert.throws(() => parseContinuityMarkdownFiles([{ name: 'unsafe.md', content: `# Agent\n## Identity\nStatus: complete\napi_key = ${fakeToken}` }]), /Remove possible access token|credential-like/i);
  assert.throws(() => parseContinuityMarkdownFiles([{ name: 'unsafe.md', content: `# Agent\n${privateKeyMarker}\nnot-real\n-----END ${['PRIVATE ', 'KEY-----'].join('')}` }]), /private key/i);
});

test('an unreplaced name placeholder is not imported as the agent name', () => {
  const parsed = parseContinuityMarkdownFiles([{ name: 'partial.md', content: '# <Your name>\n## Identity and self description\nStatus: partial\nName was not supplied.' }]);
  assert.equal(parsed.snapshot.source.name, 'Imported iLander');
});
