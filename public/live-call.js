(() => {
  let localStream = null;
  let screenStream = null;
  let mediaAttempt = 0, screenAttempt = 0;
  let mediaPending = false, screenPending = false;
  let recognition = null;
  let recognitionActive = false;
  let listeningRequested = false;
  let recognitionAttempt = 0;
  let turnController = null;
  let transcript = [];
  let pendingFrame = '';
  let realtimeSharing = false;
  let mounted = false;
  let callStartBusy = false;
  let selectedCallLinkId = '';
  let contactSaveBusy = false;
  const requestedAgentId = new URLSearchParams(location.search).get('agent') || '';

  const now = () => new Date().toISOString();
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  const addEntry = (role, text, agentId = null, speaker = role === 'user' ? 'You' : 'HexiGrid') => {
    const clean = String(text || '').trim();
    if (!clean) return;
    transcript.push({ role, text: clean, agentId, speaker, createdAt: now() });
    transcript = transcript.slice(-600);
    renderTranscript();
  };

  function selectedAgent() {
    const id = document.querySelector('#liveAgentSelect')?.value;
    return state.data?.agents?.find((item) => item.id === id) || state.data?.agents?.[0] || null;
  }

  function agentForLink(linkId) {
    const connection = (state.data?.agentLinks || []).find((item) => item.id === linkId);
    return connection?.agentId ? (state.data?.agents || []).find((item) => item.id === connection.agentId) || null : null;
  }

  function connectionForLink(linkId) {
    return (state.data?.agentLinks || []).find((item) => item.id === linkId) || null;
  }

  function nameForLink(linkId) {
    const link = connectionForLink(linkId);
    return String(link?.identity?.name || agentForLink(linkId)?.name || link?.name || 'Connected agent').trim().slice(0, 120);
  }

  function callVoicePicker(agent, name) {
    if (!agent) return '';
    const voices = window.speechSynthesis?.getVoices?.().filter(voice => voice.localService === true) || [];
    const chosen = agent.voiceProfile?.voiceName || '';
    return `<label class="call-contact__voice">Reply voice<select data-call-voice="${escapeHtml(agent.id)}" aria-label="Reply voice for ${escapeHtml(name)}"><option value="">Agent-provided audio</option>${agent.voiceProfile?.engine === 'provider' ? '<option value="__provider__" selected>Configured provider voice</option>' : ''}${voices.map(voice => `<option value="${escapeHtml(voice.name)}" ${chosen === voice.name ? 'selected' : ''}>${escapeHtml(voice.name)}</option>`).join('')}</select></label>`;
  }

  function callReadiness(link) {
    const bridge = state.data?.settings?.desktopBridge || state.data?.desktopBridge || {};
    const required = ['microphone-listen', 'speaker-output'];
    const missing = required.filter((capability) => !(link.grantedCapabilities || link.capabilities || []).includes(capability));
    const connected = !['revoked', 'stale'].includes(link.status) && (link.authorizationStatus
      ? link.authorizationStatus === 'connected'
      : ['online', 'degraded', 'connected'].includes(link.status));
    const ready = connected && bridge.enabled === true && missing.length === 0;
    let reason = 'Ready to call';
    if (!connected) reason = 'Reconnect this agent to call';
    else if (missing.length) reason = 'Allow microphone and speaker access for this agent';
    else if (!bridge.enabled) reason = 'Turn on Computer access to call';
    return { ready, reason, paired: connected };
  }

  function renderCallDirectory() {
    const root = document.querySelector('#callDirectoryList');
    if (!root || !state.data) return;
    const allLinks = [...(state.data.agentLinks || [])].filter((item) => item && item.status !== 'revoked' && item.authorizationStatus !== 'revoked' && (item.identity?.name || item.agentId || item.name));
    const hidden = new Set((state.data.settings?.hiddenCallContacts || []).filter(id => connectionForLink(id)));
    const links = allLinks.filter(link => !hidden.has(link.id));
    const removed = allLinks.filter(link => hidden.has(link.id));
    const removedPanel = document.querySelector('#removedCallContacts');
    if (removedPanel) {
      removedPanel.hidden = removed.length === 0;
      document.querySelector('#removedCallContactsTitle').textContent = `Removed contacts (${removed.length})`;
      const removedList = document.querySelector('#removedCallContactsList');
      const removedContent = removed.map(link => `<li><span>${escapeHtml(nameForLink(link.id))}</span><button type="button" class="secondary-button" data-call-restore="${escapeHtml(link.id)}" aria-label="Restore ${escapeHtml(nameForLink(link.id))} to phonebook">Restore</button></li>`).join('');
      if (removedList.innerHTML !== removedContent) removedList.innerHTML = removedContent;
    }
    if (!links.length) {
      root.innerHTML = `<li class="call-directory__empty">${removed.length ? 'Your phonebook is empty. Open Removed contacts below to restore an agent.' : 'No paired agents yet. Connect an agent in <strong>Agents</strong>, then it will appear here.'}</li>`;
      return;
    }
    const callInProgress = Boolean(window.HexiGridIncomingVoiceCall?.hasLiveCall?.());
    const participants = window.HexiGridIncomingVoiceCall?.participants?.() || [];
    links.sort((a, b) => Number(callReadiness(b).ready) - Number(callReadiness(a).ready) || nameForLink(a.id).localeCompare(nameForLink(b.id)));
    const content = links.map((link) => {
      const readiness = callReadiness(link);
      const agent = agentForLink(link.id);
      const initials = nameForLink(link.id).split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
      const selected = selectedCallLinkId === link.id || (!selectedCallLinkId && readiness.ready);
      const label = readiness.paired ? (link.status === 'online' && readiness.ready ? 'Ready' : 'Paired') : String(link.status || 'Offline').replaceAll('-', ' ');
      const participant = participants.find(item => item.linkId === link.id);
      const canCall = readiness.ready && !callStartBusy && !participant;
      const reason = participant ? (participant.onHold ? 'On hold' : 'In call') : readiness.reason;
      const videoButton = `<button type="button" class="secondary-button" data-call-start="${escapeHtml(link.id)}" data-call-video="true" ${canCall && (link.grantedCapabilities || link.capabilities || []).includes('camera-view') ? '' : 'disabled'} aria-label="Video call ${escapeHtml(nameForLink(link.id))}">Video</button>`;
      return `<li class="call-contact ${readiness.ready ? 'is-ready' : ''} ${selected ? 'is-selected' : ''}"><span class="call-contact__avatar" aria-hidden="true">${escapeHtml(initials || 'A')}</span><span class="call-contact__identity"><strong>${escapeHtml(nameForLink(link.id))}</strong><small>${escapeHtml(agent?.accountLabel || link.identity?.provider || 'Paired agent')}</small><span class="call-contact__status"><i aria-hidden="true"></i>${escapeHtml(label)} · ${escapeHtml(reason)}</span>${callVoicePicker(agent, nameForLink(link.id))}</span><span class="call-contact__actions"><button type="button" class="${readiness.ready ? 'primary-button' : 'secondary-button'}" data-call-start="${escapeHtml(link.id)}" ${canCall ? '' : 'disabled'} aria-label="${callInProgress ? 'Add' : 'Call'} ${escapeHtml(nameForLink(link.id))}">${callStartBusy && selected ? 'Connecting…' : participant ? participant.onHold ? 'On hold' : 'In call' : callInProgress ? 'Add to call' : 'Call'}</button>${callInProgress ? '' : videoButton}<button type="button" class="ghost-button call-contact__remove" data-call-hide="${escapeHtml(link.id)}" ${participant ? 'disabled title="End this contact’s call before removing it"' : ''} aria-label="Remove ${escapeHtml(nameForLink(link.id))} from phonebook">Remove</button></span></li>`;
    }).join('');
    if (root.innerHTML !== content) root.innerHTML = content;
  }

  async function setContactVisibility(linkId, visible) {
    if (contactSaveBusy || !connectionForLink(linkId)) return;
    const hidden = new Set((state.data.settings?.hiddenCallContacts || []).filter(id => connectionForLink(id)));
    if (visible) hidden.delete(linkId); else hidden.add(linkId);
    contactSaveBusy = true;
    try {
      const expected = [...hidden];
      const result = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ hiddenCallContacts: expected }) });
      if (!Array.isArray(result.settings?.hiddenCallContacts) || expected.length !== result.settings.hiddenCallContacts.length || expected.some(id => !result.settings.hiddenCallContacts.includes(id))) throw new Error('The phonebook change was not saved. Reload HexiGrid and try again.');
      state.data.settings = result.settings;
      if (!visible && selectedCallLinkId === linkId) selectedCallLinkId = '';
      renderCallDirectory();
      document.querySelector('#callDirectoryTitle')?.focus?.({ preventScroll: true });
      notify(visible ? 'Contact restored.' : 'Contact removed. You can restore it below.');
    } catch (error) { notify(error.message, true); }
    finally { contactSaveBusy = false; }
  }

  async function startPairedVoiceCall(linkId, { video = false } = {}) {
    if (callStartBusy) return;
    const adding = window.HexiGridIncomingVoiceCall?.hasLiveCall?.();
    const link = connectionForLink(linkId);
    const readiness = link && callReadiness(link);
    if (!link || !readiness?.ready) { setStatus(readiness?.reason || 'This agent is not available for calls.', true); return; }
    if (video && !(link.grantedCapabilities || link.capabilities || []).includes('camera-view')) { setStatus('Allow camera access for this agent to start a video call.', true); return; }
    selectedCallLinkId = link.id;
    callStartBusy = true; renderCallDirectory();
    const media = window.HexiGridDesktopMedia;
    const agentName = nameForLink(link.id);
    const mediaBefore = media?.state?.() || {};
    setStatus(`Preparing a private call with ${agentName}…`);
    try {
      if (adding) {
        const result = await api('/api/desktop-bridge/voice-call/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId, approved: true }) });
        window.HexiGridIncomingVoiceCall?.update({ request: api, voiceCall: result.voiceCall });
        setStatus(`${agentName} has been added on hold. Select Talk when they answer.`);
        return;
      }
      // Begin getUserMedia and AudioContext.resume in the Call click's transient
      // browser gesture. Network checks happen in parallel, after those APIs start.
      const preparedAudio = media?.prepareCallAudioFromGesture?.({ request: api, agentName });
      if (!preparedAudio) throw new Error('Call audio is unavailable in this browser.');
      // Document Picture-in-Picture is the browser's always-on-top call window.
      // Open it from the same Call gesture so it can float above other apps.
      window.HexiGridIncomingVoiceCall?.openFloatingCallFromGesture?.();
      const [, latest] = await Promise.all([preparedAudio, api('/api/desktop-bridge')]);
      const bridge = latest.bridge || {};
      if (bridge.enabled !== true) throw new Error('Computer access changed. Turn it on to call.');
      if (!media?.setKind) throw new Error('Call audio controls are unavailable in this browser.');
      media.setMicrophoneMuted?.(false);
      media.setVoicePlaybackMuted?.(false);
      const result = await api('/api/desktop-bridge/voice-call/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId, video, approved: true }) });
      if (result.voiceCall?.linkId !== link.id) throw new Error('The call was not started for the selected agent.');
      if (video) window.HexiGridIncomingVoiceCall?.requestCameraOnAnswer?.(result.voiceCall.id);
      window.HexiGridIncomingVoiceCall?.update({ request: api, voiceCall: result.voiceCall, bridge: result.callBridge || bridge, media: media.state?.() || {} });
      setStatus(`${agentName} is being called. Waiting for them to answer…`);
      notify(`Calling ${agentName}…`);
    } catch (error) {
      const mediaAfter = media?.state?.() || {};
      if (!mediaBefore.microphone && mediaAfter.microphone) await Promise.resolve(media.stop?.('microphone', false)).catch(() => {});
      if (!mediaBefore.speaker && mediaAfter.speaker) await Promise.resolve(media.stop?.('speaker', false)).catch(() => {});
      setStatus(error.message || `Could not start a call with ${agentName}.`, true);
    } finally { callStartBusy = false; renderCallDirectory(); }
  }

  function selectedRoom() {
    const id = document.querySelector('#liveRoomSelect')?.value;
    return state.data?.rooms?.find((item) => item.id === id && !item.archived) || null;
  }

  function setStatus(text, error = false) {
    const status = document.querySelector('#liveStatus');
    if (status) { status.textContent = text; status.classList.toggle('error', error); }
    const hint = document.querySelector('#liveSupportHint');
    if (hint && error) hint.textContent = text;
  }

  function updatePrivacy(sharing = realtimeSharing) {
    realtimeSharing = sharing === true;
    const autoFrame = document.querySelector('#liveAutoFrame')?.checked === true;
    const badge = document.querySelector('#livePrivacyBadge');
    if (badge) badge.textContent = realtimeSharing ? 'LIVE FRAMES SHARED' : autoFrame ? 'FRAMES ON SEND' : pendingFrame ? 'FRAME ATTACHED' : 'PRIVATE PREVIEW';
    const hint = document.querySelector('#liveSupportHint');
    if (hint) hint.textContent = realtimeSharing
      ? 'Preview frames are being sent to the selected realtime provider. Uncheck Share live visual context to stop. Recording is separate and local.'
      : autoFrame ? 'A fresh preview frame will be sent with each message to the selected agent’s vision-capable connection. Uncheck the frame option to stop.'
      : pendingFrame ? 'One captured frame remains attached to your next message, even if the preview is off. Remove frame to keep it out of the message.'
      : 'These previews stay on this device. Attach a frame, enable frames with messages, or explicitly share live visual context to send images. Recording is separate and local.';
  }

  function renderSelectors() {
    if (!mounted || !state.data) return;
    const agentSelect = document.querySelector('#liveAgentSelect');
    const roomSelect = document.querySelector('#liveRoomSelect');
    if (!agentSelect || !roomSelect) return;
    const priorAgent = agentSelect.value || requestedAgentId || selectedAgent()?.id;
    const priorRoom = roomSelect.value || selectedRoom()?.id;
    agentSelect.innerHTML = state.data.agents.length ? state.data.agents.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(agentListLabel(item))} · ${escapeHtml(item.accountLabel || 'Local profile')}</option>`).join('') : '<option value="">No agents connected yet</option>';
    const rooms = state.data.rooms.filter((item) => !item.archived);
    roomSelect.innerHTML = rooms.length ? rooms.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('') : '<option value="">Create a room when you send</option>';
    if ([...agentSelect.options].some((option) => option.value === priorAgent)) agentSelect.value = priorAgent;
    if ([...roomSelect.options].some((option) => option.value === priorRoom)) roomSelect.value = priorRoom;
    const presence = document.querySelector('#liveAgentPresence');
    if (presence) presence.textContent = selectedAgent() ? agentListLabel(selectedAgent()) : 'Choose an agent';
    const modelStage = document.querySelector('#liveAvatarModel');
    if (modelStage) {
      const current = selectedAgent();
      modelStage.innerHTML = current?.avatarModel ? window.HexiGridAvatarViewer?.element(current.avatarModel.url, `${current.name} 3D avatar`, 'live-avatar-viewer', current.avatarModel.format) || '' : '';
      modelStage.hidden = !current?.avatarModel;
    }
    document.querySelector('#liveNoAgent')?.classList.toggle('hidden', Boolean(state.data.agents.length));
    renderCallDirectory();
    window.HexiGridLiveVoice?.render();
    window.HexiGridGeneratedVoice?.render();
  }

  function renderTranscript() {
    const root = document.querySelector('#liveTranscript');
    if (!root) return;
    root.innerHTML = transcript.map((entry) => `<li class="live-transcript-entry ${escapeHtml(entry.role)}"><div><strong>${escapeHtml(entry.speaker)}</strong><time>${escapeHtml(new Date(entry.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</time></div><p>${escapeHtml(entry.text)}</p></li>`).join('') || '<li class="empty-state">Your live transcript stays in this tab until you choose Save transcript.</li>';
    root.scrollTop = root.scrollHeight;
    const save = document.querySelector('#liveSaveTranscript');
    if (save) save.disabled = transcript.length === 0;
  }

  function renderSavedTranscripts() {
    const root = document.querySelector('#liveSavedTranscripts');
    if (!root) return;
    const records = state.data?.liveTranscripts || [];
    root.innerHTML = records.map((record) => `<article class="live-saved-row"><div><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(new Date(record.createdAt).toLocaleString())} · ${record.entries.length} lines</small></div><button class="ghost-button" type="button" data-live-action="delete-transcript" data-transcript-id="${escapeHtml(record.id)}">Delete</button></article>`).join('') || '<p class="microcopy">No saved transcripts yet. Saving is always a deliberate choice.</p>';
  }

  function setButtons() {
    const hasStream = Boolean(localStream);
    const hasScreen = Boolean(screenStream);
    const mic = document.querySelector('#liveMuteMic'); const camera = document.querySelector('#liveToggleCamera'); const start = document.querySelector('#liveStartMedia'); const share = document.querySelector('#liveShareScreen'); const frame = document.querySelector('#liveCaptureFrame');
    if (start) { start.disabled = hasStream || mediaPending; start.textContent = mediaPending ? 'Requesting camera + mic…' : 'Start camera + mic'; }
    if (mic) { mic.disabled = !hasStream; mic.textContent = localStream?.getAudioTracks()?.[0]?.enabled === false ? 'Unmute mic' : 'Mute mic'; }
    if (camera) { camera.disabled = !hasStream; camera.textContent = localStream?.getVideoTracks()?.[0]?.enabled === false ? 'Turn camera on' : 'Turn camera off'; }
    if (share) { share.disabled = screenPending || !navigator.mediaDevices?.getDisplayMedia; share.textContent = screenPending ? 'Choose a screen…' : hasScreen ? 'Stop screen preview' : 'Preview screen'; }
    if (frame) frame.disabled = !hasStream && !hasScreen;
    document.querySelector('#liveStopMedia').disabled = !hasStream && !hasScreen && !mediaPending && !screenPending;
    updatePrivacy();
  }

  async function startMedia() {
    if (localStream || mediaPending) return;
    if (!navigator.mediaDevices?.getUserMedia) return setStatus('Camera and microphone are not available in this browser. Text chat still works.', true);
    const attempt = ++mediaAttempt;
    mediaPending = true; setButtons(); setStatus('Requesting camera and microphone. Stop media keeps the preview off.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (attempt !== mediaAttempt) { stream.getTracks().forEach(track => track.stop()); return; }
      localStream = stream;
      const video = document.querySelector('#liveLocalVideo');
      video.srcObject = localStream; video.hidden = false; document.querySelector('#liveMediaEmpty').hidden = true;
      setStatus('Camera and mic ready'); setButtons();
    } catch (error) { if (attempt === mediaAttempt) setStatus(error.name === 'NotAllowedError' ? 'Camera or microphone permission was declined. You can still use text and voice output.' : `Camera and microphone could not start: ${error.message}`, true); }
    finally { if (attempt === mediaAttempt) { mediaPending = false; setButtons(); } }
  }

  async function toggleScreen() {
    if (screenStream) return stopScreen();
    if (screenPending) return;
    if (!navigator.mediaDevices?.getDisplayMedia) return setStatus('Screen sharing is not supported by this browser.', true);
    const attempt = ++screenAttempt;
    screenPending = true; setButtons();
    try {
      const share = document.querySelector('#liveShareScreen');
      if (share) { share.disabled = true; share.textContent = 'Choose a screen…'; }
      setStatus('Choose a window, tab, or screen in the browser dialog. Nothing is shared until you confirm.');
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (attempt !== screenAttempt) { stream.getTracks().forEach(track => track.stop()); return; }
      screenStream = stream;
      const video = document.querySelector('#liveScreenVideo'); video.srcObject = screenStream; video.hidden = false;
      screenStream.getVideoTracks()[0].addEventListener('ended', () => { if (screenStream === stream) stopScreen(); }, { once: true });
      setStatus('Screen share is on'); setButtons();
    } catch (error) { if (attempt === screenAttempt) setStatus(error.name === 'NotAllowedError' ? 'Screen sharing was cancelled.' : `Screen sharing could not start: ${error.message}`, true); }
    finally { if (attempt === screenAttempt) { screenPending = false; setButtons(); } }
  }

  function stopScreen() {
    ++screenAttempt; screenPending = false;
    screenStream?.getTracks().forEach((track) => track.stop()); screenStream = null;
    const video = document.querySelector('#liveScreenVideo'); if (video) { video.srcObject = null; video.hidden = true; }
    setStatus(localStream ? 'Camera and mic ready' : 'Ready'); setButtons();
  }

  function stopMedia() {
    stopListening();
    ++mediaAttempt; mediaPending = false;
    window.HexiGridLiveRecording?.stop();
    localStream?.getTracks().forEach((track) => track.stop()); localStream = null; stopScreen();
    const video = document.querySelector('#liveLocalVideo'); if (video) { video.srcObject = null; video.hidden = true; }
    const empty = document.querySelector('#liveMediaEmpty'); if (empty) empty.hidden = false;
    setStatus('Ready'); setButtons();
  }

  function toggleMic() { const track = localStream?.getAudioTracks()?.[0]; if (track) { track.enabled = !track.enabled; setButtons(); setStatus(track.enabled ? 'Mic on' : 'Mic muted'); } }
  function toggleCamera() { const track = localStream?.getVideoTracks()?.[0]; if (track) { track.enabled = !track.enabled; setButtons(); setStatus(track.enabled ? 'Camera on' : 'Camera off'); } }

  function activeMediaStream() {
    const tracks = [];
    const videoTrack = screenStream?.getVideoTracks()?.[0] || localStream?.getVideoTracks()?.[0];
    const audioTrack = localStream?.getAudioTracks()?.[0];
    if (videoTrack) tracks.push(videoTrack);
    if (audioTrack) tracks.push(audioTrack);
    return tracks.length ? new MediaStream(tracks) : null;
  }

  function clearFrame() {
    pendingFrame = '';
    const preview = document.querySelector('#liveFramePreview');
    if (preview) { preview.removeAttribute('src'); preview.hidden = true; }
    const clear = document.querySelector('#liveClearFrame'); if (clear) clear.hidden = true;
    const capture = document.querySelector('#liveCaptureFrame'); if (capture) capture.textContent = 'Attach current frame';
    updatePrivacy();
  }

  function frameFromPreview(maxDimension = 720, quality = .76) {
    const track = (screenStream || localStream)?.getVideoTracks()?.[0];
    if (!track || track.enabled === false || track.readyState === 'ended') return '';
    const video = screenStream ? document.querySelector('#liveScreenVideo') : document.querySelector('#liveLocalVideo');
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
    const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
    let frame = canvas.toDataURL('image/jpeg', quality);
    if (frame.length > 1400 * 1024) frame = canvas.toDataURL('image/jpeg', .55);
    return frame;
  }

  function captureFrame() {
    pendingFrame = frameFromPreview();
    if (!pendingFrame) return setStatus('Wait for the preview to appear, then try again.', true);
    const preview = document.querySelector('#liveFramePreview'); if (preview) { preview.src = pendingFrame; preview.hidden = false; }
    const clear = document.querySelector('#liveClearFrame'); if (clear) clear.hidden = false;
    const capture = document.querySelector('#liveCaptureFrame'); if (capture) capture.textContent = 'Replace attached frame';
    setStatus('One still frame is attached to the next message.');
    updatePrivacy();
  }

  async function ensureRoom(agentItem) {
    let room = selectedRoom();
    if (!room) {
      const response = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: `Live · ${agentItem.name}`, description: 'A local live session created by HexiGrid.' }) });
      state.data.rooms.push(response.room); room = response.room;
      document.querySelector('#liveRoomSelect').value = room.id;
    }
    if (!room.agentIds.includes(agentItem.id)) {
      const response = await api(`/api/rooms/${room.id}`, { method: 'PATCH', body: JSON.stringify({ agentIds: [...room.agentIds, agentItem.id] }) });
      Object.assign(room, response.room);
    }
    return room;
  }

  async function sendToAgent(content) {
    const agentItem = selectedAgent();
    if (!agentItem) return setStatus('Add an agent first, then start a live session.', true);
    const message = String(content || '').trim(); if (!message) return;
    if (document.querySelector('#liveAutoFrame')?.checked) {
      const freshFrame = frameFromPreview();
      if (freshFrame) pendingFrame = freshFrame;
    }
    if (turnController) turnController.abort();
    turnController = new AbortController();
    addEntry('user', message, null, 'You');
    setStatus(`${agentItem.name} is thinking…`);
    try {
      const room = await ensureRoom(agentItem);
      let response = await api(`/api/rooms/${room.id}/messages/user`, { method: 'POST', body: JSON.stringify({ content: message, agentIds: [agentItem.id] }) });
      Object.assign(room, response.room);
      const model = modelInfo(agentItem.model);
      if (model?.browser) {
        if (pendingFrame) throw new Error('This on-device model connection accepts text only. Choose a vision-capable API model to attach a frame.');
        const generated = await window.HexiGridBrowserChat.completeTurn({ agent: agentItem, room, settings: state.data.settings, memories: state.data.memories, modelId: model.remoteModel, signal: turnController.signal });
        response = await api(`/api/rooms/${room.id}/messages/browser`, { method: 'POST', body: JSON.stringify({ agentId: agentItem.id, content: generated.content, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, inputText: message, outputText: generated.content }) });
      } else {
        response = await api(`/api/rooms/${room.id}/messages`, { method: 'POST', body: JSON.stringify({ agentIds: [agentItem.id], includeUserMessage: false, approved: false, imageDataUrl: pendingFrame }) });
      }
      Object.assign(room, response.room);
      const reply = [...room.messages].reverse().find((item) => item.role === 'agent' && item.agentId === agentItem.id);
      if (reply) { addEntry('agent', reply.content, agentItem.id, agentItem.name); window.HexiGridLiveVoice?.speak(reply.content, agentItem); }
      clearFrame();
      setStatus('Ready');
      if (typeof renderAll === 'function') renderAll({ preserveCommunication: true });
    } catch (error) {
      if (error.name === 'AbortError') return setStatus('Response cancelled. The text already received remains in the transcript.');
      addEntry('system', error.message, agentItem.id, 'HexiGrid'); setStatus(error.message, true);
    } finally { turnController = null; }
  }

  function stopListening() {
    ++recognitionAttempt;
    const previous = recognition;
    recognition = null; recognitionActive = false; listeningRequested = false;
    try { previous?.abort(); } catch { /* An already-ended recognizer needs no cleanup. */ }
    const button = document.querySelector('#liveListen');
    if (button) button.textContent = 'Start listening';
  }

  function startListening() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return setStatus('Live speech recognition is not available in this browser. Use the message box instead.', true);
    if (recognitionActive || listeningRequested) { stopListening(); setStatus('Dictation stopped.'); return; }
    const instance = new Recognition();
    const remote = document.querySelector('#liveRemoteSpeech')?.checked === true;
    if (!remote && !('processLocally' in instance))
      return setStatus('On-device dictation is unavailable in this browser. Use text, or explicitly allow browser-service transcription below.', true);
    if ('processLocally' in instance) instance.processLocally = !remote;
    const agentId = selectedAgent()?.id, roomId = selectedRoom()?.id;
    const attempt = ++recognitionAttempt;
    recognition = instance;
    const current = () => recognition === instance && attempt === recognitionAttempt
      && selectedAgent()?.id === agentId && selectedRoom()?.id === roomId
      && (!remote || document.querySelector('#liveRemoteSpeech')?.checked === true);
    listeningRequested = true;
    instance.continuous = true; instance.interimResults = true; instance.lang = navigator.language || 'en-US';
    let finalText = '', failed = false;
    instance.onstart = () => { if (!current()) { try { instance.abort(); } catch {} return; } recognitionActive = true; setStatus(remote ? 'Listening · browser-service transcription allowed' : 'Listening · on-device transcription'); document.querySelector('#liveListen').textContent = 'Stop listening'; };
    instance.onresult = (event) => {
      if (!current() || !listeningRequested) return;
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) { const text = event.results[index][0].transcript; if (event.results[index].isFinal) finalText += ` ${text}`; else interim += text; }
      document.querySelector('#liveInterim').textContent = interim ? `Hearing: ${interim}` : '';
      if (finalText.trim()) {
        const raw = finalText.trim(); finalText = '';
        const wakeEnabled = document.querySelector('#liveWakeWordEnabled')?.checked;
        const wakeWord = document.querySelector('#liveWakeWord')?.value.trim().toLowerCase();
        if (wakeEnabled && wakeWord) {
          const phrase = raw.toLowerCase(); const wakeIndex = phrase.indexOf(wakeWord);
          if (wakeIndex < 0) { document.querySelector('#liveInterim').textContent = `Waiting for “${wakeWord}”…`; return; }
          const message = raw.slice(wakeIndex + wakeWord.length).trim();
          if (message) sendToAgent(message); else document.querySelector('#liveInterim').textContent = 'Wake word heard. What should I send?';
        } else sendToAgent(raw);
      }
    };
    instance.onerror = (event) => {
      if (!current()) return;
      failed = true; listeningRequested = false;
      setStatus(event.error === 'language-not-supported'
        ? 'Local speech support for this language is unavailable. Use text, or explicitly allow browser-service transcription.'
        : `Speech recognition stopped: ${event.error || 'browser error'}. Your message box remains available.`, true);
    };
    instance.onend = () => {
      if (!current()) return;
      recognitionActive = false;
      if (listeningRequested && document.visibilityState === 'visible') {
        setTimeout(() => { if (!current() || !listeningRequested) return; try { instance.start(); } catch { listeningRequested = false; setStatus('Dictation could not resume. Start listening again or use text.', true); } }, 250);
        return;
      }
      document.querySelector('#liveListen').textContent = 'Start listening'; if (!turnController && !failed) setStatus('Ready');
    };
    try { instance.start(); }
    catch { stopListening(); setStatus('Dictation could not start. Use text or check browser speech permissions.', true); }
  }

  function stopReply() {
    window.HexiGridLiveVoice?.stop();
    setStatus(turnController ? 'Voice stopped. The agent is still finishing the written reply.' : 'Voice stopped. The full text stays in the transcript.');
  }

  async function saveTranscript() {
    if (!transcript.length) return setStatus('There is no transcript to save yet.', true);
    const agentItem = selectedAgent(); const room = selectedRoom();
    const payload = { title: `Live session · ${agentItem?.name || 'HexiGrid'}`, agentId: agentItem?.id || null, roomId: room?.id || null, entries: transcript };
    try {
      const response = await api('/api/live/transcripts', { method: 'POST', body: JSON.stringify(payload) });
      if (response.transcript) state.data.liveTranscripts = [response.transcript, ...(state.data.liveTranscripts || [])];
      renderSavedTranscripts();
      setStatus('Transcript saved locally.'); notify('Transcript saved locally.');
    } catch (error) {
      const file = new Blob([transcript.map((entry) => `[${new Date(entry.createdAt).toLocaleString()}] ${entry.speaker}: ${entry.text}`).join('\n\n')], { type: 'text/plain;charset=utf-8' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(file); link.download = `hexigrid-live-${new Date().toISOString().slice(0, 10)}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      setStatus('The local service was unavailable, so a text copy was downloaded.');
    }
  }

  async function deleteTranscript(transcriptId) {
    try {
      await api(`/api/live/transcripts/${transcriptId}`, { method: 'DELETE' });
      state.data.liveTranscripts = (state.data.liveTranscripts || []).filter((item) => item.id !== transcriptId);
      renderSavedTranscripts(); notify('Saved transcript deleted.');
    } catch (error) { notify(error.message, true); }
  }

  function clearTranscript() { transcript = []; renderTranscript(); setStatus('Transcript cleared from this live session.'); }

  function mount() {
    if (mounted) return;
    const main = document.querySelector('.main-content'); if (!main) return;
    const section = document.createElement('section'); section.id = 'view-live'; section.className = 'view'; section.innerHTML = `
      <div class="page-intro"><div><div class="eyebrow">CALLS · PRIVATE BY DEFAULT</div><h2>Call an agent</h2><p>Choose an agent for a voice or video call. Your conversation is saved as text in Chat on this device. No audio is saved.</p></div><span id="liveStatus" class="status-badge">Ready</span></div>
      <section class="panel call-directory" aria-labelledby="callDirectoryTitle"><header class="module-header"><div><div class="eyebrow">PHONE BOOK</div><h3 id="callDirectoryTitle" tabindex="-1">Your agents</h3></div><span class="status-badge">PRIVATE CALLS</span></header><p class="panel-copy">Start with one agent, then add more from this phone book. Only the agent you select with Talk can hear and respond; others wait on hold. Remove hides a contact here without disconnecting its Link.</p><ul id="callDirectoryList" class="call-directory__list" aria-live="polite"><li class="call-directory__empty">Loading paired agents…</li></ul><details id="removedCallContacts" class="removed-call-contacts" hidden><summary id="removedCallContactsTitle">Removed contacts</summary><ul id="removedCallContactsList"></ul></details></section>
      <details class="call-tools-disclosure"><summary><span>Advanced tools · previews and provider experiments</span><span class="status-badge">OPTIONAL</span></summary><p class="panel-copy">Normal paired-agent calls use the phonebook above and the call dock. Call transcripts are saved in Chat on this device. These optional tools are for local camera and screen previews, a separate text conversation, voice previews, or direct provider-realtime experiments.</p><div class="call-tools-disclosure__body"><div class="live-layout">
        <section class="panel live-stage"><header class="module-header"><div><div class="eyebrow">PRIVATE PREVIEW</div><h3>Camera and screen</h3></div><span class="status-badge" id="livePrivacyBadge">LOCAL ONLY</span></header><div class="live-video-stage"><div id="liveMediaEmpty" class="live-media-empty"><span class="live-core">◈</span><strong>Camera is off</strong><p>Press Start camera + mic when you are ready. The browser will ask for permission.</p></div><div id="liveAvatarModel" class="live-avatar-model" hidden></div><video id="liveLocalVideo" class="live-video" autoplay muted playsinline hidden></video><video id="liveScreenVideo" class="live-screen-video" autoplay muted playsinline hidden></video><div class="live-agent-presence"><span class="presence-wave"><i></i><i></i><i></i></span><strong id="liveAgentPresence">Choose an agent</strong><small>Agent replies appear as text and can be read aloud by this browser.</small></div></div><div class="live-controls"><button class="primary-button" id="liveStartMedia" type="button" data-live-action="start-media">Start camera + mic</button><button class="secondary-button" id="liveMuteMic" type="button" data-live-action="mute" disabled>Mute mic</button><button class="secondary-button" id="liveToggleCamera" type="button" data-live-action="camera" disabled>Turn camera off</button><button class="secondary-button" id="liveShareScreen" type="button" data-live-action="screen">Preview screen</button><button class="ghost-button" id="liveStopMedia" type="button" data-live-action="stop-media" disabled>Stop media</button></div><div id="liveRecordingControls" class="live-recording-controls"></div><p id="liveSupportHint" class="microcopy">The agent cannot see this preview. Nothing records automatically; recording requires a separate click and saves directly to your device.</p></section>
        <section class="panel live-conversation"><header class="module-header"><div><div class="eyebrow">ONE RESPONDER AT A TIME</div><h3>Live conversation</h3></div><span class="status-badge">TEXT + VOICE</span></header><div class="live-selectors"><label>Agent<select id="liveAgentSelect"></select></label><label>Room<select id="liveRoomSelect"></select></label></div><div class="live-wake-controls"><label class="checkbox-control"><input id="liveWakeWordEnabled" type="checkbox"> Wait for a wake phrase</label><label>Wake phrase<input id="liveWakeWord" maxlength="80" placeholder="Optional, e.g. hey grid"></label></div><p id="liveNoAgent" class="empty-state hidden">Add an agent in Agents first. This view will populate automatically.</p><ol id="liveTranscript" class="live-transcript"></ol><p id="liveInterim" class="live-interim" aria-live="polite"></p><label class="check-line"><input id="liveRemoteSpeech" type="checkbox"/>Allow browser-service transcription</label><p class="microcopy">Dictation uses on-device processing by default. Enabling this option permits your browser to send microphone audio to its speech service. Recognized text goes to the selected agent. Changing the agent, room, or this option stops dictation.</p><form id="liveMessageForm" class="live-composer"><textarea id="liveMessageInput" rows="3" placeholder="Type a message, or start listening…"></textarea><div><button class="primary-button" type="submit">Send to agent</button><button class="secondary-button" id="liveListen" type="button" data-live-action="listen">Start listening</button><button class="ghost-button" id="liveStopReply" type="button" data-live-action="stop-reply">Stop voice</button></div></form><div class="live-record-actions"><button class="secondary-button" id="liveSaveTranscript" type="button" data-live-action="save-transcript" disabled>Save transcript</button><button class="ghost-button" type="button" data-live-action="clear-transcript">Clear this session</button></div><div id="liveSavedTranscripts" class="live-saved-transcripts"></div></section>
      </div>
      <section class="panel live-voice-panel"><header class="module-header"><div><div class="eyebrow">VOICE PREVIEW</div><h3>Choose how this agent sounds</h3></div><span class="status-badge">BROWSER VOICE</span></header><p class="panel-copy">These are voices your device already provides. HexiGrid does not upload recordings or clone a voice. Preview three options, then save the one you like to the selected agent.</p><div class="live-voice-controls"><label>Voice<select id="liveVoiceSelect"></select></label><label>Rate<input id="liveVoiceRate" type="range" min="0.5" max="2" step="0.01" value="1"></label><label>Pitch<input id="liveVoicePitch" type="range" min="0" max="2" step="0.01" value="1"></label><label>Volume<input id="liveVoiceVolume" type="range" min="0.1" max="1" step="0.01" value="0.72"></label></div><div class="live-voice-actions"><button class="secondary-button" type="button" data-live-voice-action="preview" data-preview="0">Preview 1</button><button class="secondary-button" type="button" data-live-voice-action="preview" data-preview="1">Preview 2</button><button class="secondary-button" type="button" data-live-voice-action="preview" data-preview="2">Preview 3</button><button class="primary-button" type="button" data-live-voice-action="save">Save voice</button><button class="ghost-button" type="button" data-live-voice-action="stop">Stop preview</button></div><p id="liveVoiceSupport" class="microcopy">Checking this browser’s speech voices…</p><p id="liveVoiceValue" class="microcopy">1.00× · pitch 1.00</p></section></div></details>`;
    section.querySelector('.live-controls')?.insertAdjacentHTML('beforeend', '<button class="secondary-button" id="liveCaptureFrame" type="button" data-live-action="capture-frame" disabled>Attach current frame</button>');
    section.querySelector('#liveRecordingControls')?.insertAdjacentHTML('beforebegin', '<div id="liveFrameAttachment" class="live-frame-attachment"><img id="liveFramePreview" alt="Frame attached to the next agent message" hidden><button class="ghost-button" id="liveClearFrame" type="button" data-live-action="clear-frame" hidden>Remove frame</button></div>');
    section.querySelector('#liveRecordingControls')?.insertAdjacentHTML('beforebegin', '<label class="checkbox-control live-auto-frame"><input id="liveAutoFrame" type="checkbox"> Include one fresh frame with every message</label>');
    const support = section.querySelector('#liveSupportHint');
    if (support) updatePrivacy();
    main.append(section);
    mounted = true;
    renderSelectors(); renderTranscript(); renderSavedTranscripts(); setButtons();
  }

  function bind() {
    document.addEventListener('change', async (event) => {
      const select = event.target.closest('[data-call-voice]');
      if (!select) return;
      const agent = state.data?.agents?.find(item => item.id === select.dataset.callVoice);
      if (!agent) return;
      if (select.value === '__provider__') return;
      try {
        const voiceProfile = select.value ? { engine: 'browser', voiceName: select.value, rate: 1, pitch: 1, volume: 1 } : { engine: 'agent' };
        const result = await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ voiceProfile }) });
        Object.assign(agent, result.agent);
        document.dispatchEvent(new CustomEvent('hexigrid-agent-voice-changed', { detail: { agentId: agent.id } }));
        notify(`Reply voice saved for ${agent.name}.`);
      } catch (error) { setStatus(error.message, true); renderCallDirectory(); }
    });
    window.speechSynthesis?.addEventListener?.('voiceschanged', renderCallDirectory);
    document.addEventListener('click', (event) => {
      const contactButton = event.target.closest('[data-call-hide], [data-call-restore]');
      if (contactButton) { void setContactVisibility(contactButton.dataset.callHide || contactButton.dataset.callRestore, Boolean(contactButton.dataset.callRestore)); return; }
      const callButton = event.target.closest('[data-call-start]');
      if (callButton) { void startPairedVoiceCall(callButton.dataset.callStart, { video: callButton.dataset.callVideo === 'true' }); return; }
      const button = event.target.closest('[data-live-action]'); if (!button) return;
      const action = button.dataset.liveAction;
      if (action === 'start-media') startMedia();
      if (action === 'mute') toggleMic();
      if (action === 'camera') toggleCamera();
      if (action === 'screen') toggleScreen();
      if (action === 'capture-frame') captureFrame();
      if (action === 'clear-frame') { clearFrame(); setStatus('Attached frame removed.'); }
      if (action === 'stop-media') stopMedia();
      if (action === 'listen') startListening();
      if (action === 'stop-reply') stopReply();
      if (action === 'save-transcript') saveTranscript();
      if (action === 'clear-transcript') clearTranscript();
      if (action === 'delete-transcript') deleteTranscript(button.dataset.transcriptId);
    });
    document.addEventListener('submit', (event) => { if (event.target.id !== 'liveMessageForm') return; event.preventDefault(); const input = document.querySelector('#liveMessageInput'); const value = input.value.trim(); input.value = ''; sendToAgent(value); });
    document.addEventListener('change', (event) => {
      if (event.target.matches('#liveAgentSelect, #liveRoomSelect, #liveRemoteSpeech')) {
        const listening = recognitionActive || listeningRequested;
        stopListening();
        if (listening) setStatus('Dictation stopped. Start listening again with the new selection.');
      }
      if (event.target.matches('#liveAgentSelect')) {
        clearFrame(); const autoFrame = document.querySelector('#liveAutoFrame'); if (autoFrame) autoFrame.checked = false;
        renderSelectors(); document.querySelector('#liveAgentPresence').textContent = selectedAgent() ? agentListLabel(selectedAgent()) : 'Choose an agent';
      }
      if (event.target.matches('#liveAgentSelect, #liveAutoFrame')) updatePrivacy();
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && (recognitionActive || listeningRequested)) stopListening(); });
    window.addEventListener('beforeunload', () => { stopMedia(); window.HexiGridLiveVoice?.stop(); });
  }

  window.addEventListener('hexigrid:rendered', () => { mount(); renderSelectors(); renderSavedTranscripts(); });
  function editCallAvatar(linkId) {
    const item = agentForLink(linkId);
    if (!item) return;
    window.focus();
    openAgentModal(item.id, { section: 'appearance' });
  }
  window.HexiGridLiveCall = Object.freeze({ selectedAgent, selectedRoom, agentForLink, nameForLink, setStatus, renderSelectors, renderCallDirectory, setContactVisibility, activeMediaStream, addEntry, frameFromPreview, updatePrivacy, editCallAvatar });
  bind();
  setTimeout(mount, 0);
})();
