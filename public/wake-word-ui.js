(() => {
  const phraseInput = document.querySelector('#wakeWordPhrase');
  if (!phraseInput) return;
  let config = null;
  let stateSnapshot = null;
  let request = null;
  let engine = null;
  let templates = [];
  let commandWatch = 0;
  let previousLocalState = false;
  let activeCommandName = '';

  const target = () => {
    const select = document.querySelector('#desktopBridgeLink');
    const option = select?.selectedOptions?.[0];
    return { linkId: select?.value || '', name: option?.textContent?.split(' · ')[0] || 'connected Hexonaut' };
  };
  const targetFor = (linkId) => {
    const select = document.querySelector('#desktopBridgeLink');
    const option = [...(select?.options || [])].find((item) => item.value === linkId);
    return { linkId: linkId || '', name: option?.textContent?.split(' · ')[0] || 'connected Hexonaut' };
  };
  const wakeSettings = () => stateSnapshot?.settings?.wakeWord || {};
  const agentSetting = (agentId) => wakeSettings().agents?.[agentId] || {};
  const status = (message, error = false) => {
    const root = document.querySelector('#wakeWordStatus'); if (root) { root.textContent = message; root.classList.toggle('error', error); }
  };
  const renderIndicator = (current = engine?.state?.() || {}) => {
    const indicator = ensureIndicator(); const visible = current.localDetector || current.commandActive;
    indicator.hidden = !visible; indicator.classList.toggle('command-live', Boolean(current.commandActive));
    indicator.textContent = current.commandActive ? `● Microphone live to ${activeCommandName || 'the selected Hexonaut'} — listening for your command` : '● Local wake-word detector active — audio stays on this computer';
  };
  const beep = () => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext; if (!AudioContext) return;
      const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.frequency.value = 720; gain.gain.setValueAtTime(0.0001, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09); oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.1); oscillator.addEventListener('ended', () => void context.close());
    } catch {}
  };
  const ensureIndicator = () => {
    let indicator = document.querySelector('#wakeWordLiveIndicator');
    if (indicator) return indicator;
    indicator = document.createElement('aside'); indicator.id = 'wakeWordLiveIndicator'; indicator.className = 'wake-word-live'; indicator.hidden = true; indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-live', 'assertive'); indicator.textContent = '● Local wake-word detector active — audio stays on this computer'; document.body.append(indicator); return indicator;
  };
  const setButtonText = () => {
    const train = document.querySelector('#wakeWordTrain'); const selected = target().linkId; const sampleCount = selected ? (agentSetting(selected).sampleCount || templates.length) : 0;
    if (train) train.textContent = `Record sample ${Math.min(3, sampleCount + 1)} of 3`;
  };
  const syncEngine = () => {
    const selected = target().linkId; const setting = agentSetting(selected);
    templates = Object.entries(wakeSettings().agents || {}).flatMap(([agentId, config]) => (config.samples || []).map((frames) => ({ agentId, phrase: config.phrase, frames })));
    const next = { ...wakeSettings(), ...setting, agentId: selected, phrase: setting.phrase || wakeSettings().defaultPhrase || `Hey ${target().name}` };
    engine?.setSettings(next); engine?.setTemplates(templates);
    const enabled = wakeSettings().enabled === true;
    document.querySelector('#wakeWordEnabled').checked = enabled;
    document.querySelector('#wakeWordAlways').checked = wakeSettings().alwaysListening === true;
    document.querySelector('#wakeWordPushToTalk').checked = wakeSettings().pushToTalk !== false;
    phraseInput.value = next.phrase || '';
    setButtonText();
  };
  async function saveSettings(patch = {}) {
    const selected = target().linkId; if (!selected) throw new Error('Choose the exact connected Hexonaut first.');
    const current = wakeSettings(); const agent = { ...(current.agents?.[selected] || {}), phrase: phraseInput.value.trim() || `Hey ${target().name}` };
    const result = await request('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wakeWord: { ...current, ...patch, agents: { ...(current.agents || {}), [selected]: agent } } }) });
    stateSnapshot.settings.wakeWord = result.settings.wakeWord; syncEngine(); return result;
  }
  async function startCommand({ stream, preRollBlob, preRollDurationMs, reason, agentId = '' }) {
    const selected = targetFor(agentId || target().linkId); const bridge = stateSnapshot?.settings?.desktopBridge;
    if (!selected.linkId || !bridge?.enabled || bridge.linkId !== selected.linkId) {
      for (const track of stream?.getTracks?.() || []) track.stop(); engine.finishCommand(); status('Choose the same Hexonaut in Computer bridge and start access before using voice activation.', true); return;
    }
    activeCommandName = selected.name; beep(); renderIndicator({ ...engine.state(), commandActive: true }); status(reason === 'push-to-talk' ? 'Push to talk is live. Release the button to stop.' : `Wake word heard. Listening to ${selected.name}…`);
    try {
      await request('/api/desktop-bridge/presence/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId: selected.linkId, reason }) });
      await window.HexiGridDesktopMedia.start({ microphone: true, speaker: true, microphoneStream: stream, preRollBlob, preRollDurationMs, endWhenSilent: reason !== 'push-to-talk', silenceMs: wakeSettings().silenceMs, commandTimeoutMs: wakeSettings().commandTimeoutMs, agentName: selected.name, request });
      clearInterval(commandWatch); commandWatch = window.setInterval(() => {
        const active = window.HexiGridDesktopMedia.state?.();
        if (!active?.microphone) { clearInterval(commandWatch); commandWatch = 0; activeCommandName = ''; engine.finishCommand(); renderIndicator(); status('Command ended. Local detector is ready again.'); }
      }, 250);
    } catch (error) { for (const track of stream?.getTracks?.() || []) track.stop(); await request('/api/desktop-bridge/presence/recede', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'capture-failed' }) }).catch(() => {}); activeCommandName = ''; engine.finishCommand(); renderIndicator(); status(error.message || 'The voice command could not start.', true); }
  }
  function mount(next = {}) {
    request = next.request || request; stateSnapshot = next.state || stateSnapshot; config = next;
    ensureIndicator();
    if (!engine) {
      engine = window.HexiGridWakeWord?.createWakeWordEngine({
        onState: (current) => { const local = current.localDetector; renderIndicator(current); if (!current.commandActive && local !== previousLocalState) { previousLocalState = local; status(local ? 'Local wake-word detector active. No audio is leaving this computer.' : 'Local detection is off. No microphone audio is leaving this computer.'); } setButtonText(); },
        onTrigger: (event) => { void startCommand(event); },
        onError: (error) => status(error.message || 'The local detector stopped.', true)
      });
    }
    syncEngine();
  }
  document.querySelector('#wakeWordEnable')?.addEventListener('click', async () => { try { await saveSettings({ enabled: true }); await engine.enable(); status('Local wake-word detector active. Audio stays on this computer until the phrase fires.'); } catch (error) { status(error.message, true); } });
  document.querySelector('#wakeWordDisable')?.addEventListener('click', async () => { try { await saveSettings({ enabled: false }); engine.disable(); status('Local detection is off. No microphone audio is leaving this computer.'); } catch (error) { status(error.message, true); } });
  document.querySelector('#wakeWordEnabled')?.addEventListener('change', async (event) => { try { if (event.currentTarget.checked) { await saveSettings({ enabled: true }); await engine.enable(); } else { await saveSettings({ enabled: false }); engine.disable(); } } catch (error) { event.currentTarget.checked = false; status(error.message, true); } });
  document.querySelector('#wakeWordAlways')?.addEventListener('change', async (event) => { try { await saveSettings({ alwaysListening: event.currentTarget.checked }); if (event.currentTarget.checked && !engine.state().localDetector) await engine.enable(); } catch (error) { status(error.message, true); } });
  document.querySelector('#wakeWordPushToTalk')?.addEventListener('change', async (event) => { try { await saveSettings({ pushToTalk: event.currentTarget.checked }); } catch (error) { status(error.message, true); } });
  phraseInput.addEventListener('change', async () => { try { await saveSettings(); } catch (error) { status(error.message, true); } });
  document.querySelector('#desktopBridgeLink')?.addEventListener('change', () => { syncEngine(); if (engine?.state().commandActive) engine.finishCommand(); });
  document.querySelector('#wakeWordTrain')?.addEventListener('click', async () => {
    try { const selected = target(); if (!selected.linkId) throw new Error('Choose the exact connected Hexonaut first.'); status('Recording one local training sample. Say the phrase clearly…'); const sample = await engine.trainSample(); await request('/api/wake-word/training', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: selected.linkId, phrase: phraseInput.value.trim() || `Hey ${selected.name}`, features: sample }) }); stateSnapshot.settings.wakeWord.agents ||= {}; const prior = stateSnapshot.settings.wakeWord.agents[selected.linkId] || {}; const samples = [...(prior.samples || []), sample].slice(-3); stateSnapshot.settings.wakeWord.agents[selected.linkId] = { ...prior, agentId: selected.linkId, phrase: phraseInput.value.trim() || `Hey ${selected.name}`, samples, sampleCount: samples.length, trained: samples.length >= 3 }; syncEngine(); setButtonText(); status(`Sample ${samples.length} of 3 saved locally. Raw audio was discarded.`); } catch (error) { status(error.message || 'The training sample could not be saved.', true); }
  });
  const push = document.querySelector('#wakeWordPush');
  push?.addEventListener('pointerdown', async () => { try { await saveSettings({ enabled: true }); await engine.pushToTalkStart(); } catch (error) { status(error.message, true); } });
  const release = () => { if (!engine?.state().commandActive) return; void window.HexiGridDesktopMedia?.stop?.('microphone', true).finally?.(() => { activeCommandName = ''; engine.finishCommand(); renderIndicator(); status('Push-to-talk ended.'); }); };
  push?.addEventListener('pointerup', release); push?.addEventListener('pointercancel', release); push?.addEventListener('pointerleave', release);
  window.HexiGridWakeWordUI = Object.freeze({ mount, sync: mount });
})();
