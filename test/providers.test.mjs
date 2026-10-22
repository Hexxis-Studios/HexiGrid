import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateProvider, completeWithProvider, normalizeVisionInput, testProviderConnection, requiresProviderKey } from '../lib/providers.mjs';
import { CredentialVault } from '../lib/vault.mjs';

test('provider credentials cannot be embedded in endpoint URLs',()=>{
  for(const baseUrl of ['http://cloud.example/v1','https://name:key@example.com/v1','https://example.com/v1?key=secret']) assert.throws(()=>validateProvider({name:'test',baseUrl,models:'model'}));
  assert.equal(validateProvider({name:'test',baseUrl:'http://127.0.0.1:11434/v1',models:'model'}).local,true);
});

test('provider setup accepts an empty model list for server-side discovery',()=>{
  const provider = validateProvider({name:'Discover me',baseUrl:'https://api.example.com/v1',models:'',apiStyle:'openai-chat'});
  assert.deepEqual(provider.modelIds, []);
});
test('provider sends credentials only to the configured endpoint and refuses redirects',async()=>{
  const result=await completeWithProvider({baseUrl:'https://example.com/v1'},'private-key','model','hello',{fetcher:async(url,options)=>{
    assert.equal(url,'https://example.com/v1/chat/completions');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer private-key');
    return new Response(JSON.stringify({choices:[{message:{content:'Hi'}}],usage:{prompt_tokens:8,completion_tokens:2}}));
  }});
  assert.deepEqual(result,{content:'Hi',inputTokens:8,outputTokens:2});
});
test('empty provider replies explain text support and the output-limit recovery setting', async () => {
  await assert.rejects(completeWithProvider({ baseUrl: 'http://127.0.0.1:1234/v1' }, '', 'local-model', 'Reply READY', {
    fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }))
  }), /Check that this model supports text chat.*review its output-token settings/);
});
test('empty replies caused by provider output limits give a direct recovery action without exposing reasoning', async () => {
  const cases = [
    { provider: { baseUrl: 'http://127.0.0.1:1234/v1' }, body: { choices: [{ message: { content: '', reasoning_content: 'private reasoning' }, finish_reason: 'length' }] } },
    { provider: { baseUrl: 'https://api.anthropic.com/v1', apiStyle: 'anthropic' }, body: { content: [], stop_reason: 'max_tokens' } },
    { provider: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiStyle: 'google-gemini' }, body: { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] } },
    { provider: { baseUrl: 'https://api.openai.com/v1', apiStyle: 'openai-responses' }, body: { output_text: '', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }
  ];
  for (const item of cases) {
    await assert.rejects(completeWithProvider(item.provider, '', 'limited-model', 'Reply READY', {
      fetcher: async () => new Response(JSON.stringify(item.body))
    }), error => /reached its output-token limit/.test(error.message)
      && /Increase the maximum output tokens/.test(error.message)
      && !error.message.includes('private reasoning'));
  }
});
test('official cloud providers require credentials even when their model catalog is public', () => {
  for (const baseUrl of ['https://opencode.ai/zen/v1', 'https://api.openai.com/v1', 'https://api.anthropic.com/v1', 'https://generativelanguage.googleapis.com/v1beta', 'https://router.huggingface.co/v1']) {
    assert.throws(() => validateProvider({ name: 'Cloud', baseUrl, models: 'public-model' }), /API key/);
    assert.equal(validateProvider({ name: 'Cloud', baseUrl, models: 'public-model', apiKey: 'secret' }).modelIds[0], 'public-model');
  }
  assert.equal(validateProvider({ name: 'Keyless custom', baseUrl: 'https://example.com/v1', models: 'model' }).local, false);
  assert.equal(requiresProviderKey('https://opencode.ai/zen/v1'), true);
  assert.equal(requiresProviderKey('https://example.com/v1'), false);
});
test('vision frames are bounded and translated to each provider wire format', async () => {
  const frame = `data:image/jpeg;base64,${Buffer.from('small-frame').toString('base64')}`;
  assert.equal(normalizeVisionInput({ text: 'What is visible?', imageDataUrl: frame }).mimeType, 'image/jpeg');
  assert.throws(() => normalizeVisionInput({ text: 'bad', imageDataUrl: 'https://example.com/private.jpg' }));
  const cases = [
    { apiStyle: 'openai-chat', check: (body) => assert.equal(body.messages[0].content[1].type, 'image_url'), response: { choices: [{ message: { content: 'seen' } }] } },
    { apiStyle: 'openai-responses', check: (body) => assert.equal(body.input[0].content[1].type, 'input_image'), response: { output_text: 'seen' } },
    { apiStyle: 'anthropic', check: (body) => assert.equal(body.messages[0].content[1].source.media_type, 'image/jpeg'), response: { content: [{ type: 'text', text: 'seen' }] } },
    { apiStyle: 'google-gemini', check: (body) => assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg'), response: { candidates: [{ content: { parts: [{ text: 'seen' }] } }] } }
  ];
  for (const item of cases) {
    const result = await completeWithProvider({ baseUrl: 'https://example.com/v1', apiStyle: item.apiStyle }, 'key', 'vision-model', { text: 'What is visible?', imageDataUrl: frame }, { fetcher: async (_url, options) => {
      item.check(JSON.parse(options.body));
      return new Response(JSON.stringify(item.response));
    } });
    assert.equal(result.content, 'seen');
  }
});
test('provider errors never echo provider response bodies containing secrets',async()=>{
  await assert.rejects(completeWithProvider({baseUrl:'https://example.com/v1'},'secret','model','hello',{fetcher:async()=>new Response('secret',{status:401})}),error=>!error.message.includes('secret'));
});
test('Anthropic, Responses, and Gemini adapters use their native wire formats', async () => {
  const cases = [
    {
      provider: { baseUrl: 'https://api.anthropic.com/v1', apiStyle: 'anthropic' }, expectedUrl: '/messages', expectedHeader: 'x-api-key',
      response: { content: [{ type: 'text', text: 'Anthropic reply' }], usage: { input_tokens: 5, output_tokens: 2 } }, expected: 'Anthropic reply'
    },
    {
      provider: { baseUrl: 'https://api.openai.com/v1', apiStyle: 'openai-responses' }, expectedUrl: '/responses', expectedHeader: 'authorization',
      response: { output_text: 'Responses reply', usage: { input_tokens: 6, output_tokens: 3 } }, expected: 'Responses reply'
    },
    {
      provider: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiStyle: 'google-gemini' }, expectedUrl: '/models/test-model:generateContent', expectedHeader: 'x-goog-api-key',
      response: { candidates: [{ content: { parts: [{ text: 'Gemini reply' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 } }, expected: 'Gemini reply'
    }
  ];
  for (const item of cases) {
    const result = await completeWithProvider(item.provider, 'secret', 'test-model', 'hello', { fetcher: async (url, options) => {
      assert.ok(url.endsWith(item.expectedUrl)); assert.ok(options.headers[item.expectedHeader]); assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify(item.response), { status: 200 });
    } });
    assert.equal(result.content, item.expected);
  }
});
test('provider health checks discover model IDs without returning credentials', async () => {
  const result = await testProviderConnection({ baseUrl: 'http://127.0.0.1:11434/v1', apiStyle: 'openai-chat' }, 'secret', {
    fetcher: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:11434/v1/models'); assert.equal(options.headers.authorization, 'Bearer secret');
      return new Response(JSON.stringify({ data: [{ id: 'local-one' }, { id: 'local-two' }] }), { status: 200 });
    }
  });
  assert.deepEqual(result.models, ['local-one', 'local-two']); assert.doesNotMatch(JSON.stringify(result), /secret/);
});
test('Windows vault encrypts, retrieves, replaces and removes isolated keys',{skip:process.platform!=='win32'},async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'aven iq-vault-'));
  const vault=new CredentialVault(directory);
  try{
    await vault.set('provider-one','test-key-never-plaintext');
    assert.ok(!(await readFile(vault.file('provider-one'),'utf8')).includes('test-key-never-plaintext'));
    assert.equal(await vault.get('provider-one'),'test-key-never-plaintext');
    assert.equal(await vault.get('provider-two'),'');
    await vault.set('provider-one','replacement');assert.equal(await vault.get('provider-one'),'replacement');
    await vault.remove('provider-one');assert.equal(await vault.get('provider-one'),'');
    assert.throws(()=>vault.file('../escape'));
  }finally{await rm(directory,{recursive:true,force:true});}
});
