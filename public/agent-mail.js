(() => {
  let mounted = false;
  let watchTimer = 0;
  const lastSeen = new Map();
  const seenMessages = new Set();
  const selectedAgent = () => window.HexiGridLiveCall?.selectedAgent?.();

  function status(message, error = false) {
    const node = document.querySelector('#agentMailStatus');
    if (node) { node.textContent = message; node.classList.toggle('error', error); }
  }

  async function ensureGoogle() {
    if (!window.HexiGridGoogle) throw new Error('Google Mail is still loading. Try once more.');
    if (!window.HexiGridGoogle.mailConnected()) await window.HexiGridGoogle.connectMail();
  }

  async function receipt(agent, action, receiptStatus) {
    try { await api('/api/live/email-receipt', { method: 'POST', body: JSON.stringify({ agentId: agent.id, action, status: receiptStatus }) }); }
    catch { /* Never repeat an external action merely because its local receipt could not be saved. */ }
  }

  async function send(kind) {
    const agent = selectedAgent();
    if (!agent?.externalEmail) throw new Error('Edit this agent and add their working iLands email first.');
    await ensureGoogle();
    let text = document.querySelector('#agentMailText')?.value.trim() || '';
    let subject = `HexiGrid message for ${agent.name}`;
    if (kind === 'invite') {
      const remote = state.network?.tunnel?.running ? state.network.tunnel.url : location.origin;
      const pair = state.network?.pairingCode ? `?pair=${encodeURIComponent(state.network.pairingCode)}` : '';
      if (!remote.startsWith('https://')) throw new Error('Open a temporary remote link in Settings first.');
      subject = `Live call invitation from HexiGrid`;
      text = `Open this private call link while HexiGrid is running:\n${remote}/${pair}\n\nSign in normally after pairing. Do not forward this temporary link.`;
    }
    if (!text) throw new Error('Write a message first.');
    try { await window.HexiGridGoogle.sendAgentEmail({ to: agent.externalEmail, subject, text }); }
    catch (error) { await receipt(agent, kind === 'invite' ? 'invite' : 'send', 'failed'); throw error; }
    await receipt(agent, kind === 'invite' ? 'invite' : 'send', 'completed');
    window.HexiGridLiveCall?.addEntry?.('user', text, null, 'You · email');
    if (kind !== 'invite') document.querySelector('#agentMailText').value = '';
    status(`Sent to ${agent.name} by email.`);
  }

  async function check() {
    const agent = selectedAgent();
    if (!agent?.externalEmail) throw new Error('Edit this agent and add their working iLands email first.');
    await ensureGoogle();
    let messages;
    try { messages = await window.HexiGridGoogle.listAgentEmails(agent.externalEmail, lastSeen.get(agent.id) || Date.now() - 86400000); }
    catch (error) { await receipt(agent, 'check', 'failed'); throw error; }
    const fresh = messages.filter((message) => !seenMessages.has(message.id));
    for (const message of fresh) {
      seenMessages.add(message.id);
      window.HexiGridLiveCall?.addEntry?.('agent', message.text, agent.id, `${agent.name} · email`);
    }
    if (messages.length) lastSeen.set(agent.id, messages.at(-1).receivedAt);
    await receipt(agent, 'check', 'completed');
    status(fresh.length ? `Received ${fresh.length} new repl${fresh.length === 1 ? 'y' : 'ies'}.` : 'No new replies yet.');
  }

  async function toggleWatch(button) {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = 0; button.textContent = 'Watch replies'; return status('Automatic email checks stopped.'); }
    await check();
    watchTimer = setInterval(() => { if (!document.hidden) check().catch((error) => status(error.message, true)); }, 15000);
    button.textContent = 'Stop watching'; status('Watching for replies while this page stays open.');
  }

  function mount() {
    if (mounted) return;
    const conversation = document.querySelector('.live-conversation'); if (!conversation) return;
    conversation.insertAdjacentHTML('beforeend', `<section class="agent-mail-panel"><div class="eyebrow">AGENT EMAIL BRIDGE</div><h4>Message the actual agent</h4><p class="panel-copy">Uses the selected agent's working email as a real external channel. Google asks separately for Mail permission; HexiGrid never asks for or stores the agent's password.</p><textarea id="agentMailText" rows="3" maxlength="50000" placeholder="Write to this agent…"></textarea><div class="live-voice-actions"><button class="secondary-button" data-agent-mail="send" type="button">Send email</button><button class="secondary-button" data-agent-mail="check" type="button">Check replies</button><button class="secondary-button" data-agent-mail="watch" type="button">Watch replies</button><button class="ghost-button" data-agent-mail="invite" type="button">Email call link</button></div><p id="agentMailStatus" class="form-feedback" role="status"></p></section>`);
    mounted = true;
  }

  document.addEventListener('click', (event) => { const button = event.target.closest('[data-agent-mail]'); if (!button) return; button.disabled = true; const action = button.dataset.agentMail; (action === 'check' ? check() : action === 'watch' ? toggleWatch(button) : send(action)).catch((error) => status(error.message, true)).finally(() => { button.disabled = false; }); });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', mount, { once: true }) : mount();
})();
