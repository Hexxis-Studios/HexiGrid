let port, binding, chain = Promise.resolve();
const waiting = new Map();
const send = (command, body = {}) => new Promise((resolve, reject) => {
  if (!port) attach();
  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('HexiGrid did not respond.')); }, 12000);
  waiting.set(requestId, { resolve, reject, timer });
  port.postMessage({ requestId, command, body });
});
function attach() {
  port = chrome.runtime.connectNative('com.hexigrid.call_chat');
  port.onDisconnect.addListener(() => {
    port = null;
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('The browser companion disconnected.')); }
    waiting.clear(); chrome.action.setBadgeText({ text: '!' });
  });
  port.onMessage.addListener(message => {
    if (message.requestId) {
      const pending = waiting.get(message.requestId); if (!pending) return;
      waiting.delete(message.requestId); clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error));
    } else if (message.type === 'utterance' && binding) {
      const selected = binding;
      chain = chain.then(() => deliver(selected, message.turn)).catch(() => chrome.action.setBadgeText({ text: '!' }));
    }
  });
}
async function deliver(selected, offered) {
  let status = 'failed';
  const { turn } = await send('claim', { bindingId: selected.id, id: offered.id });
  try {
    if (binding?.id !== selected.id) throw new Error('Chat selection changed.');
    let tabs = await chrome.tabs.query({ url: selected.url });
    // No navigation of an unrelated user tab. Reopen only the chosen thread.
    let tab = tabs.find(t => t.active) || tabs.find(t => t.title === selected.title) || tabs[0];
    if (!tab) { await chrome.tabs.create({ url: selected.url, active: true }); throw new Error('The selected chat is opening. This turn was not submitted.'); }
    // Select the chat inside its own Chrome window, never focus the window.
    // Background pages may defer initialization, and their title can change.
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['muse.js'] });
    if (!(await send('check', { bindingId: selected.id, callId: turn.callId, mediaEpoch: turn.mediaEpoch })).active) throw new Error('Call ended, was muted, or switched participants.');
    // Once sent to the content script, an interrupted result is uncertain.
    // Never retry: Muse might already have accepted the message.
    status = 'uncertain';
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'call-utterance', selection: selected, turn });
    status = result?.submitted ? 'submitted' : result?.untouched ? 'failed' : 'uncertain';
  } finally {
    await send('report', { bindingId: selected.id, id: turn.id, status });
    await chrome.action.setBadgeText({ text: status === 'submitted' ? '' : '!' });
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Content pages cannot configure the companion or issue native requests.
  if (sender.url !== chrome.runtime.getURL('popup.html')) return false;
  (async () => {
    if (message.type === 'links') return await send('links');
    if (message.type === 'connect') {
      const result = await send('connect', { provider: message.provider, url: message.url, title: message.title, linkId: message.linkId, label: message.label });
      binding = result.binding; await chrome.storage.local.set({ binding });
      await send('subscribe', { bindingId: binding.id }); return result;
    }
    if (message.type === 'disconnect') {
      const previous = binding; binding = null; await chrome.storage.local.remove('binding');
      if (previous) await send('disconnect', { bindingId: previous.id }); return { disconnected: true };
    }
    throw new Error('Unknown call chat action.');
  })().then(result => respond({ ok: true, ...result }), () => respond({ ok: false, error: 'The call chat connection is unavailable. Check HexiGrid and your selected chat.' }));
  return true;
});
async function restore() {
  binding = (await chrome.storage.local.get('binding')).binding;
  if (binding && await chrome.permissions.contains({ origins: ['https://muse.ai/*'] })) {
    try { await send('subscribe', { bindingId: binding.id }); } catch { await chrome.action.setBadgeText({ text: '!' }); }
  }
}
chrome.runtime.onStartup.addListener(restore);
chrome.runtime.onInstalled.addListener(restore);
void restore();
