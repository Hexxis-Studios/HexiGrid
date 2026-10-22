(() => {
  const speech = () => window.speechSynthesis;
  let available = [];
  let speechAttempt = 0;

  function localVoices() {
    return supported() ? speech().getVoices().filter((voice) => voice?.name && voice.localService === true)
      .sort((a, b) => `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`)) : [];
  }

  function supported() {
    const engine = speech();
    return Boolean(engine && typeof engine.speak === 'function' && typeof engine.cancel === 'function' && typeof window.SpeechSynthesisUtterance === 'function');
  }

  function refreshVoices() {
    available = localVoices();
    const select = document.querySelector('#liveVoiceSelect');
    if (!select) return;
    const agent = typeof window.HexiGridLiveCall?.selectedAgent === 'function' ? window.HexiGridLiveCall.selectedAgent() : null;
    const selected = agent?.voiceProfile?.voiceName || '';
    select.innerHTML = `<option value="">Default local voice</option>${available.map((voice) => `<option value="${escapeHtml(voice.name)}" ${voice.name === selected ? 'selected' : ''}>${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`).join('')}`;
    document.querySelector('#liveVoiceSupport').textContent = available.length ? `${available.length} local voice${available.length === 1 ? '' : 's'} available on this device. Remote browser voices are excluded.` : 'No local speech voice is available. Text transcripts still work.';
  }

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }

  function profileFromControls() {
    const rate = Number(document.querySelector('#liveVoiceRate')?.value || 1);
    const pitch = Number(document.querySelector('#liveVoicePitch')?.value || 1);
    const volume = Number(document.querySelector('#liveVoiceVolume')?.value || 1);
    return { voiceName: document.querySelector('#liveVoiceSelect')?.value || '', rate, pitch, volume };
  }

  function speak(text, agent = null) {
    if (agent?.voiceProfile?.engine === 'provider' && window.HexiGridGeneratedVoice?.speakText) {
      window.HexiGridGeneratedVoice.speakText(text, agent);
      return true;
    }
    if (!supported() || !text) return false;
    // Recheck at dispatch: a saved voice may no longer be installed or local.
    available = localVoices();
    const profile = agent?.voiceProfile || profileFromControls();
    const voice = profile.voiceName ? available.find((item) => item.name === profile.voiceName)
      : available.find((item) => item.default) || available[0];
    if (profile.voiceName && !voice) { stop(); window.HexiGridLiveCall?.setStatus('The chosen voice is unavailable on this device. Choose another voice; your reply remains as text.', true); return false; }
    if (!voice) { stop(); window.HexiGridLiveCall?.setStatus('No local speech voice is available. Your reply remains as text.', true); return false; }
    const attempt = ++speechAttempt;
    speech().cancel();
    const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 20000));
    utterance.voice = voice;
    utterance.rate = Math.min(2, Math.max(0.5, Number(profile.rate) || 1));
    utterance.pitch = Math.min(2, Math.max(0, Number.isFinite(Number(profile.pitch)) ? Number(profile.pitch) : 1));
    utterance.volume = Math.min(1, Math.max(0, Number.isFinite(Number(profile.volume)) ? Number(profile.volume) : 1));
    utterance.onstart = () => { if (attempt === speechAttempt) window.HexiGridLiveCall?.setStatus('Speaking · local device voice'); };
    utterance.onend = () => { if (attempt === speechAttempt) window.HexiGridLiveCall?.setStatus('Ready'); };
    utterance.onerror = () => { if (attempt === speechAttempt) window.HexiGridLiveCall?.setStatus('Voice playback could not finish. Your reply remains as text.', true); };
    speech().speak(utterance);
    return true;
  }

  function stop() { ++speechAttempt; if (supported()) speech().cancel(); window.HexiGridGeneratedVoice?.stop?.(); }

  async function saveProfile() {
    const agent = window.HexiGridLiveCall?.selectedAgent?.();
    if (!agent) return notify('Choose an agent before saving a voice.', true);
    try {
      const response = await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ voiceProfile: profileFromControls() }) });
      Object.assign(agent, response.agent);
      document.dispatchEvent(new CustomEvent('hexigrid-agent-voice-changed', { detail: { agentId: agent.id } }));
      window.HexiGridLiveCall?.renderSelectors();
      notify('Voice choice saved to this agent.');
    } catch (error) { notify(error.message, true); }
  }

  function preview(index) {
    if (!supported()) return notify('Speech output is not available in this browser.', true);
    const voice = available[index % Math.max(available.length, 1)];
    const profiles = [
      { voiceName: voice?.name || '', rate: 0.92, pitch: 0.95, volume: 0.72 },
      { voiceName: available[(index + 1) % Math.max(available.length, 1)]?.name || voice?.name || '', rate: 1, pitch: 1.08, volume: 0.72 },
      { voiceName: available[(index + 2) % Math.max(available.length, 1)]?.name || voice?.name || '', rate: 1.08, pitch: 0.9, volume: 0.72 }
    ];
    const profile = profiles[index % profiles.length];
    const select = document.querySelector('#liveVoiceSelect');
    const rate = document.querySelector('#liveVoiceRate');
    const pitch = document.querySelector('#liveVoicePitch');
    const volume = document.querySelector('#liveVoiceVolume');
    if (select) select.value = profile.voiceName;
    if (rate) rate.value = profile.rate;
    if (pitch) pitch.value = profile.pitch;
    if (volume) volume.value = profile.volume;
    document.querySelector('#liveVoiceValue')?.replaceChildren(document.createTextNode(`${profile.rate.toFixed(2)}× · pitch ${profile.pitch.toFixed(2)}`));
    speak('Hi. This is a short voice preview for your agent.', { voiceProfile: profile });
  }

  function render() {
    const agent = window.HexiGridLiveCall?.selectedAgent?.();
    const profile = agent?.voiceProfile || { rate: 1, pitch: 1, volume: 1, voiceName: '' };
    const select = document.querySelector('#liveVoiceSelect');
    if (!select) return;
    refreshVoices();
    select.value = profile.voiceName || '';
    const rate = document.querySelector('#liveVoiceRate'); const pitch = document.querySelector('#liveVoicePitch'); const volume = document.querySelector('#liveVoiceVolume');
    if (rate) rate.value = profile.rate;
    if (pitch) pitch.value = profile.pitch;
    if (volume) volume.value = profile.volume;
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-live-voice-action]');
    if (!button) return;
    const action = button.dataset.liveVoiceAction;
    if (action === 'preview') preview(Number(button.dataset.preview || 0));
    if (action === 'save') saveProfile();
    if (action === 'stop') { stop(); window.HexiGridLiveCall?.setStatus('Voice preview stopped.'); }
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('#liveAgentSelect')) stop();
    if (event.target.matches('#liveVoiceSelect, #liveVoiceRate, #liveVoicePitch, #liveVoiceVolume')) {
      document.querySelector('#liveVoiceValue')?.replaceChildren(document.createTextNode(`${Number(document.querySelector('#liveVoiceRate')?.value || 1).toFixed(2)}× · pitch ${Number(document.querySelector('#liveVoicePitch')?.value || 1).toFixed(2)}`));
    }
  });
  speech()?.addEventListener?.('voiceschanged', refreshVoices);
  window.HexiGridLiveVoice = Object.freeze({ speak, stop, render, refreshVoices, supported });
})();
