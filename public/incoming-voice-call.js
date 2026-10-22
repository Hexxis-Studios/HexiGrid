(() => {
  let request = null;
  let call = null;
  let bridge = null;
  let busy = false;
  let ringTimer = 0;
  let audioContext = null;
  let statusNode;
  let ringtoneButton;
  let acceptButton;
  let declineButton;
  let currentCallId = '';
  let audioReadyCallId = '';
  let toastAudioAttemptedCallId = '';
  let floatingCallWindow = null;
  let floatingCallElements = null;
  let floatingCallTimer = 0;
  let floatingCallOpening = null;
  let callTranscripts = [];
  let callReplyTranscripts = [];
  let lastReplyKey = '';
  let lastSpokenReplyKey = '';
  let speakingReplyKey = '';
  let failedSpeechKey = '';
  let mediaActivatedCallId = '';
  let cleanedCallId = '';
  let activeCallDock = null;
  let activeDockElements = null;
  let floatingCallUnavailable = false;
  let cameraOnAnswerCallId = '';
  let cameraAttemptedCallId = '';
  let callVideo = null;
  let callVideoAsset = '';
  let portraitPlayer = null;
  let floatingVideoVisible = false;
  const avatarChoices = new Map();
  let participantPanel = null;
  let participantPanelKey = '';
  let participantPlayers = [];

  function renderParticipants() {
    const participants = call?.participants || [];
    if (!participantPanel) { participantPanel = document.createElement('section'); participantPanel.className = 'hexi-call-participants'; participantPanel.setAttribute('aria-label', 'Call participants'); }
    participantPanel.hidden = participants.length < 2;
    const key = JSON.stringify([participants, busy, participants.map(item => window.HexiGridLiveCall?.agentForLink?.(item.linkId)?.updatedAt)]);
    if (key !== participantPanelKey) {
      for (const player of participantPlayers) player.stop(); participantPlayers = [];
      participantPanelKey = key; participantPanel.replaceChildren();
      for (const participant of participants) {
        const agent = window.HexiGridLiveCall?.agentForLink?.(participant.linkId);
        const name = window.HexiGridLiveCall?.nameForLink?.(participant.linkId) || 'Agent';
        const row = document.createElement('div'); row.className = 'hexi-call-participant';
        if (agent?.avatarImage) {
          const picture = document.createElement('span'); picture.className = 'hexi-call-participant-picture';
          const image = document.createElement('img'); image.src = agent.avatarImage; image.alt = ''; picture.append(image); row.append(picture);
          if (!participant.onHold && agent.portraitAvatar) {
            const player = window.HexiGridPortraitAvatar?.mount(picture, agent.portraitAvatar, { label: `${name} animated portrait` });
            if (player) participantPlayers.push(player);
          }
        }
        const label = document.createElement('span'); label.textContent = `${name} · ${participant.onHold ? participant.status === 'active' ? 'On hold' : 'Waiting for answer' : 'Talking'}`;
        const select = document.createElement('button'); select.type = 'button'; select.textContent = participant.onHold ? 'Talk' : 'Selected'; select.disabled = busy || !participant.onHold || participant.status !== 'active'; select.setAttribute('aria-label', `Talk to ${name}`);
        select.addEventListener('click', () => { void selectParticipant(participant.linkId); });
        row.append(label, select); participantPanel.append(row);
      }
    }
    const parent = floatingCallElements?.card || activeCallDock;
    if (parent && participantPanel.parentNode !== parent) parent.append(participantPanel);
  }

  async function selectParticipant(linkId) {
    if (busy || call?.status !== 'active') return;
    const media = window.HexiGridDesktopMedia;
    const cameraWasOn = media?.state?.().camera === true;
    setBusy(true);
    media?.setMicrophoneMuted?.(true); media?.setVoicePlaybackMuted?.(true);
    try {
      if (cameraWasOn) await media.stop('camera', false);
      const result = await request('/api/desktop-bridge/voice-call/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId, approved: true }) });
      update({ voiceCall: result.voiceCall, bridge: result.callBridge, request });
      await media.prepareCallAudioFromGesture({ request, agentName: callDisplayName() });
      media.activateCallAudio(); media.setMicrophoneMuted(false); media.setVoicePlaybackMuted(false);
      mediaActivatedCallId = currentCallId; audioReadyCallId = currentCallId;
      if (cameraWasOn && bridge.mediaGrants?.camera) await media.setCameraEnabled(true);
    } catch (error) {
      if (statusNode) statusNode.textContent = error.message || 'Could not switch agents.';
      window.HexiGridLiveCall?.setStatus?.(error.message || 'Could not switch agents.', true);
      media?.setMicrophoneMuted?.(Boolean(call?.ownerMuted)); media?.setVoicePlaybackMuted?.(Boolean(call?.ownerMuted));
    } finally { setBusy(false); }
  }

  function renderCallVideo() {
    const enabled = call?.status === 'active' && bridge?.enabled === true && bridge.linkId === call.linkId && window.HexiGridDesktopMedia?.state?.().camera === true;
    if (!callVideo && !enabled) return;
    if (!callVideo) {
      const stage = document.createElement('section'); stage.className = 'hexi-call-video';
      stage.setAttribute('aria-label', 'Video call');
      const agentView = document.createElement('div'); agentView.className = 'hexi-call-agent-view';
      const label = document.createElement('span'); label.className = 'hexi-call-video-name';
      const toolbar = document.createElement('div'); toolbar.className = 'hexi-call-video-tools';
      const kind = document.createElement('select'); kind.setAttribute('aria-label', 'Call avatar style');
      for (const [value, text] of [['2d', '2D avatar'], ['3d', '3D avatar']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = text; kind.append(option);
      }
      kind.addEventListener('change', () => {
        const item = window.HexiGridLiveCall?.agentForLink?.(call?.linkId);
        if (item) {
          avatarChoices.set(item.id, kind.value);
          try { window.localStorage.setItem(`hexigrid-call-avatar-kind:${item.id}`, kind.value); } catch {}
        }
        renderCallVideo();
      });
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Set avatar';
      edit.addEventListener('click', () => { window.HexiGridLiveCall?.editCallAvatar?.(call?.linkId); });
      toolbar.append(kind, edit);
      const self = document.createElement('video'); self.className = 'hexi-call-self-view';
      self.setAttribute('aria-label', 'Your camera preview'); self.autoplay = true; self.muted = true; self.playsInline = true;
      stage.append(agentView, label, toolbar, self);
      callVideo = { stage, agentView, label, self, kind, edit };
    }
    callVideo.stage.hidden = !enabled;
    if (enabled) {
      const item = window.HexiGridLiveCall?.agentForLink?.(call.linkId);
      const model = item?.avatarModel;
      const image = item?.avatarImage;
      if (item && !avatarChoices.has(item.id)) {
        try {
          const saved = window.localStorage.getItem(`hexigrid-call-avatar-kind:${item.id}`);
          if (saved === '2d' || saved === '3d') avatarChoices.set(item.id, saved);
        } catch {}
      }
      const selectedKind = avatarChoices.get(item?.id);
      const useModel = Boolean(model?.url && (selectedKind !== '2d' || !image));
      callVideo.kind.hidden = !(model?.url && image);
      callVideo.kind.value = useModel ? '3d' : '2d';
      callVideo.edit.disabled = !item;
      const key = `${call.id}:${item?.id || ''}:${useModel ? model.url : item?.portraitAvatar?.url || image || ''}:${useModel ? model.format : '2d'}`;
      if (callVideoAsset !== key) {
        portraitPlayer?.stop(); portraitPlayer = null;
        callVideoAsset = key;
        callVideo.agentView.replaceChildren();
        if (useModel && window.HexiGridAvatarViewer?.element) {
          callVideo.agentView.innerHTML = window.HexiGridAvatarViewer.element(model.url, `${callDisplayName()} avatar`, 'hexi-call-model', model.format);
          const viewer = callVideo.agentView.querySelector('model-viewer') || callVideo.agentView.querySelector('hexi-vrm-viewer');
          viewer?.addEventListener('error', () => { if (callVideoAsset === key) callVideo.agentView.textContent = 'This avatar could not load. Your call is still connected.'; }, { once: true });
          // PiP has its own custom-element registry. Upgrade through the owner
          // registry after its existing renderer loads, including late loads.
          const renderer = window.HexiGridAvatarViewer;
          const ready = model.format === 'vrm' ? renderer.ensureVrmLoaded?.() : renderer.ensureLoaded?.();
          if (ready) Promise.resolve(ready).then(() => {
            if (callVideoAsset !== key) return;
            // Construct in the registry's document before adopting into PiP.
            // Parsing markup directly in PiP creates an unregistered element.
            const loadedViewer = document.createElement(model.format === 'vrm' ? 'hexi-vrm-viewer' : 'model-viewer');
            loadedViewer.className = 'hexi-call-model';
            loadedViewer.setAttribute('src', model.url);
            loadedViewer.setAttribute('alt', `${callDisplayName()} avatar`);
            loadedViewer.setAttribute('autoplay', '');
            loadedViewer.setAttribute('camera-controls', '');
            loadedViewer.setAttribute('interaction-prompt', 'none');
            loadedViewer.setAttribute('loading', 'eager');
            loadedViewer.addEventListener('error', () => { if (callVideoAsset === key) callVideo.agentView.textContent = 'This avatar could not load. Your call is still connected.'; }, { once: true });
            window.customElements?.upgrade(loadedViewer);
            callVideo.agentView.replaceChildren(loadedViewer);
          }).catch(() => {
            if (callVideoAsset === key) callVideo.agentView.textContent = 'This avatar could not load. Your call is still connected.';
          });
        } else if (image) {
          const portrait = document.createElement('img'); portrait.src = image; portrait.alt = `${callDisplayName()} avatar`;
          portrait.addEventListener('error', () => { if (callVideoAsset === key) callVideo.agentView.textContent = 'This avatar image could not load. Your call is still connected.'; }, { once: true });
          callVideo.agentView.append(portrait);
          if (item?.portraitAvatar) portraitPlayer = window.HexiGridPortraitAvatar?.mount(callVideo.agentView, item.portraitAvatar, { label: `${callDisplayName()} animated portrait` });
        } else {
          callVideo.agentView.textContent = 'No avatar configured. Choose an avatar for this agent in Agents.';
        }
      }
      callVideo.label.textContent = `${callDisplayName()} · avatar`;
      callVideo.stage.dataset.speaking = String(window.HexiGridDesktopMedia?.state?.().speakerPlaying === true);
      window.HexiGridDesktopMedia?.attachCameraPreview?.(callVideo.self);
    } else {
      portraitPlayer?.stop(); portraitPlayer = null;
      callVideo.self.srcObject = null;
      callVideo.agentView.replaceChildren(); callVideoAsset = '';
    }
    const parent = floatingCallElements?.card || activeCallDock;
    if (parent && callVideo.stage.parentNode !== parent) parent.append(callVideo.stage);
    if (floatingCallWindow && !floatingCallWindow.closed && floatingVideoVisible !== enabled) {
      floatingVideoVisible = enabled;
      try { floatingCallWindow.resizeTo(enabled ? 420 : 370, enabled ? 490 : floatingCallElements?.transcriptOpen ? 365 : 174); } catch {}
    }
  }

  async function toggleCallCamera() {
    if (busy || call?.status !== 'active') return;
    const enabled = window.HexiGridDesktopMedia?.state?.().camera !== true;
    // Resize while this button still carries user activation, before camera
    // permission/network work. A retained smaller size remains scrollable.
    if (floatingCallWindow && !floatingCallWindow.closed) {
      try { floatingCallWindow.resizeTo(enabled ? 420 : 370, enabled ? 560 : floatingCallElements?.transcriptOpen ? 365 : 260); } catch {}
    }
    setBusy(true);
    try {
      const media = window.HexiGridDesktopMedia;
      await media.setKind('camera', enabled, { request, agentName: callDisplayName() });
    } catch (error) {
      const message = error?.name === 'NotAllowedError' ? 'Allow camera access in your browser to turn video on.' : error.message || 'Your camera could not start. The voice call is still connected.';
      window.HexiGridLiveCall?.setStatus?.(message, true);
      if (statusNode) statusNode.textContent = message;
    } finally { setBusy(false); }
  }

  function renderCameraButton(button) {
    if (!button) return;
    const enabled = window.HexiGridDesktopMedia?.state?.().camera === true;
    button.textContent = enabled ? 'Video off' : 'Video on';
    button.setAttribute('aria-pressed', String(enabled));
    button.disabled = busy || call?.status !== 'active';
  }

  function callDisplayName() {
    return String(call?.callerName || window.HexiGridLiveCall?.nameForLink?.(call?.linkId) || 'Your agent').slice(0, 120);
  }

  function rememberLatestReply() {
    const reply = call?.latestReply;
    const sequence = Number(reply?.sequence);
    if (!reply?.text || !Number.isSafeInteger(sequence) || sequence < 1) return;
    const key = `${call.id}:${sequence}`;
    if (lastReplyKey === key) return;
    lastReplyKey = key;
    callReplyTranscripts = [...callReplyTranscripts, { text: String(reply.text).slice(0, 1000), final: true, speaker: callDisplayName(), reply: true }].slice(-24);
  }

  async function speakLatestAgentReply() {
    const reply = call?.latestReply;
    const sequence = Number(reply?.sequence);
    if (call?.status !== 'active' || call.ownerMuted || !audioReadyCallId || audioReadyCallId !== call.id || !reply?.text || !Number.isSafeInteger(sequence) || sequence < 1) return;
    rememberLatestReply();
    const key = `${call.id}:${sequence}`;
    if (reply.outputMode === 'audio') { lastSpokenReplyKey = key; return; }
    if (lastSpokenReplyKey === key || speakingReplyKey === key || failedSpeechKey === key) return;
    speakingReplyKey = key;
    try {
      const agent = window.HexiGridLiveCall?.agentForLink?.(call.linkId) || { name: callDisplayName(), voiceProfile: { engine: 'browser' } };
      let played = false;
      if (agent.voiceProfile?.engine === 'provider') played = await (window.HexiGridGeneratedVoice?.speakText?.(reply.text, agent) || false);
      else if (agent.voiceProfile?.engine === 'browser' && agent.voiceProfile.voiceName) played = window.HexiGridLiveVoice?.speak?.(reply.text, agent) === true;
      if (played) lastSpokenReplyKey = key;
      else { failedSpeechKey = key; window.HexiGridLiveCall?.setStatus(`${callDisplayName()}'s reply is ready as text. Choose a local voice to hear text replies.`, true); }
    } catch (error) {
      failedSpeechKey = key;
      window.HexiGridLiveCall?.setStatus(`Voice playback failed. ${callDisplayName()}'s reply remains in the transcript.`, true);
    } finally { if (speakingReplyKey === key) speakingReplyKey = ''; }
  }

  function ensurePrompt() {
    let dialog = document.querySelector('#incomingVoiceCall');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'incomingVoiceCall';
    dialog.className = 'incoming-voice-call';
    dialog.setAttribute('aria-labelledby', 'incomingVoiceCallTitle');

    const eyebrow = document.createElement('span');
    eyebrow.className = 'incoming-voice-call__eyebrow';
    eyebrow.textContent = 'HEXIGRID · PRIVATE CALL';
    const title = document.createElement('h2');
    title.id = 'incomingVoiceCallTitle';
    title.textContent = 'Your agent wants to call you';
    const caller = document.createElement('p');
    caller.className = 'incoming-voice-call__caller';
    caller.id = 'incomingVoiceCallCaller';
    const status = document.createElement('p');
    status.id = 'incomingVoiceCallStatus';
    status.className = 'incoming-voice-call__status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    statusNode = status;

    const controls = document.createElement('div');
    controls.className = 'incoming-voice-call__controls';
    ringtoneButton = document.createElement('button');
    ringtoneButton.type = 'button';
    ringtoneButton.className = 'incoming-voice-call__ringtone';
    ringtoneButton.textContent = 'Enable ringtone';
    ringtoneButton.addEventListener('click', () => { void unlockAudio(true); });
    declineButton = document.createElement('button');
    declineButton.type = 'button';
    declineButton.className = 'incoming-voice-call__decline';
    declineButton.textContent = 'Deny';
    declineButton.addEventListener('click', () => { void (call?.status === 'active' ? endAcceptedCall() : declineCall()); });
    acceptButton = document.createElement('button');
    acceptButton.type = 'button';
    acceptButton.className = 'incoming-voice-call__accept';
    acceptButton.textContent = 'Allow';
    acceptButton.addEventListener('click', () => { void acceptCall(); });
    controls.append(ringtoneButton, declineButton, acceptButton);

    dialog.append(eyebrow, title, caller, status, controls);
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    document.body.append(dialog);
    return dialog;
  }

  function getAudioContext() {
    if (!audioContext) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (Context) audioContext = new Context();
    }
    return audioContext;
  }

  function playTone() {
    const context = getAudioContext();
    if (!context || context.state !== 'running') return;
    const startAt = context.currentTime + 0.02;
    for (const [offset, frequency] of [[0, 880], [0.22, 660]]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, startAt + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, startAt + offset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(startAt + offset);
      oscillator.stop(startAt + offset + 0.19);
      oscillator.addEventListener('ended', () => { oscillator.disconnect(); gain.disconnect(); }, { once: true });
    }
  }

  function stopRingtone() {
    if (ringTimer) window.clearInterval(ringTimer);
    ringTimer = 0;
  }

  function startRingtone() {
    stopRingtone();
    const context = getAudioContext();
    ringtoneButton.hidden = !context || context.state === 'running';
    if (context?.state === 'running') {
      playTone();
      ringTimer = window.setInterval(playTone, 1700);
    }
  }

  async function unlockAudio(ringNow = false) {
    const context = getAudioContext();
    if (!context) {
      if (statusNode) statusNode.textContent = 'Ringtone is unavailable here, but you can still allow or deny the call.';
      return;
    }
    try {
      // Unlock call output in this same real browser gesture, even when the
      // later Answer comes from Windows. No microphone is acquired here.
      const speakerReady = window.HexiGridDesktopMedia?.prepareSpeakerPlayback?.();
      await Promise.all([context.resume(), speakerReady]);
      ringtoneButton.hidden = true;
      if (ringNow && call?.status === 'ringing') startRingtone();
    } catch {
      if (statusNode) statusNode.textContent = 'Ringtone is unavailable, but you can still allow or deny the call.';
    }
  }

  async function enableCallAudio() {
    const media = window.HexiGridDesktopMedia;
    if (!media?.setKind) throw new Error('Computer audio controls are unavailable in this page.');
    const name = String(call?.callerName || 'your agent');
    // This is reached from Allow / Enable audio, so resume Web Audio while
    // the browser still associates this operation with the user's click.
    await media.prepareSpeakerPlayback?.();
    const current = media.state?.() || {};
    if (!current.microphone) await media.setKind('microphone', true, { request, agentName: name });
    if (!current.speaker) await media.setKind('speaker', true, { request, agentName: name });
    media.setMicrophoneMuted?.(false);
    media.setVoicePlaybackMuted?.(false);
    const refreshed = media.state?.() || {};
    if (refreshed.speakerPlaybackBlocked) await media.enableSpeaker?.();
  }

  function formatCallDuration(startedAt) {
    const started = Date.parse(startedAt || '');
    const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function ensureActiveCallDock() {
    if (activeCallDock?.isConnected) return activeCallDock;
    const dock = document.createElement('aside');
    dock.className = 'incoming-call-dock';
    dock.hidden = true;
    dock.setAttribute('aria-label', 'Active voice call');
    const identity = document.createElement('div'); identity.className = 'incoming-call-dock__identity';
    const caller = document.createElement('strong');
    const status = document.createElement('span'); status.setAttribute('aria-live', 'polite');
    identity.append(caller, status);
    const timer = document.createElement('time'); timer.className = 'incoming-call-dock__timer';
    const controls = document.createElement('div'); controls.className = 'incoming-call-dock__controls';
    const enableAudio = document.createElement('button'); enableAudio.type = 'button'; enableAudio.className = 'incoming-call-dock__audio'; enableAudio.textContent = 'Enable audio';
    enableAudio.addEventListener('click', () => { void (call?.status === 'ringing' ? acceptCall() : enableDockCallAudio()); });
    const floating = document.createElement('button'); floating.type = 'button'; floating.textContent = 'Float call'; floating.title = 'Open the always-on-top call window';
    floating.addEventListener('click', () => {
      const opening = openFloatingCallWindow();
      void enableDockCallAudio();
      void opening;
    });
    const mute = document.createElement('button'); mute.type = 'button'; mute.textContent = 'Mute'; mute.addEventListener('click', () => { void toggleCallMute(); });
    const camera = document.createElement('button'); camera.type = 'button'; camera.className = 'incoming-call-dock__camera'; camera.addEventListener('click', () => { void toggleCallCamera(); });
    const end = document.createElement('button'); end.type = 'button'; end.className = 'incoming-call-dock__end'; end.textContent = 'End'; end.addEventListener('click', () => { void (call?.status === 'ringing' ? declineCall() : endAcceptedCall()); });
    controls.append(enableAudio, floating, mute, camera, end);
    dock.append(identity, timer, controls);
    document.body.append(dock);
    activeCallDock = dock;
    activeDockElements = { caller, status, timer, enableAudio, floating, mute, camera, end };
    return dock;
  }

  function renderActiveCallDock() {
    const dock = ensureActiveCallDock();
    const visible = bridge?.enabled === true && bridge.linkId === call?.linkId && ['offered', 'ringing', 'active'].includes(call?.status);
    dock.hidden = !visible;
    if (!visible) { renderCallVideo(); renderParticipants(); return; }
    const active = call.status === 'active';
    const ringing = call.status === 'ringing';
    activeDockElements.caller.textContent = callDisplayName();
    const media = window.HexiGridDesktopMedia?.state?.() || {};
    const canFloat = !floatingCallUnavailable && Boolean(window.documentPictureInPicture?.requestWindow);
    const audioReady = media.microphone && media.speaker && !media.speakerPlaybackBlocked && media.speakerAudioContextState === 'running';
    activeDockElements.status.textContent = ringing
      ? call.notificationChannel === 'windows' ? 'Answer here or from the Windows alert' : 'Incoming call'
      : !active ? 'Calling · waiting for your agent to answer'
        : call.ownerMuted ? 'Muted'
          : media.speakerPlaybackError || (!audioReady ? 'Call connected · enable audio' : media.speakerPlaying ? 'Agent audio playing' : 'Connected · waiting for your agent');
    activeDockElements.timer.textContent = active ? formatCallDuration(call.answeredAt) : ringing ? 'Ringing' : 'Calling';
    activeDockElements.enableAudio.textContent = ringing ? 'Answer' : 'Enable audio';
    activeDockElements.enableAudio.hidden = ringing ? false : !active || audioReady;
    activeDockElements.enableAudio.disabled = busy || (!active && !ringing);
    activeDockElements.mute.hidden = !active;
    activeDockElements.mute.textContent = call.ownerMuted ? 'Unmute' : 'Mute';
    activeDockElements.mute.disabled = busy || !active;
    activeDockElements.end.disabled = busy;
    activeDockElements.end.textContent = ringing ? 'Decline' : 'End';
    activeDockElements.camera.hidden = !active;
    renderCameraButton(activeDockElements.camera);
    renderCallVideo();
    renderParticipants();
    activeDockElements.floating.hidden = !active || Boolean(floatingCallWindow && !floatingCallWindow.closed);
    activeDockElements.floating.disabled = busy || !active || !canFloat || Boolean(floatingCallOpening && !floatingCallWindow);
    if (!canFloat) { activeDockElements.floating.textContent = 'Float unavailable'; activeDockElements.floating.title = 'Open HexiGrid in a browser with Document Picture-in-Picture support.'; }
    else { activeDockElements.floating.textContent = 'Float call'; activeDockElements.floating.title = 'Open the always-on-top call window'; }
  }

  function renderFloatingCall() {
    if (!floatingCallWindow || !floatingCallElements) return;
    const active = call?.status === 'active';
    const callerName = callDisplayName();
    floatingCallWindow.document.title = `${callerName} · HexiGrid call`;
    const avatar = floatingCallWindow.document.querySelector('.hexi-call-avatar');
    if (avatar) avatar.textContent = callerName.trim().slice(0, 1).toUpperCase() || 'A';
    floatingCallElements.caller.textContent = callerName;
    const media = window.HexiGridDesktopMedia?.state?.() || {};
    floatingCallElements.status.textContent = active ? (call.ownerMuted ? 'Muted' : media.speakerPlaybackError || (media.speakerPlaying ? 'Agent audio · browser' : 'Connected · waiting for audio')) : call?.status === 'offered' ? 'Calling · waiting for answer' : call?.status === 'ringing' ? 'Incoming call' : 'Call ended';
    floatingCallElements.timer.textContent = active ? formatCallDuration(call.answeredAt) : call?.status === 'offered' ? 'Calling' : '';
    floatingCallElements.mute.textContent = call?.ownerMuted ? 'Unmute' : 'Mute';
    floatingCallElements.mute.hidden = !active;
    floatingCallElements.mute.disabled = !active || busy;
    floatingCallElements.end.disabled = (!active && !['offered', 'ringing'].includes(call?.status)) || busy;
    renderCameraButton(floatingCallElements.camera);
    renderCallVideo();
    renderParticipants();
    floatingCallElements.transcriptToggle.disabled = !active || busy;
    floatingCallElements.transcript.hidden = !floatingCallElements.transcriptOpen || !active;
    floatingCallElements.transcriptToggle.textContent = floatingCallElements.transcriptOpen ? 'Hide transcript' : 'Transcript';
    floatingCallElements.transcript.replaceChildren();
    const transcriptLines = [...callTranscripts, ...callReplyTranscripts];
    for (const item of transcriptLines.slice(-24)) {
      const line = floatingCallWindow.document.createElement('p');
      line.className = `hexi-call-line ${item.status ? 'is-status' : item.final ? 'is-final' : 'is-partial'}`;
      line.textContent = `${item.speaker ? `${String(item.speaker).slice(0, 120)}: ` : ''}${String(item.text || '').slice(0, 1000)}`;
      floatingCallElements.transcript.append(line);
    }
    if (!callTranscripts.length) {
      const empty = floatingCallWindow.document.createElement('p');
      empty.className = 'hexi-call-empty';
      empty.textContent = 'Your words are transcribed on this PC during the call.';
      floatingCallElements.transcript.append(empty);
    }
  }

  function setFloatingCallStyles(doc) {
    doc.body.className = 'hexi-call-shell';
    const base = doc.createElement('base');
    base.href = window.location.href;
    doc.head.append(base);
    const stylesheet = doc.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('/incoming-voice-call.css', window.location.href).href;
    doc.head.append(stylesheet);
  }

  function openFloatingCallWindow() {
    const pictureInPicture = window.documentPictureInPicture;
    if (!pictureInPicture?.requestWindow) {
      floatingCallUnavailable = true;
      if (statusNode) statusNode.textContent = 'This browser cannot open a separate always-on-top call window. In-page call controls remain available.';
      renderActiveCallDock();
      return Promise.resolve(null);
    }
    if (floatingCallWindow && !floatingCallWindow.closed) return Promise.resolve(floatingCallWindow);
    if (floatingCallOpening) return floatingCallOpening;
    if (floatingCallUnavailable) return Promise.resolve(null);
    let opening;
    try {
      // requestWindow must be invoked directly from the owner's button click.
      const video = window.HexiGridDesktopMedia?.state?.().camera === true;
      opening = pictureInPicture.requestWindow({ width: video ? 420 : 370, height: video ? 560 : 320, preferInitialWindowPlacement: true });
    } catch (error) {
      floatingCallUnavailable = true;
      console.warn('[HexiGrid call window] floating window could not open', { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 180) });
      if (statusNode) statusNode.textContent = 'The floating call window could not open here. Use the in-page call controls or open HexiGrid in a supported browser.';
      renderActiveCallDock();
      return Promise.resolve(null);
    }
    let settled = false;
    let timeoutId = 0;
    const timedOut = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        settled = true;
        reject(new Error('The floating window request timed out.'));
      }, 4000);
    });
    const createWindow = Promise.resolve(opening).then((pip) => {
      if (settled) { if (!pip.closed) pip.close(); return null; }
      settled = true;
      window.clearTimeout(timeoutId);
      floatingCallWindow = pip;
      pip.document.title = `${String(call?.callerName || 'Agent')} · HexiGrid call`;
      setFloatingCallStyles(pip.document);
      const card = pip.document.createElement('section'); card.className = 'hexi-call-card'; card.id = 'hexiCallCard';
      const head = pip.document.createElement('header'); head.className = 'hexi-call-head';
      const avatar = pip.document.createElement('span'); avatar.className = 'hexi-call-avatar'; avatar.textContent = String(call?.callerName || 'A').trim().slice(0, 1).toUpperCase();
      const identity = pip.document.createElement('div'); identity.className = 'hexi-call-identity';
      const caller = pip.document.createElement('div'); caller.className = 'hexi-call-name';
      const status = pip.document.createElement('div'); status.className = 'hexi-call-status';
      identity.append(caller, status);
      const timer = pip.document.createElement('time'); timer.className = 'hexi-call-time'; timer.setAttribute('aria-label', 'Call duration');
      head.append(avatar, identity, timer);
      const transcript = pip.document.createElement('div'); transcript.className = 'hexi-call-transcript'; transcript.hidden = true; transcript.setAttribute('aria-live', 'polite');
      const controls = pip.document.createElement('footer'); controls.className = 'hexi-call-controls';
      const transcriptToggle = pip.document.createElement('button'); transcriptToggle.type = 'button'; transcriptToggle.textContent = 'Transcript';
      const mute = pip.document.createElement('button'); mute.type = 'button'; mute.textContent = 'Mute';
      const camera = pip.document.createElement('button'); camera.type = 'button'; camera.addEventListener('click', () => { void toggleCallCamera(); });
      const end = pip.document.createElement('button'); end.type = 'button'; end.textContent = 'End call'; end.className = 'hexi-call-end';
      transcriptToggle.addEventListener('click', () => { floatingCallElements.transcriptOpen = !floatingCallElements.transcriptOpen; try { pip.resizeTo(floatingVideoVisible ? 420 : 370, floatingVideoVisible ? (floatingCallElements.transcriptOpen ? 620 : 490) : floatingCallElements.transcriptOpen ? 365 : 174); } catch {} renderFloatingCall(); });
      mute.addEventListener('click', () => { void toggleCallMute(); });
      end.addEventListener('click', () => { void (call?.status === 'ringing' ? declineCall() : endAcceptedCall()); });
      controls.append(transcriptToggle, mute, camera, end);
      card.append(head, transcript, controls); pip.document.body.append(card);
      floatingCallElements = { card, caller, status, timer, transcript, transcriptToggle, mute, camera, end, transcriptOpen: false };
      floatingVideoVisible = false;
      pip.addEventListener('pagehide', () => {
        if (floatingCallWindow !== pip) return;
        floatingCallWindow = null; floatingCallElements = null;
        floatingVideoVisible = false;
        if (floatingCallTimer) window.clearInterval(floatingCallTimer);
        floatingCallTimer = 0;
        renderActiveCallDock();
      }, { once: true });
      if (floatingCallTimer) window.clearInterval(floatingCallTimer);
      floatingCallTimer = window.setInterval(renderFloatingCall, 1000);
      renderFloatingCall();
      renderActiveCallDock();
      console.info('[HexiGrid call window] floating call controls opened');
      return pip;
    });
    floatingCallOpening = Promise.race([createWindow, timedOut]).catch((error) => {
      floatingCallUnavailable = true;
      console.warn('[HexiGrid call window] floating window request rejected', { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 180) });
      if (statusNode) statusNode.textContent = 'The floating call window could not open here. Use the in-page call controls or open HexiGrid in a supported browser.';
      renderActiveCallDock();
      return null;
    }).finally(() => { window.clearTimeout(timeoutId); floatingCallOpening = null; });
    renderActiveCallDock();
    return floatingCallOpening;
  }

  function closeFloatingCallWindow() {
    const pip = floatingCallWindow;
    floatingCallWindow = null;
    floatingCallElements = null;
    if (floatingCallTimer) window.clearInterval(floatingCallTimer);
    floatingCallTimer = 0;
    if (pip && !pip.closed) pip.close();
    renderActiveCallDock();
  }

  async function toggleCallMute() {
    if (!currentCallId || call?.status !== 'active' || busy) return;
    setBusy(true);
    try {
      const muted = !call.ownerMuted;
      const result = await request('/api/desktop-bridge/voice-call/mute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ muted }) });
      call = result.voiceCall || { ...call, ownerMuted: muted };
      window.HexiGridDesktopMedia?.setMicrophoneMuted?.(muted);
      window.HexiGridDesktopMedia?.setVoicePlaybackMuted?.(muted);
      renderActiveCallDock();
      renderFloatingCall();
    } catch (error) {
      console.error('[HexiGrid call window] mute action failed', { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 180) });
      if (statusNode) statusNode.textContent = 'Mute could not be changed. Try again in HexiGrid.';
    } finally { setBusy(false); }
  }

  async function enableDockCallAudio() {
    if (busy || call?.status !== 'active' || !currentCallId) return;
    setBusy(true);
    try {
      failedSpeechKey = '';
      await enableCallAudio();
      const media = window.HexiGridDesktopMedia?.state?.() || {};
      if (media.microphone && media.speaker && !media.speakerPlaybackBlocked && media.speakerAudioContextState === 'running') {
        audioReadyCallId = currentCallId;
        mediaActivatedCallId = currentCallId;
        if (statusNode) statusNode.textContent = 'Call audio is ready. Waiting for agent audio.';
      } else if (statusNode) {
        statusNode.textContent = 'The call is connected, but browser audio is still blocked. Check the microphone permission and tap Enable audio again.';
      }
      renderActiveCallDock();
      renderFloatingCall();
    } catch (error) {
      if (statusNode) statusNode.textContent = error?.name === 'NotAllowedError'
        ? 'Microphone access was denied in the browser. Allow it for HexiGrid, then tap Enable audio.'
        : 'Call audio could not start. Check the browser microphone permission, then try Enable audio again.';
      renderActiveCallDock();
    } finally { setBusy(false); }
  }

  async function startPreauthorizedToastCallAudio(callId) {
    try {
      if (!navigator.permissions?.query) {
        statusNode.textContent = 'The call is allowed. Open HexiGrid to connect audio.';
        return;
      }
      const permission = await navigator.permissions.query({ name: 'microphone' });
      if (permission.state !== 'granted') {
        statusNode.textContent = 'Allow microphone access in HexiGrid to connect call audio.';
        return;
      }
      const media = window.HexiGridDesktopMedia;
      if (!media?.setKind) throw new Error('Computer audio controls are unavailable in this page.');
      // A Windows toast click is not a browser user gesture. Start capture and
      // receive queued chunks when site permission already exists, but leave
      // AudioContext.resume() to the in-page Enable audio click.
      let refreshed = media.state?.() || {};
      if (!refreshed.microphone) {
        await media.setKind('microphone', true, { request, agentName: String(call?.callerName || 'your agent') });
        refreshed = media.state?.() || {};
      }
      if (!refreshed.speaker) {
        await media.setKind('speaker', true, { request, agentName: String(call?.callerName || 'your agent') });
        refreshed = media.state?.() || {};
      }
      media.setMicrophoneMuted?.(false);
      media.setVoicePlaybackMuted?.(false);
      if (call?.id !== callId || call?.status !== 'active') return;
      if (refreshed.microphone && refreshed.speaker && !refreshed.speakerPlaybackBlocked && refreshed.speakerAudioContextState === 'running') {
        audioReadyCallId = callId;
        if (statusNode) statusNode.textContent = 'Call audio is ready. Waiting for agent audio.';
      } else {
        if (statusNode) statusNode.textContent = 'The call is connected. Open HexiGrid and tap Enable audio to hear your agent.';
      }
      renderActiveCallDock();
    } catch (error) {
      if (call?.id === callId && call?.status === 'active') {
        if (statusNode) statusNode.textContent = 'The call is connected. Open HexiGrid and tap Enable audio to connect browser audio.';
        console.warn('[HexiGrid voice audio] toast-accepted audio needs an in-page gesture', { name: error?.name || 'Error' });
      }
    }
  }

  function setBusy(value) {
    busy = value;
    acceptButton.disabled = value;
    declineButton.disabled = value;
    ringtoneButton.disabled = value;
    if (activeDockElements) { activeDockElements.enableAudio.disabled = value; activeDockElements.mute.disabled = value; activeDockElements.end.disabled = value; activeDockElements.floating.disabled = value; }
    renderActiveCallDock();
    renderFloatingCall();
  }

  async function acceptCall() {
    if (busy || !['ringing', 'active'].includes(call?.status) || !currentCallId) return;
    setBusy(true);
    const wasRinging = call.status === 'ringing';
    statusNode.textContent = wasRinging ? 'Allowing the call…' : 'Reconnecting audio…';
    try {
      // Invoke both browser-controlled APIs in the original Allow gesture.
      // The PiP request opens the system floating window; getUserMedia triggers
      // the browser's microphone prompt when this origin has not been allowed.
      const floatingWindow = openFloatingCallWindow();
      if (wasRinging) {
        const media = window.HexiGridDesktopMedia;
        const prepare = media?.prepareCallAudioFromGesture?.({ request, agentName: call.callerName });
        if (!prepare) throw new Error('Browser call audio is unavailable in this page.');
        await Promise.all([floatingWindow, prepare]);
        const result = await request('/api/desktop-bridge/voice-call/accept', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: currentCallId })
        });
        call = result.voiceCall || call;
        await media.activateCallAudio?.();
        mediaActivatedCallId = currentCallId;
      } else {
        await floatingWindow;
        await enableCallAudio();
      }
      const refreshed = window.HexiGridDesktopMedia?.state?.() || {};
      if (refreshed.microphone && refreshed.speaker && !refreshed.speakerPlaybackBlocked && refreshed.speakerAudioContextState === 'running') {
        statusNode.textContent = 'Call connected. Browser microphone and speaker output are ready; waiting for agent audio.';
        audioReadyCallId = currentCallId;
        renderActiveCallDock();
        window.setTimeout(() => { if (call?.status === 'active' && dialogOpen()) closePrompt(); }, 900);
      } else {
        statusNode.textContent = `Call connected, but browser audio is not ready (${refreshed.speakerAudioContextState || 'unknown'}). Tap Enable audio to retry.`;
        acceptButton.textContent = 'Enable audio';
      }
    } catch (error) {
      const active = call?.status === 'active';
      if (!active) await window.HexiGridDesktopMedia?.stop?.('microphone', false).catch(() => {});
      statusNode.textContent = active
        ? `Call connected, but audio did not start${error?.name === 'NotAllowedError' ? ': allow microphone access in the browser.' : '.'} Try Enable audio or end the call.`
        : error?.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in the browser prompt to answer, or deny the call.' : 'The call could not be allowed. Try again or deny it.';
      acceptButton.textContent = active ? 'Enable audio' : 'Allow';
    } finally { setBusy(false); }
  }

  async function declineCall() {
    if (busy || !currentCallId) return;
    setBusy(true);
    statusNode.textContent = 'Denying call…';
    try {
      await request('/api/desktop-bridge/voice-call/decline', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: currentCallId })
      });
      call = { ...call, status: 'ended', stopReason: 'owner-declined' };
      audioReadyCallId = '';
      await window.HexiGridDesktopMedia?.stop?.('microphone', false).catch(() => {});
      closeFloatingCallWindow();
      renderActiveCallDock();
      closePrompt();
    } catch (error) {
      statusNode.textContent = 'The call could not be denied. Try again.';
    } finally { setBusy(false); }
  }

  async function endAcceptedCall() {
    if (busy || !currentCallId) return;
    setBusy(true);
    statusNode.textContent = 'Ending call…';
    try {
      await request('/api/desktop-bridge/voice-call/end', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      call = { ...call, status: 'ended', stopReason: 'owner-ended' };
      audioReadyCallId = '';
      mediaActivatedCallId = '';
      await window.HexiGridDesktopMedia?.stop?.('microphone', false).catch(() => {});
      await window.HexiGridDesktopMedia?.stop?.('speaker', false).catch(() => {});
      await window.HexiGridDesktopMedia?.stop?.('camera', false).catch(() => {});
      closeFloatingCallWindow();
      renderActiveCallDock();
      closePrompt();
    } catch (error) { statusNode.textContent = error.message || 'The call could not be ended.'; }
    finally { setBusy(false); }
  }

  function dialogOpen() { return Boolean(document.querySelector('#incomingVoiceCall')?.open); }

  function closePrompt() {
    stopRingtone();
    const dialog = document.querySelector('#incomingVoiceCall');
    if (dialog?.open) dialog.close();
    if (!['offered', 'ringing', 'active'].includes(call?.status)) currentCallId = '';
    acceptButton.textContent = 'Allow';
    declineButton.textContent = 'Deny';
    setBusy(false);
  }

  function update(next = {}) {
    ensurePrompt();
    request = typeof next.request === 'function' ? next.request : request;
    const previousCallId = String(call?.id || '');
    call = next.voiceCall || { status: 'idle' };
    const nextCallId = String(call.id || '');
    if (nextCallId !== previousCallId) {
      currentCallId = nextCallId;
      audioReadyCallId = '';
      lastReplyKey = '';
      lastSpokenReplyKey = '';
      speakingReplyKey = '';
      failedSpeechKey = '';
      mediaActivatedCallId = '';
      callTranscripts = [];
      callReplyTranscripts = [];
    }
    bridge = next.bridge || bridge || {};
    window.HexiGridDesktopMedia?.setCallIdentity?.(['offered', 'ringing', 'active'].includes(call.status) ? call : {});
    window.HexiGridLiveCall?.renderCallDirectory?.();
    const media = next.media || window.HexiGridDesktopMedia?.state?.() || {};
    if (Array.isArray(next.transcripts)) callTranscripts = next.transcripts.filter((item) => item && typeof item.text === 'string').slice(-40);
    currentCallId = nextCallId;
    rememberLatestReply();
    renderActiveCallDock();
    renderFloatingCall();
    if (call.status !== 'active') audioReadyCallId = '';
    if (call.status === 'ended' || call.status === 'idle') {
      const cleanupKey = call.status === 'idle' ? 'idle' : String(call.id || 'ended');
      if (cleanedCallId !== cleanupKey) {
        cleanedCallId = cleanupKey;
        closeFloatingCallWindow();
        void window.HexiGridDesktopMedia?.stop?.('microphone', false);
        void window.HexiGridDesktopMedia?.stop?.('speaker', false);
        if (call.id) void window.HexiGridDesktopMedia?.stop?.('camera', false);
      }
      if (dialogOpen()) closePrompt();
      return;
    }
    const sameBridge = bridge.enabled === true && Boolean(call.linkId) && bridge.linkId === call.linkId;
    if (!sameBridge) {
      audioReadyCallId = '';
      if (dialogOpen()) closePrompt();
      return;
    }

    if (call.status === 'offered' && call.direction === 'owner-to-agent') {
      stopRingtone();
      if (dialogOpen()) closePrompt();
      renderActiveCallDock();
      renderFloatingCall();
      return;
    }
    if (call.status === 'active') {
      stopRingtone();
      if (cameraOnAnswerCallId === currentCallId && cameraAttemptedCallId !== currentCallId && !busy) {
        cameraAttemptedCallId = currentCallId;
        if (!window.HexiGridDesktopMedia?.state?.().camera) void toggleCallCamera();
      }
      if (media.microphone && media.speaker && !media.speakerPlaybackBlocked && media.speakerAudioContextState === 'running') audioReadyCallId = currentCallId;
      if (call.direction === 'owner-to-agent' && media.microphone && mediaActivatedCallId !== currentCallId) {
        mediaActivatedCallId = currentCallId;
        void window.HexiGridDesktopMedia?.activateCallAudio?.();
      }
      if (call.acceptedVia === 'windows-toast' && toastAudioAttemptedCallId !== currentCallId) {
        toastAudioAttemptedCallId = currentCallId;
        void startPreauthorizedToastCallAudio(currentCallId);
      }
      // An answered call lives in the persistent dock. Keeping the ringing
      // dialog open here can cover the dock and leaves toast-accepted calls
      // stuck behind a browser gesture that never occurred.
      if (dialogOpen()) closePrompt();
      rememberLatestReply();
      if (audioReadyCallId === currentCallId) void speakLatestAgentReply();
      renderActiveCallDock();
      renderFloatingCall();
      return;
    }
    if (call.status !== 'ringing' || call.direction !== 'agent-to-owner') {
      if (dialogOpen()) closePrompt();
      return;
    }
    if (['pending', 'windows'].includes(call.notificationChannel)) {
      // Windows supplies the alert. The in-page dock remains available as a
      // fallback, but answering one alert never requires answering another.
      if (dialogOpen()) closePrompt();
      renderActiveCallDock();
      return;
    }
    const dialog = ensurePrompt();
    const caller = document.querySelector('#incomingVoiceCallCaller');
    const callerName = callDisplayName();
    document.querySelector('#incomingVoiceCallTitle').textContent = `${callerName} wants to call you`;
    caller.textContent = 'Voice call';
    if (!dialog.open) dialog.show();
    if (call.status === 'ringing') {
      acceptButton.textContent = 'Allow';
      declineButton.textContent = 'Deny';
      statusNode.textContent = 'Your microphone and speaker stay off until you allow.';
      declineButton.hidden = false;
      acceptButton.hidden = false;
      ringtoneButton.hidden = !getAudioContext() || getAudioContext().state === 'running';
      if (!ringTimer && getAudioContext()?.state === 'running') startRingtone();
      return;
    }

  }

  document.addEventListener('pointerdown', () => { void unlockAudio(false); }, { once: true, capture: true });
  document.addEventListener('keydown', () => { void unlockAudio(false); }, { once: true, capture: true });
  document.addEventListener('hexigrid-desktop-media', (event) => update({ voiceCall: call, bridge, request, media: event.detail }));
  document.addEventListener('hexigrid-agent-voice-changed', () => { failedSpeechKey = ''; void speakLatestAgentReply(); });
  window.HexiGridIncomingVoiceCall = {
    update,
    hasLiveCall: () => ['offered', 'ringing', 'active'].includes(call?.status),
    participants: () => (call?.participants || []).map(item => ({ ...item })),
    openFloatingCallFromGesture: () => openFloatingCallWindow(),
    requestCameraOnAnswer: (callId) => { cameraOnAnswerCallId = String(callId || ''); }
  };
})();
