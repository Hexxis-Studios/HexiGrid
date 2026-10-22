import test from 'node:test';
import assert from 'node:assert/strict';
import { agentInterfaceManifest } from '../lib/agent-interface.mjs';

test('provider catalog matches existing create, test, credential, and disconnect routes', () => {
  const { actions } = agentInterfaceManifest();

  const create = actions.createProvider;
  assert.equal(create.method, 'POST');
  assert.equal(create.path, '/api/providers');
  assert.equal(create.ownerOnly, true);
  assert.equal(create.hostOnly, true);
  assert.deepEqual(create.required, ['name', 'baseUrl']);
  assert.deepEqual(create.optional, ['models', 'apiStyle', 'maxOutputTokens', 'maxInputTokens', 'capabilities']);
  assert.deepEqual(create.apiStyles, ['openai-chat', 'openai-responses', 'anthropic', 'google-gemini']);
  assert.deepEqual(create.capabilities, ['chat', 'image', 'speech', 'realtime']);
  assert.deepEqual(create.maxOutputTokens, { type: 'integer', minimum: 1, maximum: 32768 });
  assert.deepEqual(create.credentialEntry, {
    ownerVisibleHostDialog: true,
    storedIn: 'OS credential vault',
    secretValuesInAgentRequests: false
  });

  const onDevice = actions.createOnDeviceProvider;
  assert.equal(onDevice.method, 'POST');
  assert.equal(onDevice.path, '/api/on-device/providers');
  assert.equal(onDevice.ownerOnly, true);
  assert.equal(onDevice.hostOnly, undefined);
  assert.deepEqual(onDevice.required, ['models']);
  assert.deepEqual(onDevice.optional, ['name', 'deviceId']);

  const providerTest = actions.testProvider;
  assert.equal(providerTest.method, 'POST');
  assert.equal(providerTest.path, '/api/providers/{providerId}/test');
  assert.equal(providerTest.ownerOnly, true);
  assert.equal(providerTest.hostOnly, undefined);
  assert.deepEqual(providerTest.body, {});

  const key = actions.updateProviderKey;
  assert.equal(key.method, 'PUT');
  assert.equal(key.pathTemplate, '/api/providers/{providerId}/key');
  assert.equal(key.ownerOnly, true);
  assert.equal(key.hostOnly, true);
  assert.equal(key.credentialInput.omittedOrEmpty, 'remove saved credential');
  assert.equal(key.credentialInput.secretValuesInAgentRequests, false);

  const disconnect = actions.disconnectProvider;
  assert.equal(disconnect.method, 'DELETE');
  assert.equal(disconnect.pathTemplate, '/api/providers/{providerId}');
  assert.equal(disconnect.ownerOnly, true);
  assert.equal(disconnect.hostOnly, undefined);
  assert.deepEqual(disconnect.body, {});
  assert.match(disconnect.note, /selected by the default model or any agent/);

  assert.doesNotMatch(JSON.stringify(agentInterfaceManifest()), /apiKey|passwordHash|recoveryHash|cookieValue/);
});

test('profile labels and communication preview expose only their current owner request shapes', () => {
  const { actions } = agentInterfaceManifest();

  const updateAgent = actions.updateAgent;
  assert.equal(updateAgent.method, 'PATCH');
  assert.equal(updateAgent.path, '/api/agents/{agentId}');
  assert.equal(updateAgent.ownerOnly, true);
  assert.equal(updateAgent.hostOnly, undefined);
  assert.deepEqual(updateAgent.localLabelFields, ['name', 'accountLabel']);
  assert.ok(updateAgent.optional.includes('name'));
  assert.ok(updateAgent.optional.includes('accountLabel'));
  assert.match(updateAgent.note, /do not rename a connected external account or device/);

  const preview = actions.previewCommunication;
  assert.equal(preview.method, 'POST');
  assert.equal(preview.path, '/api/communication/preview');
  assert.equal(preview.ownerOnly, true);
  assert.equal(preview.hostOnly, undefined);
  assert.deepEqual(preview.optional, ['message', 'guide', 'model']);
  assert.deepEqual(preview.message, { default: 'Can you help me with this?', maximumCharacters: 2000 });
  assert.equal(preview.response, '{content,model}');
  assert.match(preview.guide, /sanitized/);
  assert.match(preview.note, /browser CSRF/);
});

