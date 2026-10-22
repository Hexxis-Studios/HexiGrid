const status = document.querySelector('#status');
const request = message => chrome.runtime.sendMessage(message);
try {
  const result = await request({ type: 'links' });
  if (!result.ok) throw new Error(result.error);
  for (const link of result.links) {
    const option = document.createElement('option'); option.value = link.id; option.textContent = link.name;
    document.querySelector('#agent').append(option);
  }
  const saved = await chrome.storage.local.get('binding');
  status.textContent = saved.binding ? `Calls use: ${saved.binding.label}` : 'Choose the conversation you want to use.';
} catch { status.textContent = 'Start HexiGrid and install its browser companion, then try again.'; }
document.querySelector('#connect').onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || new URL(tab.url).origin !== 'https://muse.ai' || !(new URL(tab.url).pathname === '/' || /^\/thread\/[a-f0-9-]{36}$/.test(new URL(tab.url).pathname))) {
      throw new Error('Open the conversation you want calls to use first.');
    }
    if (!await chrome.permissions.request({ origins: ['https://muse.ai/*'] })) throw new Error('Chat access was not enabled.');
    const result = await request({ type: 'connect', provider: 'muse', url: tab.url, title: tab.title,
      linkId: document.querySelector('#agent').value, label: document.querySelector('#label').value });
    if (!result.ok) throw new Error(result.error);
    status.textContent = 'Connected. Accepted calls will send your speech to this chat automatically.';
  } catch (error) { status.textContent = error.message; }
};
document.querySelector('#disconnect').onclick = async () => {
  const result = await request({ type: 'disconnect' });
  status.textContent = result.ok ? 'Call chat disconnected.' : result.error;
};
