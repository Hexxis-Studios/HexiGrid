import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { callWakeMessage } from './call-browser.mjs';

const exec = promisify(execFile);
const elementId = value => value?.ELEMENT || value?.['element-6066-11e4-a52e-4f735466cecf'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = text => Object.assign(new Error(text), { status: 409 });

// Existing call delivery, backed by the real Android chat. Appium's small
// device-side server supplies Unicode editing; no Appium/model server is needed.
export class AndroidCallChat {
  constructor({ profiles = [], authorize, receipt = () => {}, persist = async () => {}, prepare = prepareAndroidChat, clock = Date.now }) {
    this.profiles = profiles; this.authorize = authorize; this.receipt = receipt;
    this.persist = persist; this.prepare = prepare; this.clock = clock;
    this.queues = new Map(); this.sessions = new Map(); this.woken = new Set(); this.pending = new Map();
  }

  profile(linkId) { return this.profiles.find(p => p.enabled && p.linkId === linkId); }

  wake(call) {
    const profile = this.profile(call.linkId);
    if (!profile || this.woken.has(call.id)) return false;
    if (!this.enqueue(profile, call, 'wake', callWakeMessage(call))) return false;
    this.woken.add(call.id);
    return true;
  }

  transcript({ call, event }) {
    const profile = this.profile(call?.linkId);
    if (!profile || event?.type !== 'speech.transcript.final' || event.metadata?.source !== 'owner-microphone' || event.metadata.callId !== call.id) return false;
    const text = String(event.text || '').trim();
    if (!text || text.length > 20_000) return false;
    return this.enqueue(profile, call, 'speech', text);
  }

  enqueue(profile, call, kind, text) {
    if (!this.authorize(profile, call.id, call.mediaEpoch || 0, kind)) {
      this.receipt(profile, 'failed', 'This call does not currently permit chat delivery.'); return false;
    }
    if ((this.pending.get(profile.id) || 0) >= 8) {
      this.receipt(profile, 'failed', 'Call chat delivery is busy. This sentence remains in local call history.'); return false;
    }
    const turn = { id: crypto.randomUUID(), callId: call.id, mediaEpoch: Number(call.mediaEpoch || 0), kind, text, createdAt: this.clock() };
    this.pending.set(profile.id, (this.pending.get(profile.id) || 0) + 1);
    const previous = this.queues.get(profile.id) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      let submitted = false;
      const check = () => {
        if (this.clock() - turn.createdAt > 60_000 || !this.authorize(profile, turn.callId, turn.mediaEpoch, turn.kind)) throw failure('This call ended, was muted, held, or its access changed.');
      };
      try {
        check();
        let session = this.sessions.get(profile.id);
        if (!session) { session = await this.prepare(profile); this.sessions.set(profile.id, session); }
        check();
        const text = turn.kind === 'wake' ? turn.text : `HexiGrid call ${turn.callId}, media epoch ${turn.mediaEpoch}. Paired owner says: ${turn.text}\nAnswer this exact call through voice-call-reply with your own voice. Keep the call open between turns.`;
        const marker = `[HexiGrid turn ${turn.id}]`;
        const result = await session.send({ profile, text: `${marker}\n${text}`, marker, check, onSubmit: () => { submitted = true; } });
        profile.anchorResourceId = result.anchorResourceId;
        await this.persist(this.profiles);
        this.receipt(profile, 'completed', 'A call message was observed in the selected Android chat. The agent still needs to answer.');
      } catch (error) {
        this.sessions.delete(profile.id);
        this.receipt(profile, 'failed', submitted ? 'Android call message delivery is uncertain; it will not be resent automatically.' : error.message === 'This call ended, was muted, held, or its access changed.' ? error.message : 'The selected Android chat could not receive this call message. Existing drafts and account sessions were preserved.');
      } finally { turn.text = ''; this.pending.set(profile.id, this.pending.get(profile.id) - 1); }
    });
    this.queues.set(profile.id, job);
    return true;
  }

  async idle() { await Promise.allSettled(this.queues.values()); }
}

export async function loadAndroidCallProfiles(file) {
  const saved = await fs.readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return { version: 1, profiles: [] }; throw error; });
  if (saved.version !== 1 || !Array.isArray(saved.profiles)) throw failure('The Android call connection is invalid.');
  const ids = new Set(), links = new Set(), ports = new Set(), devices = new Set();
  for (const p of saved.profiles) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(p.id || '') || !/^link-[a-f0-9-]{36}$/.test(p.linkId || '') ||
        !/^\d+$/.test(p.agentExternalId || '') || !p.agentName || p.agentName.length > 120 || /["'<>]/.test(p.agentName) ||
        !/^timeline-message-\d+$/.test(p.anchorResourceId || '') || !/^emulator-\d{4,5}$/.test(p.serial || '') ||
        ![p.adbServerPort, p.uiPort].every(n => Number.isInteger(n) && n >= 1024 && n <= 65535) ||
        !path.isAbsolute(p.adbPath || '') || !path.isAbsolute(p.launchScript || '') || typeof p.enabled !== 'boolean' ||
        ids.has(p.id) || links.has(p.linkId) || ports.has(p.uiPort) || devices.has(`${p.adbServerPort}:${p.serial}`)) throw failure('The Android call connection is invalid or duplicated.');
    ids.add(p.id); links.add(p.linkId); ports.add(p.uiPort); devices.add(`${p.adbServerPort}:${p.serial}`);
  }
  return saved.profiles;
}

