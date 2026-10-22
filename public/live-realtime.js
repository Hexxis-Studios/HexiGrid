(() => {
  let activeCall = null;
  let mounted = false;
  let visionTimer = 0;
  let visualFramesSent = 0;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  const providers = () => (state.data?.providers || []).filter((item) => item.enabled && item.capabilities?.includes('realtime') && ['openai-chat', 'openai-responses'].includes(item.apiStyle));
  const selectedProvider = () => providers().find((item) => item.id === document.querySelector('#realtimeProvider')?.value) || providers()[0] || null;

  function setConnected() {
    const connected = activeCall?.connected;
    const start = document.querySelector('#realtimeStart');
    const stop = document.querySelector('#realtimeStop');
    if (start) start.disabled = Boolean(activeCall) || !providers().length || !window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia;
    if (stop) stop.disabled = !activeCall;
    document.querySelector('#realtimeCallState')?.replaceChildren(document.createTextNode(connected ? 'CONNECTED' : activeCall ? 'CONNECTING' : 'READY'));
  }

  function renderModels() {
    const select = document.querySelector('#realtimeModel');
    if (!select) return;
    const prior = select.value;
    const models = selectedProvider()?.modelIds || [];
    select.innerHTML = models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('') || '<option value="">No realtime models reported</option>';
    if (models.includes(prior)) select.value = prior;
    else {
      const likely = models.find((model) => /realtime/i.test(model));
      if (likely) select.value = likely;
    }
  }

  function render() {
    const select = document.querySelector('#realtimeProvider');
    if (!select) return;
    const prior = select.value;
    const items = providers();
    select.innerHTML = items.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join('') || '<option value="">Connect a realtime provider first</option>';
    if (items.some((item) => item.id === prior)) select.value = prior;
    renderModels();
    setConnected();
  }

  function transcriptFromEvent(event, agent) {
    if (event.type === 'conversation.item.input_audio_transcription.completed') return { role: 'user', text: event.transcript, speaker: 'You' };
    if (['response.output_audio_transcript.done', 'response.audio_transcript.done'].includes(event.type)) {
      return { role: 'agent', text: event.transcript, speaker: agent?.name || 'Agent', agentId: agent?.id || null };
    }
    return null;
  }

  function receive(event, call) {
    if (activeCall !== call) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const line = transcriptFromEvent(message, call.agent);
    if (line?.text) window.HexiGridLiveCall?.addEntry?.(line.role, line.text, line.agentId, line.speaker);
    if (message.type === 'error') window.HexiGridLiveCall?.setStatus(message.error?.message || 'The realtime provider reported an error.', true);
    if (message.type === 'output_audio_buffer.started') window.HexiGridLiveCall?.setStatus('Agent is speaking…');
    if (message.type === 'output_audio_buffer.stopped') window.HexiGridLiveCall?.setStatus('Realtime call connected');
  }

  function stopVision() { clearInterval(visionTimer); visionTimer = 0; window.HexiGridLiveCall?.updatePrivacy?.(false); }

  function sendVisualFrame() {
    const channel = activeCall?.connected ? activeCall.channel : null;
    if (!document.querySelector('#realtimeVision')?.checked || channel?.readyState !== 'open') return;
    if (channel.bufferedAmount > 512 * 1024) return;
    const frame = window.HexiGridLiveCall?.frameFromPreview?.(512, .58);
    if (!frame || frame.length > 400 * 1024) return;
    channel.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: frame, detail: 'low' }] } }));
    visualFramesSent += 1;
    document.querySelector('#realtimeVisionCount')?.replaceChildren(document.createTextNode(`${visualFramesSent} frame${visualFramesSent === 1 ? '' : 's'} sent`));
  }

  function syncVision() {
    stopVision();
    if (!activeCall?.connected || !document.querySelector('#realtimeVision')?.checked) return;
    if (!window.HexiGridLiveCall?.frameFromPreview?.(64, .3)) {
      document.querySelector('#realtimeVision').checked = false;
      return window.HexiGridLiveCall?.setStatus('Start the camera or screen preview before sharing live visual frames.', true);
    }
    const fps = Math.min(1, Math.max(.25, Number(document.querySelector('#realtimeVisionRate')?.value) || .5));
    sendVisualFrame();
    visionTimer = setInterval(sendVisualFrame, Math.round(1000 / fps));
    window.HexiGridLiveCall?.updatePrivacy?.(true);
    window.HexiGridLiveCall?.setStatus(`Live visual context on at ${fps} frame${fps === 1 ? '' : 's'} per second.`);
  }

  async function start() {
    if (activeCall) return;
    const provider = selectedProvider();
    const model = document.querySelector('#realtimeModel')?.value;
    const agent = window.HexiGridLiveCall?.selectedAgent?.();
    if (!provider || !model || !agent) return window.HexiGridLiveCall?.setStatus('Choose an agent and a realtime provider model first.', true);
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) return window.HexiGridLiveCall?.setStatus('Realtime audio calls are not supported in this browser. Text and device voice still work.', true);
    const call = { agent: { id: agent.id, name: agent.name }, controller: new AbortController(), connected: false };
    activeCall = call; setConnected();
    const request = { providerId: provider.id, model, agentId: agent.id, voice: agent.voiceProfile?.engine === 'provider' ? agent.voiceProfile.voiceId : '' };
    try {
      window.HexiGridLiveCall?.setStatus('Requesting microphone. End call cancels this connection.');
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (activeCall !== call) { microphone.getTracks().forEach(track => track.stop()); return; }
      call.microphone = microphone;
      const peer = call.peer = new RTCPeerConnection();
      const remoteAudio = call.remoteAudio = new Audio(); remoteAudio.autoplay = true;
      peer.ontrack = (event) => {
        if (activeCall !== call) return;
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play().catch(() => { if (activeCall === call) window.HexiGridLiveCall?.setStatus('Tap the page once to allow call audio.', true); });
      };
      peer.onconnectionstatechange = () => {
        if (activeCall === call && ['failed', 'closed', 'disconnected'].includes(peer.connectionState)) stop(peer.connectionState === 'failed' ? 'Realtime connection failed.' : 'Realtime call ended.');
      };
      microphone.getAudioTracks().forEach((track) => peer.addTrack(track, microphone));
      const channel = call.channel = peer.createDataChannel('oai-events'); channel.addEventListener('message', event => receive(event, call));
      const offer = await peer.createOffer();
      if (activeCall !== call) return;
      await peer.setLocalDescription(offer);
      if (activeCall !== call) return;
      const sendOffer = approved => api('/api/live/realtime/call', { method: 'POST', signal: call.controller.signal, body: JSON.stringify({ ...request, sdp: offer.sdp, approved }) });
      let response;
      try {
        response = await sendOffer(false);
      } catch (error) {
        if (activeCall !== call) return;
        if (!error.body?.approvalRequired) throw error;
        const accepted = await userConfirm('Start realtime voice call?', `Your microphone audio will stream to ${provider.name} using ${model} for ${call.agent.name}. Usage may be billed by that provider.`, 'Start call');
        if (activeCall !== call) return;
        if (!accepted) throw new Error('Realtime call cancelled.');
        response = await sendOffer(true);
      }
      if (activeCall !== call) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: response.answerSdp });
      if (activeCall !== call) return;
      call.connected = true; setConnected(); syncVision(); window.HexiGridLiveCall?.setStatus('Realtime call connected');
    } catch (error) { if (activeCall === call) stop(error.message, true); }
  }

  function stop(message = 'Realtime call ended.', error = false) {
    stopVision(); visualFramesSent = 0;
    const call = activeCall; activeCall = null;
    const vision = document.querySelector('#realtimeVision'); if (vision) vision.checked = false;
    call?.controller.abort();
    const channel = call?.channel;
    try { if (channel?.readyState === 'open') { channel.send(JSON.stringify({ type: 'response.cancel' })); channel.send(JSON.stringify({ type: 'output_audio_buffer.clear' })); } } catch { /* peer may already be closed */ }
    channel?.close();
    call?.peer?.close();
    call?.microphone?.getTracks().forEach((track) => track.stop());
    if (call?.remoteAudio) { call.remoteAudio.pause(); call.remoteAudio.srcObject = null; }
    document.querySelector('#realtimeVisionCount')?.replaceChildren(document.createTextNode('No visual frames sent'));
    setConnected(); render();
    if (message) window.HexiGridLiveCall?.setStatus(message, error);
  }

  function mount() {
    if (mounted) return;
    const conversation = document.querySelector('.live-conversation');
    if (!conversation) return;
    conversation.insertAdjacentHTML('afterbegin', `<section class="realtime-call-panel"><div class="generated-voice-head"><div><div class="eyebrow">REALTIME AUDIO + OPTIONAL VISION</div><h4>Call this agent</h4></div><span id="realtimeCallState" class="status-badge">READY</span></div><p class="panel-copy">Your microphone uses an encrypted WebRTC call with the provider you choose below. Live visual context is separate and off by default. This does not claim to be the iLands app voice channel; current public Runner access has no media transport.</p><div class="generated-voice-grid"><label>Realtime provider<select id="realtimeProvider"></select></label><label>Realtime model<select id="realtimeModel"></select></label></div><div class="realtime-vision-controls"><label class="checkbox-control"><input id="realtimeVision" type="checkbox"> Share live visual context</label><label>Visual rate<select id="realtimeVisionRate"><option value="0.25">Every 4 seconds</option><option value="0.5" selected>Every 2 seconds</option><option value="1">Every second</option></select></label><small id="realtimeVisionCount">No visual frames sent</small></div><div class="live-voice-actions"><button id="realtimeStart" class="primary-button" type="button" data-realtime-action="start">Start realtime call</button><button id="realtimeStop" class="ghost-button" type="button" data-realtime-action="stop" disabled>End call</button></div></section>`);
    mounted = true; render();
  }

  document.addEventListener('click', (event) => { const button = event.target.closest('[data-realtime-action]'); if (!button) return; if (button.dataset.realtimeAction === 'start') start(); else stop(); });
  document.addEventListener('change', (event) => {
    if (event.target.matches('#realtimeProvider, #realtimeModel, #liveAgentSelect') && activeCall) stop('Call ended because the selected agent or connection changed. Start a new call when ready.');
    if (event.target.id === 'realtimeProvider') renderModels();
    if (event.target.matches('#realtimeVision, #realtimeVisionRate')) syncVision();
  });
  window.addEventListener('hexigrid:rendered', () => { mount(); render(); });
  window.addEventListener('beforeunload', () => stop(''));
  window.HexiGridRealtime = Object.freeze({ render, stop });
  setTimeout(mount, 0);
})();
