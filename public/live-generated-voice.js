(() => {
  let currentAudio = null;
  let objectUrl = '';
  const audioData = (file) => new Promise((resolve, reject) => {
    if (!file || !/^audio\/(mpeg|mp3|wav|x-wav|ogg|aac|flac|webm|mp4)$/.test(file.type)) return reject(new Error('Choose a supported audio file.'));
    if (file.size > 10 * 1024 * 1024) return reject(new Error('Each voice recording must be smaller than 10 MB.'));
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('That audio file could not be read.')); reader.readAsDataURL(file);
  });

  const speechProviders = () => (state.data?.providers || []).filter((provider) => provider.enabled && provider.capabilities?.includes('speech'));
  const selectedProvider = () => speechProviders().find((provider) => provider.id === document.querySelector('#generatedVoiceProvider')?.value) || speechProviders()[0] || null;
  const voices = () => String(document.querySelector('#generatedVoiceIds')?.value || 'alloy,nova,shimmer').split(',').map((value) => value.trim()).filter(Boolean).slice(0, 3);

  function stop() {
    currentAudio?.pause();
    currentAudio = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
  }

  async function requestClip(text, voiceOverride = '', binding = null) {
    const provider = binding ? speechProviders().find(item => item.id === binding.providerId) : selectedProvider();
    if (!provider) throw new Error('Connect a speech-capable provider first, or use the free device voices above.');
    const model = binding ? binding.model : document.querySelector('#generatedVoiceModel')?.value || '';
    if (!model) throw new Error('Choose a speech model first, or use the free device voices above.');
    const voice = voiceOverride || document.querySelector('#generatedVoiceIds')?.value.split(',')[0]?.trim() || '';
    const payload = { providerId: provider.id, model, voice, text };
    try { return await api('/api/live/speech', { method: 'POST', body: JSON.stringify(payload) }); }
    catch (error) {
      if (!error.body?.approvalRequired) throw error;
      const approved = await userConfirm('Generate this voice clip?', `This sends the supplied text to ${provider.name || 'the configured speech provider'} using ${model}. The provider may charge according to your account.`, 'Generate voice');
      if (!approved) throw new Error('Voice generation was cancelled.');
      return api('/api/live/speech', { method: 'POST', body: JSON.stringify({ ...payload, approved: true }) });
    }
  }

  async function playResult(result) {
    stop();
    if (result.media?.audioBlob) objectUrl = URL.createObjectURL(result.media.audioBlob);
    const source = result.media?.url || objectUrl;
    if (!source) throw new Error('The speech provider returned no playable audio.');
    currentAudio = new Audio(source);
    currentAudio.onended = () => { currentAudio = null; if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; } window.HexiGridLiveCall?.setStatus('Ready'); };
    currentAudio.onerror = () => window.HexiGridLiveCall?.setStatus('The generated voice clip could not be played.', true);
    await currentAudio.play();
  }

  async function preview(index) {
    const options = voices();
    const voice = options[index] || options[0];
    if (!voice) return window.HexiGridLiveCall?.setStatus('Enter one to three provider voice names or IDs.', true);
    document.querySelector('#generatedVoiceChosen').value = voice;
    window.HexiGridLiveCall?.setStatus(`Generating preview ${index + 1}…`);
    try { await playResult(await requestClip(`Hi. This is voice option ${index + 1} for ${window.HexiGridLiveCall?.selectedAgent?.()?.name || 'your agent'}.`, voice)); }
    catch (error) { window.HexiGridLiveCall?.setStatus(error.message, true); }
  }

  async function save() {
    const agent = window.HexiGridLiveCall?.selectedAgent?.();
    const provider = selectedProvider();
    const voiceId = document.querySelector('#generatedVoiceChosen')?.value.trim();
    const model = document.querySelector('#generatedVoiceModel')?.value || '';
    if (!agent || !provider || !model || !voiceId) return notify('Choose an agent, provider, model, and previewed voice first.', true);
    if (!document.querySelector('#generatedVoiceConsent')?.checked) return notify('Confirm that you own this voice or have the speaker’s permission.', true);
    try {
      const response = await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ voiceProfile: { engine: 'provider', providerId: provider.id, model, voiceId, voiceName: '', rate: 1, pitch: 1, volume: 1 } }) });
      Object.assign(agent, response.agent); notify('Generated voice saved to this agent. Future spoken replies use this provider.'); render();
    } catch (error) { notify(error.message, true); }
  }

  async function useDeviceVoice() {
    const agent = window.HexiGridLiveCall?.selectedAgent?.(); if (!agent) return;
    try { const response = await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ voiceProfile: { ...agent.voiceProfile, engine: 'browser', providerId: '', model: '', voiceId: '' } }) }); Object.assign(agent, response.agent); notify('This agent now uses the free device voice.'); render(); }
    catch (error) { notify(error.message, true); }
  }

  async function createVoice(approved = false) {
    const provider = selectedProvider();
    const agent = window.HexiGridLiveCall?.selectedAgent?.();
    const name = document.querySelector('#customVoiceName')?.value.trim();
    const language = document.querySelector('#customVoiceLanguage')?.value.trim();
    const consentFile = document.querySelector('#customVoiceConsentFile')?.files?.[0];
    const sampleFile = document.querySelector('#customVoiceSampleFile')?.files?.[0];
    const confirmed = document.querySelector('#customVoiceSpeakerConsent')?.checked;
    if (!provider || !agent || !name || !language || !consentFile || !sampleFile || !confirmed) return window.HexiGridLiveCall?.setStatus('Choose the provider, agent, name, language, both recordings, and confirm the speaker’s consent.', true);
    try {
      window.HexiGridLiveCall?.setStatus('Creating the consented custom voice…');
      const payload = { providerId: provider.id, agentId: agent.id, name, language, consentAudio: await audioData(consentFile), sampleAudio: await audioData(sampleFile), consentConfirmed: true, approved };
      let response;
      try { response = await api('/api/live/custom-voice', { method: 'POST', body: JSON.stringify(payload) }); }
      catch (error) {
        if (!error.body?.approvalRequired) throw error;
        const accepted = await userConfirm('Create this custom voice?', 'Both recordings will be uploaded to the chosen provider. Custom voices may require an eligible paid provider account.', 'Create voice');
        if (!accepted) throw new Error('Custom voice creation was cancelled.');
        return createVoice(true);
      }
      document.querySelector('#generatedVoiceIds').value = response.voice.voiceId;
      document.querySelector('#generatedVoiceChosen').value = response.voice.voiceId;
      window.HexiGridLiveCall?.setStatus('Custom voice created. Use the three preview buttons to review it, then save it to the agent.');
      notify('Custom voice created. Preview it before saving.');
    } catch (error) { window.HexiGridLiveCall?.setStatus(error.message, true); }
  }

  function renderModels() {
    const provider = selectedProvider();
    const model = document.querySelector('#generatedVoiceModel'); if (!model) return;
    const preferred = window.HexiGridLiveCall?.selectedAgent?.()?.voiceProfile?.model;
    model.innerHTML = (provider?.modelIds || []).map((id) => `<option value="${escapeHtml(id)}" ${id === preferred ? 'selected' : ''}>${escapeHtml(id)}</option>`).join('') || '<option value="">No models reported</option>';
  }

  function render() {
    const root = document.querySelector('#generatedVoiceLab'); if (!root) return;
    const agent = window.HexiGridLiveCall?.selectedAgent?.();
    const providers = speechProviders();
    const select = document.querySelector('#generatedVoiceProvider');
    const prior = agent?.voiceProfile?.providerId || select?.value;
    select.innerHTML = providers.map((provider) => `<option value="${escapeHtml(provider.id)}" ${provider.id === prior ? 'selected' : ''}>${escapeHtml(provider.name)}</option>`).join('') || '<option value="">No speech provider connected</option>';
    document.querySelector('#generatedVoiceChosen').value = agent?.voiceProfile?.voiceId || '';
    root.classList.toggle('is-unavailable', !providers.length);
    renderModels();
  }

  function mount() {
    const panel = document.querySelector('.live-voice-panel');
    if (!panel || document.querySelector('#generatedVoiceLab')) return;
    panel.insertAdjacentHTML('beforeend', `<div id="generatedVoiceLab" class="generated-voice-lab"><div class="generated-voice-head"><div><div class="eyebrow">OPTIONAL GENERATED VOICE</div><h4>Use a speech provider</h4></div><span class="status-badge">MAY COST MONEY</span></div><p class="panel-copy">The free device voices above work offline. A connected OpenAI-compatible speech service can also preview provider voices or create a consented custom voice when that provider allows it.</p><div class="generated-voice-grid"><label>Speech provider<select id="generatedVoiceProvider"></select></label><label>Speech model<select id="generatedVoiceModel"></select></label><label>Up to three voice names or IDs<input id="generatedVoiceIds" value="alloy,nova,shimmer" maxlength="620"></label><label>Chosen voice<input id="generatedVoiceChosen" readonly placeholder="Preview an option"></label></div><label class="checkbox-control generated-voice-consent"><input id="generatedVoiceConsent" type="checkbox"> I own this voice or have the speaker’s permission to use it</label><div class="live-voice-actions"><button class="secondary-button" type="button" data-generated-voice="preview" data-index="0">Generate preview 1</button><button class="secondary-button" type="button" data-generated-voice="preview" data-index="1">Generate preview 2</button><button class="secondary-button" type="button" data-generated-voice="preview" data-index="2">Generate preview 3</button><button class="primary-button" type="button" data-generated-voice="save">Use chosen voice</button><button class="ghost-button" type="button" data-generated-voice="device">Use free device voice</button></div><details class="custom-voice-creator"><summary>Create a custom voice from consented recordings</summary><p class="panel-copy">This is only available to eligible providers. The speaker records the provider’s required consent phrase, then supplies a clear voice sample. HexiGrid forwards both files once and does not store them.</p><div class="generated-voice-grid"><label>Voice name<input id="customVoiceName" maxlength="80" placeholder="e.g. Atlas voice"></label><label>Language<input id="customVoiceLanguage" maxlength="35" value="en-US" placeholder="en-US"></label><label>Consent recording<input id="customVoiceConsentFile" type="file" accept="audio/mpeg,audio/wav,audio/ogg,audio/aac,audio/flac,audio/webm,audio/mp4"></label><label>Voice sample<input id="customVoiceSampleFile" type="file" accept="audio/mpeg,audio/wav,audio/ogg,audio/aac,audio/flac,audio/webm,audio/mp4"></label></div><label class="checkbox-control generated-voice-consent"><input id="customVoiceSpeakerConsent" type="checkbox"> The speaker knowingly agreed to create and use this custom voice</label><button class="primary-button" type="button" data-generated-voice="create-custom">Create custom voice</button></details></div>`);
    render();
  }

  async function speakText(text, agent) {
    if (agent?.voiceProfile?.engine !== 'provider') return false;
    const profile = { ...agent.voiceProfile };
    try { await playResult(await requestClip(text, profile.voiceId, { providerId: profile.providerId, model: profile.model })); }
    catch (error) { window.HexiGridLiveCall?.setStatus(`${error.message} The full reply remains in text.`, true); }
    return true;
  }

  document.addEventListener('click', (event) => { const button = event.target.closest('[data-generated-voice]'); if (!button) return; if (button.dataset.generatedVoice === 'preview') preview(Number(button.dataset.index)); if (button.dataset.generatedVoice === 'save') save(); if (button.dataset.generatedVoice === 'device') useDeviceVoice(); if (button.dataset.generatedVoice === 'create-custom') createVoice(); });
  document.addEventListener('change', (event) => { if (event.target.id === 'generatedVoiceProvider') renderModels(); });
  window.addEventListener('hexigrid:rendered', () => { mount(); render(); });
  window.addEventListener('beforeunload', stop);
  window.HexiGridGeneratedVoice = Object.freeze({ mount, render, speakText, stop });
  setTimeout(mount, 0);
})();