export async function saveAndroidCallProfiles(file, profiles) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, profiles }, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function prepareAndroidChat(profile) {
  const adb = async args => {
    try { return (await exec(profile.adbPath, ['-P', String(profile.adbServerPort), '-s', profile.serial, ...args], { windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024 })).stdout.trim(); }
    catch { throw failure('The selected Android app is unavailable.'); }
  };
  if (await adb(['shell', 'getprop', 'sys.boot_completed']).catch(() => '') !== '1') {
    await exec('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', profile.launchScript, '-Background'], { windowsHide: true, timeout: 15_000 }).catch(() => { throw failure('The Android call app could not start.'); });
    for (let n = 0; n < 40; n++) {
      if (await adb(['shell', 'getprop', 'sys.boot_completed']).catch(() => '') === '1') break;
      await delay(750);
    }
  }
  await adb(['forward', `tcp:${profile.uiPort}`, 'tcp:6790']);
  const base = `http://127.0.0.1:${profile.uiPort}`;
  const available = () => fetch(`${base}/status`, { signal: AbortSignal.timeout(700) }).then(r => r.ok).catch(() => false);
  if (!await available()) {
    const child = spawn(profile.adbPath, ['-P', String(profile.adbServerPort), '-s', profile.serial, 'shell', 'am', 'instrument', '-w', 'io.appium.uiautomator2.server.test/androidx.test.runner.AndroidJUnitRunner'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
    for (let n = 0; n < 30 && !await available(); n++) await delay(250);
  }
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12_000) });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw failure('The Android chat control is unavailable.');
    return result.value;
  };
  const session = await request('/session', { capabilities: { alwaysMatch: {} } });
  const prefix = `/session/${session.sessionId}`;
  await request(`${prefix}/appium/settings`, { settings: { waitForIdleTimeout: 0, disableIdLocatorAutocompletion: true } });
  const find = async (selector, strategy = 'id') => request(`${prefix}/elements`, { strategy, selector, context: '', multiple: true });
  const one = async (selector, strategy) => { const found = await find(selector, strategy); if (found.length !== 1) throw failure('The selected Android chat is not available.'); return elementId(found[0]); };
  const attr = async (id, name) => request(`${prefix}/element/${id}/attribute/${name}`);
  const click = async id => request(`${prefix}/element/${id}/click`, {});
  await adb(['shell', 'am', 'start', '-n', 'ai.ilands.app/.MainActivity']);
  return {
    async send({ profile, text, marker, check, onSubmit }) {
      check();
      if (!(await find('chat-input')).length) {
        const home = await find('tab-iland'); if (home.length === 1) await click(elementId(home[0]));
        for (let n = 0; n < 20 && !(await find('home-chat-entry')).length; n++) await delay(150);
        await click(await one('home-chat-entry'));
      }
      for (let n = 0; n < 20 && !(await find('chat-input')).length; n++) await delay(150);
      // A confirmed message anchor pins this app profile to this exact native
      // conversation. Names alone never authorize an account/conversation.
      await one(profile.anchorResourceId);
      await one(`//*[@package="ai.ilands.app" and @text="${profile.agentName}"]`, 'xpath');
      let input = await one('chat-input');
      const action = await one('send-button');
      if (await attr(action, 'contentDescription') !== 'Voice input' || !String(await attr(input, 'text')).startsWith('Say something to ')) throw failure('The Android chat has an existing draft.');
      check(); await click(input); check();
      let draftWritten = false, sendAttempted = false;
      try {
      await request(`${prefix}/element/${input}/value`, { text, replace: true }); draftWritten = true;
      input = await one('chat-input');
      if (await attr(input, 'text') !== text) throw failure('The Android call draft could not be verified.');
      check();
      const messageSelector = '//*[starts-with(@resource-id,"timeline-message-") and not(starts-with(@resource-id,"timeline-message-status-"))]';
      const before = new Set(await Promise.all((await find(messageSelector, 'xpath')).map(e => attr(elementId(e), 'resourceId'))));
      const send = await one('send-button');
      if (await attr(send, 'contentDescription') !== 'Send message') throw failure('The Android send control is not ready.');
      await one(profile.anchorResourceId);
      if (await attr(await one('chat-input'), 'text') !== text) throw failure('The Android call draft changed.');
      check(); sendAttempted = true; onSubmit(); await click(send);
      for (let n = 0; n < 40; n++) {
        const found = await find(`//*[starts-with(@text,"${marker}") and @class!="android.widget.EditText"]`, 'xpath');
        if (found.length) {
          const ids = await Promise.all((await find(messageSelector, 'xpath')).map(e => attr(elementId(e), 'resourceId')));
          const anchorResourceId = ids.find(id => !before.has(id));
          if (/^timeline-message-\d+$/.test(anchorResourceId)) return { anchorResourceId };
        }
        await delay(200);
      }
      throw failure('The Android call submission could not be confirmed.');
      } finally {
        if (draftWritten && !sendAttempted) {
          // Only our exact unsent draft can be cleared after cancellation.
          try { const current = await one('chat-input'); if (await attr(current, 'text') === text) await request(`${prefix}/element/${current}/clear`, {}); } catch { /* Preserve an unknown or owner-edited draft. */ }
        }
      }
    }
  };
}