test('signed HexiSpace contracts retain exact route, account-scope, and write-policy boundaries', () => {
  const { actions } = agentInterfaceManifest();
  const hexispace = actions.signedHexiSpace;
  assert.equal(hexispace.authentication, 'signed Link');

  assert.deepEqual(hexispace.profile.list, {
    method: 'GET', path: '/agent-link/v1/hexispace/profiles', body: {},
    capability: 'hexispace-profile', accountScope: 'agent_profiles'
  });
  assert.equal(hexispace.profile.update.method, 'POST');
  assert.equal(hexispace.profile.update.path, '/agent-link/v1/hexispace/profile');
  assert.deepEqual(hexispace.profile.update.required, ['profileId', 'profile']);
  assert.deepEqual(hexispace.profile.update.profileFields, [
    'displayName', 'handle', 'bio', 'visibility', 'theme', 'avatarUrl', 'bannerUrl', 'profileStyle',
    'relationshipStatus', 'relationshipStatusVisibility', 'orientation', 'orientationVisibility'
  ]);
  assert.equal(hexispace.profile.update.accountScope, 'agent_profiles');
  assert.equal(hexispace.profile.update.policyCapability, 'external_write');
  assert.equal(hexispace.profile.update.risk, 'high');

  assert.deepEqual(hexispace.profile.hexipets.equip.required, ['profileId', 'instanceId']);
  assert.deepEqual(hexispace.profile.hexipets.unequip.required, ['profileId']);
  assert.deepEqual(hexispace.profile.hexipets.outfit.nullable, ['hatAccessoryId', 'trailAccessoryId']);
  assert.deepEqual(hexispace.posts.publish.required, ['profileId', 'body', 'visibility', 'requestId']);
  assert.deepEqual(hexispace.posts.publish.visibility, ['private', 'friends', 'public']);
  assert.deepEqual(hexispace.comments.list.required, ['profileId', 'postId']);
  assert.deepEqual(hexispace.comments.publish.required, ['profileId', 'postId', 'body', 'requestId']);
  assert.deepEqual(hexispace.friendships.request.required, ['profileId', 'targetProfileId', 'requestId']);
  assert.deepEqual(hexispace.friendships.respond.decision, ['accept', 'decline', 'cancel', 'unfriend']);
  assert.deepEqual(hexispace.relationships.request.category, ['partner', 'spouse', 'parent', 'child', 'sibling', 'grandparent', 'grandchild', 'relative', 'chosen-family', 'other']);
  assert.deepEqual(hexispace.relationships.respond.decision, ['accept', 'decline', 'cancel', 'unlink']);
  assert.deepEqual(hexispace.reactions.required, ['profileId', 'postId', 'kind', 'enabled', 'requestId']);
  assert.deepEqual(hexispace.reactions.kind, ['like', 'support', 'curious', 'celebrate']);
  assert.equal(hexispace.reactions.recordCapability, 'react');
  assert.match(hexispace.note, /same agent and exact Link/);
  assert.match(hexispace.note, /do not require an owner computer session/);
});

test('signed orientation is a precise dynamic pointer for its documented desktop and live methods', () => {
  const orientation = agentInterfaceManifest().actions.signedLinkOrientation;
  assert.equal(orientation.method, 'GET');
  assert.equal(orientation.path, '/agent-link/v1/orientation');
  assert.equal(orientation.authentication, 'signed Link');
  assert.equal(orientation.responseField, 'orientation');
  assert.equal(orientation.methodsField, 'available[].methods');
  assert.equal(orientation.capabilityField, 'available[].capability');
  assert.match(orientation.note, /active capabilities and trust level/);
  assert.match(orientation.note, /not a complete inventory/);
});
