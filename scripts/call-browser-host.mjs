#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createParser } from 'eventsource-parser';
import { CredentialVault } from '../lib/vault.mjs';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'integrations/call-browser/extension/manifest.json'), 'utf8'));
const extensionId = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0,16)]
  .flatMap(byte => [byte >> 4, byte & 15]).map(n => String.fromCharCode(97+n)).join('');
const flag = name => process.argv[process.argv.indexOf(name)+1];
if (flag('--origin') !== `chrome-extension://${extensionId}/`) process.exit(1);
const port = Number(flag('--port'));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) process.exit(1);
const vault = new CredentialVault(path.join(process.env.HEXIGRID_DATA_DIR || path.join(root, 'data'), 'vault'));
const secret = await vault.get('call-browser-local-secret');
if (!secret) process.exit(1);
const base = `http://127.0.0.1:${port}/api/call-browser/v1/`;
const headers = { authorization: `Bearer ${secret}`, 'content-type':'application/json' };
let streamController, input = Buffer.alloc(0), closed = false;
const write = message => {
  if (closed) return;
  const bytes = Buffer.from(JSON.stringify(message));
  if (bytes.length > 128*1024) throw new Error('Native call message is too large.');
  const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
  process.stdout.write(Buffer.concat([length, bytes]));
};
async function request(command, body) {
  const result = await fetch(base+command, { method:command==='links'?'GET':'POST', headers,
    ...(command==='links'?{}:{body:JSON.stringify(body)}), signal:AbortSignal.timeout(10000) });
  if (!result.ok) throw new Error('Call chat action unavailable.');
  return result.json();
}
async function subscribe(bindingId) {
  streamController?.abort(); const controller = new AbortController(); streamController = controller;
  while (!controller.signal.aborted && !closed) {
    try {
      const response = await fetch(base+`events?bindingId=${encodeURIComponent(bindingId)}`, { headers, signal:controller.signal });
      if (!response.ok) break;
      const parser = createParser({ onEvent(event) {
        if (event.event === 'utterance') write({ type:'utterance', turn:JSON.parse(event.data) });
      } });
      const decoder = new TextDecoder();
      for await (const chunk of response.body) parser.feed(decoder.decode(chunk,{stream:true}));
    } catch { if (controller.signal.aborted) break; }
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done,3000); controller.signal.addEventListener('abort',done,{once:true});
      if (controller.signal.aborted) done();
    });
  }
}
async function receive(message) {
  if (!/^[a-f0-9-]{36}$/.test(String(message.requestId || ''))) return;
  try {
    let result;
    if (message.command === 'subscribe' && /^[a-f0-9-]{36}$/.test(String(message.body?.bindingId || ''))) {
      void subscribe(message.body.bindingId); result = { subscribed:true };
    } else if (['links','connect','disconnect','claim','report','check'].includes(message.command)) {
      result = await request(message.command,message.body || {});
      if (message.command === 'disconnect') streamController?.abort();
    } else throw new Error('Unknown native action.');
    write({ requestId:message.requestId, ok:true, result });
  } catch { write({ requestId:message.requestId, ok:false, error:'The call chat connection is unavailable. Check HexiGrid and the selected chat.' }); }
}
process.stdin.on('data',chunk => {
  input = Buffer.concat([input,chunk]);
  while (input.length >= 4) {
    const size = input.readUInt32LE(0);
    if (size > 128*1024) process.exit(1);
    if (input.length < size+4) break;
    const bytes = input.subarray(4,size+4); input = input.subarray(size+4);
    try { void receive(JSON.parse(bytes.toString('utf8'))); } catch { process.exit(1); }
  }
});
process.stdin.on('end',() => { closed=true; streamController?.abort(); process.exit(0); });
