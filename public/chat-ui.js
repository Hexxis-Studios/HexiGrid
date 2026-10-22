/* One-to-one and multi-agent local room conversations. */
const roomComposerDrafts = new Map();
const roomComposerRecoveryHints = new Map();
const unsavedLocalReplies = new Map();
let roomComposerId = null;
let roomEventStream = null;
let roomRefreshPending = false;
let roomRefreshRunning = false;
function startRoomEvents() {
  if (roomEventStream || isStandaloneBrowser() || typeof EventSource === 'undefined') return;
  roomEventStream = new EventSource('/api/rooms/events');
  const changed = () => { roomRefreshPending = true; void applyRoomEvents(); };
  roomEventStream.addEventListener('rooms-changed', changed);
  roomEventStream.addEventListener('open', changed);
  window.addEventListener('pagehide', () => { roomEventStream?.close(); roomEventStream = null; }, {once:true});
}
function localModelStatusName(model) {
  const name = String(model?.modelMeta?.label || model?.label || model?.remoteModel || 'local model')
    .replace(/^This device\s*\/\s*/i, '')
    .replace(/-MLC$/i, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return name || 'local model';
}
async function applyRoomEvents() {
  if (roomRefreshRunning || state.chatTurn || !state.data || !roomRefreshPending) return;
  roomRefreshRunning = true;
  try {
    do {
      roomRefreshPending = false;
      const latest = await api('/api/rooms');
      if (state.chatTurn) { roomRefreshPending = true; break; }
      state.data.rooms = latest.rooms;
      renderRooms();
    } while (roomRefreshPending && !state.chatTurn);
  } catch { roomRefreshPending = true; /* Manual refresh and stream reconnect remain available. */ }
  finally { roomRefreshRunning = false; }
}
function renderRooms() {
  $("#roomList").innerHTML = state.data.rooms.filter((room) => !room.archived).map((room) => `<button class="room-item ${room.id === state.activeRoomId ? "active" : ""}" data-action="select-room" data-room-id="${escapeHtml(room.id)}"><strong>${escapeHtml(room.name)}</strong><small>${room.agentIds.length} responder${room.agentIds.length === 1 ? "" : "s"}</small></button>`).join("");
  const archived = state.data.rooms.filter((room) => room.archived);
  $("#archivedRoomCount").textContent = archived.length;
  $("#archivedRoomList").innerHTML = archived.map((room) => `<button class="room-item" data-action="restore-room" data-room-id="${escapeHtml(room.id)}" aria-label="Restore ${escapeHtml(room.name)}"><strong>${escapeHtml(room.name)}</strong><small>Restore room · history retained</small></button>`).join('') || '<p class="filter-note">No archived rooms.</p>';
  const room = activeRoom();
  const input = $("#chatInput");
  if (roomComposerId !== (room?.id || null)) {
    if (roomComposerId) roomComposerDrafts.set(roomComposerId, input.value);
    roomComposerId = room?.id || null;
    input.value = roomComposerDrafts.get(roomComposerId) || '';
  }
  const send = $("#chatForm button[type='submit']");
  const rename = document.querySelector(".chat-head [data-action='rename-room']");
  const chainBusy = ['ready','waiting','running'].includes(room?.replyChain?.status);
  const busy = Boolean(state.chatTurn) || chainBusy;
  const replyingHere = state.chatTurn?.roomId === room?.id || chainBusy;
  const stop = $('#chatStop');
  stop.hidden = !state.chatTurn?.saved && !chainBusy;
  stop.disabled = Boolean(state.chatTurn?.stopping);
  stop.textContent = state.chatTurn?.stopping ? 'Stopping…' : 'Stop reply';
  document.querySelector(".chat-head [data-action='archive-room']").disabled = !room || replyingHere;
  if (!room) {
    $("#roomTitle").textContent = "No chat room yet";
    $("#roomDescription").textContent = "Create a room after you add an agent.";
    $("#participantChips").innerHTML = '<span class="filter-note">No participants yet.</span>';
    $("#roomResponderSummary").textContent = 'No room selected';
    $("#messageList").innerHTML = '<div class="empty-state"><strong>Your chats will appear here</strong><p>Choose + beside Rooms when you are ready to start one.</p></div>';
    $("#composerHint").textContent = "Create a room first.";
    input.disabled = true;
    send.disabled = true;
    rename.disabled = true;
    return;
  }
  input.disabled = replyingHere;
  send.disabled = busy || !room.agentIds.length;
  rename.disabled = false;
  $("#roomTitle").textContent = room.name;
  $("#roomDescription").textContent = room.description || 'HexiGrid conversation';
  $("#participantChips").innerHTML = state.data.agents.map((item) => `<label class="participant-chip ${room.agentIds.includes(item.id) ? "selected" : ""}"><input type="checkbox" data-agent-toggle="${escapeHtml(item.id)}" ${room.agentIds.includes(item.id) ? "checked" : ""} />${colorTile(item.color, "agent-color-dot")}${escapeHtml(agentListLabel(item))}</label>`).join("") || `<span class="filter-note">Add an agent first.</span>`;
  const responderNames = room.agentIds.map((id) => agent(id)).filter(Boolean).map(agentListLabel);
  $("#roomResponderSummary").textContent = responderNames.length ? `${responderNames.length} selected · ${responderNames.slice(0, 2).join(', ')}${responderNames.length > 2 ? ` +${responderNames.length - 2}` : ''}` : 'Choose agents';
  $("#composerHint").textContent = busy ? (replyingHere ? (state.chatTurn?.stopping ? 'Stopping the reply…' : state.chatTurn?.localProgress || (state.chatTurn?.waitingFor ? `Waiting for ${state.chatTurn.waitingFor} before the next responder…` : 'The selected agents are responding…')) : 'A reply is running in another room. Stop it or wait before sending.') : room.agentIds.length ? `${room.agentIds.length} selected · history saved on this device` : "Select at least one agent.";
  if (chainBusy && !state.chatTurn) {
    const responder=agent(room.replyChain.agentIds[room.replyChain.index]);
    $("#composerHint").textContent = room.replyChain.status==='waiting' ? `Waiting for ${responder?.name || 'the paired agent'} · HexiGrid continues even if this tab closes.` : 'HexiGrid is continuing the saved responder sequence.';
  } else if (!busy && room.replyChain?.error) $("#composerHint").textContent=room.replyChain.error;
  if (!busy && room.agentIds.some(id => ['agent-link', 'ilands-link'].includes(agent(id)?.transport))) {
    $("#composerHint").textContent += ' Paired agents receive this conversation through their Link. A queued message is not a reply.';
  }
  if (!busy && roomComposerRecoveryHints.has(room.id)) $("#composerHint").textContent = roomComposerRecoveryHints.get(room.id);
  $("#messageList").innerHTML = room.messages.filter(message => message.delivery !== 'completed-link').map((message) => {
    const participant = message.agentId ? agent(message.agentId) : null;
    const avatarColor = participant ? colorTile(participant.color) : "";
    const delivery = message.delivery === 'signed-link' ? ' · EXTERNAL AGENT · SIGNED LINK' : message.role === 'agent' && message.delivery === 'local-only' ?
      (['agent-link', 'ilands-link'].includes(participant?.transport) ? ' · LOCAL PROFILE REPLY · NOT EXTERNAL AGENT' : ' · LOCAL CHAT') : '';
    const expired = message.linkedTurn?.status === 'queued' && Date.parse(message.linkedTurn.expiresAt) <= Date.now();
    const pending = message.linkedTurn?.status === 'queued' ? `<div class="room-delivery-actions">${expired ? '<p>This request expired. Send a new message to ask again.</p>' : '<button type="button" class="ghost-button" data-action="refresh-room">Check for reply</button>'}<button type="button" class="ghost-button" data-action="cancel-linked-reply" data-request-id="${escapeHtml(message.linkedTurn.requestId)}">Cancel request</button></div>` : '';
    return `<div class="message ${message.role}${message.linkedTurn ? ' link-status' : ''}"><div class="message-avatar">${avatarColor}<span class="avatar-initials">${message.role === "user" ? "T6" : escapeHtml(initials(message.author || "SH"))}</span></div><div class="message-body"><div class="message-meta"><span>${escapeHtml(participant ? agentListLabel(participant) : message.author || "System")} · ${timeAgo(message.createdAt)}</span>${delivery ? `<span class="room-delivery-badge${message.delivery === 'signed-link' ? ' verified' : ''}">${delivery.slice(3)}</span>` : ''}</div><div class="message-content">${escapeHtml(message.content)}</div>${pending}</div></div>`;
  }).join("") || `<div class="empty-state">No messages yet. Start the room.</div>`;
  for (const pending of unsavedLocalReplies.values()) {
    if (pending.roomId !== room.id) continue;
    $("#messageList").innerHTML += `<div class="message system"><div class="message-body"><div class="message-meta">Local reply · save not confirmed</div><div class="message-content">${escapeHtml(pending.body.content || pending.body.error)}</div><p>This reply is kept in this tab. Keep it open until saving succeeds.</p><button type="button" class="ghost-button" data-action="save-local-reply" data-reply-id="${escapeHtml(pending.body.replyId)}" ${pending.saving ? 'disabled' : ''}>${pending.saving ? 'Saving…' : 'Retry save'}</button></div></div>`;
  }
  const list = $("#messageList");
  list.scrollTop = list.scrollHeight;
}

async function saveLocalReply(replyId) {
  const pending = unsavedLocalReplies.get(replyId);
  if (!pending || pending.saving || state.chatTurn) return;
  pending.saving = true;
  renderRooms();
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(pending.roomId)}/messages/browser`, { method: 'POST', body: JSON.stringify(pending.body) });
    const room = state.data.rooms.find(item => item.id === pending.roomId);
    if (room) Object.assign(room, result.room);
    unsavedLocalReplies.delete(replyId);
    notify('Local reply saved. The model was not run again.');
  } catch { notify('Save is still not confirmed. Keep this tab open and retry when HexiGrid is available.', true); }
  finally { pending.saving = false; renderRooms(); }
}

async function refreshRoomReplies() {
  try { const result = await api('/api/rooms'); state.data.rooms=result.rooms; renderRooms(); }
  catch(error) { notify(error.message,true); }
}
async function cancelLinkedRoomReply(requestId) {
  try { await api(`/api/rooms/${encodeURIComponent(activeRoom().id)}/stop`,{method:'POST',body:JSON.stringify({requestId})}); await refreshRoomReplies(); }
  catch(error) { notify(error.message,true); }
}

async function setRoomArchived(roomId, archived) {
  const room = state.data.rooms.find((item) => item.id === roomId);
  if (!room) return;
  if (archived && !await userConfirm('Archive this room?', 'Its messages and responders stay on this device. You can restore it from Archived rooms.', 'Archive room')) return;
  try {
    const response = await api(`/api/rooms/${encodeURIComponent(room.id)}`, { method: 'PATCH', body: JSON.stringify({ archived }) });
    Object.assign(room, response.room);
    state.activeRoomId = archived ? state.data.rooms.find((item) => !item.archived)?.id : room.id;
    renderAll();
    notify(archived ? 'Room archived. Its history is retained.' : 'Room restored.');
  } catch (error) { notify(error.message, true); }
}

async function updateRoomAgents() {
  const room = activeRoom();
  if (!room) return;
  const checked = $$("[data-agent-toggle]:checked").map((input) => input.dataset.agentToggle);
  const selected = [...room.agentIds.filter(id => checked.includes(id)),...checked.filter(id => !room.agentIds.includes(id))];
  try {
    const response = await api(`/api/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ agentIds: selected }) });
    Object.assign(room, response.room); renderRooms();
  } catch (error) { notify(error.message, true); }
}

async function sendChat(event) {
  event.preventDefault();
  if (state.chatTurn) return;
  const room = activeRoom();
  const input = $("#chatInput");
  const content = input.value.trim();
  if (!content) return;
  if (!room) return notify("Create a chat room first.", true);
  if (!room.agentIds.length) return notify("Select at least one agent first.", true);
  roomComposerRecoveryHints.delete(room.id);
  const turn = { roomId: room.id, requestId: crypto.randomUUID(), controller: new AbortController(), saved: false, stopping: false };
  state.chatTurn = turn;
  input.value = ""; renderRooms();
  try {
    const hostParticipants=room.agentIds.map(id=>agent(id)).filter(Boolean);
    if (typeof isStandaloneBrowser==='function' && !isStandaloneBrowser() && hostParticipants.every(participant=>['agent-link','ilands-link'].includes(participant.transport) || !modelInfo(participant.model)?.browser)) {
      const accepted=await api(`/api/rooms/${room.id}/turns`,{method:'POST',body:JSON.stringify({content,agentIds:room.agentIds,requestId:turn.requestId})});
      Object.assign(room,accepted.room); turn.saved=true;
      return;
    }
    let response = await api(`/api/rooms/${room.id}/messages/user`, { method: "POST", body: JSON.stringify({ content, agentIds: room.agentIds }) });
    Object.assign(room, response.room); turn.saved = true; renderAll();
    const participants = room.agentIds.map((agentId) => agent(agentId)).filter(Boolean);
    for (const participant of participants) {
      if (turn.controller.signal.aborted) break;
      const model = modelInfo(participant.model);
      if (model?.browser && !['ilands-link', 'agent-link'].includes(participant.transport)) {
        const modelStatusName = localModelStatusName(model);
        let replyBody;
        try {
          const generated = await window.HexiGridBrowserChat.completeTurn({
            agent: participant,
            room,
            settings: state.data.settings,
            memories: state.data.memories,
            modelId: model.remoteModel,
            signal: turn.controller.signal,
            onProgress: (progress) => {
              if (turn.controller.signal.aborted) return;
              const status = $("#composerHint");
              if (progress?.generating) {
                turn.localProgress = `Generating locally with ${modelStatusName}…`;
                if (activeRoom()?.id === turn.roomId) status.textContent = turn.localProgress;
                return;
              }
              const fraction = Number(progress?.progress);
              turn.localProgress = Number.isFinite(fraction)
                ? `Preparing ${modelStatusName} · ${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
                : `Preparing ${modelStatusName}…`;
              if (activeRoom()?.id === turn.roomId) status.textContent = turn.localProgress;
            }
          });
          if (turn.controller.signal.aborted) break;
          replyBody = { agentId: participant.id, content: generated.content, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, inputText: content, outputText: generated.content };
        } catch (error) {
          if (turn.controller.signal.aborted) break;
          turn.localInferenceFailed = true;
          replyBody = { agentId: participant.id, error: error.message };
        }
        replyBody.replyId = crypto.randomUUID();
        try {
          response = await api(`/api/rooms/${room.id}/messages/browser`, { method: 'POST', body: JSON.stringify(replyBody) });
        } catch {
          unsavedLocalReplies.set(replyBody.replyId, { roomId: room.id, body: replyBody, saving: false });
          notify('Local reply save is not confirmed. Use Retry save below; the model will not run again. Keep this tab open.', true);
          break;
        }
      } else {
        response = await api(`/api/rooms/${room.id}/messages`, { method: "POST", signal: turn.controller.signal, body: JSON.stringify({ agentIds: [participant.id], includeUserMessage: false, requestId: turn.requestId }) });
      }
      Object.assign(room, response.room);
      renderAll();
      const queued = response.replies?.find(message => message.linkedTurn?.status === 'queued');
      if (queued && participant !== participants.at(-1)) {
        turn.waitingFor = participant.name;
        renderRooms();
        response = await api(`/api/rooms/${encodeURIComponent(room.id)}/replies/${encodeURIComponent(queued.linkedTurn.eventId)}/wait?requestId=${encodeURIComponent(turn.requestId)}`,{signal:turn.controller.signal});
        Object.assign(room,response.room);
        turn.waitingFor = null;
        renderAll();
      }
    }
  } catch (error) {
    if (!turn.controller.signal.aborted) notify(error.message, true);
    if (!turn.saved) {
      roomComposerDrafts.set(room.id, content);
      if (activeRoom()?.id === room.id) input.value = content;
    }
  }
  finally {
    if (turn.stopping) await turn.stopPromise;
    if (state.chatTurn === turn) state.chatTurn = null;
    renderRooms();
    if (turn.localInferenceFailed && !turn.controller.signal.aborted) {
      roomComposerDrafts.set(room.id, content);
      roomComposerRecoveryHints.set(room.id, 'The previous prompt is saved above. This composer keeps a retry draft you can edit or send again.');
      if (activeRoom()?.id === room.id) {
        input.value = content;
        $("#composerHint").textContent = roomComposerRecoveryHints.get(room.id);
      }
    }
    if (activeRoom()?.id === room.id) input.focus();
    void applyRoomEvents();
  }
}

async function stopChat() {
  const room=activeRoom();
  const turn = state.chatTurn || (['ready','waiting','running'].includes(room?.replyChain?.status) ? {roomId:room.id,requestId:room.replyChain.requestId,saved:true,controller:new AbortController()} : null);
  if (!turn?.saved || turn.stopping) return;
  turn.stopping = true;
  turn.stopPromise = (async () => {
    try {
      await api(`/api/rooms/${encodeURIComponent(turn.roomId)}/stop`, { method: 'POST', body: JSON.stringify({ requestId: turn.requestId }) });
      const latest = await api('/api/rooms');
      state.data.rooms = latest.rooms;
      notify('Reply stopped. Saved messages are retained.');
    } catch (error) { notify(`Stop could not be confirmed: ${error.message}`, true); }
  })();
  turn.controller.abort();
  renderRooms();
}

async function newRoom() {
  const name = await userInput("Create a chat room", "Room name", `Room ${state.data.rooms.length + 1}`);
  if (!name?.trim()) return;
  try {
    const response = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name }) });
    state.data.rooms.push(response.room); state.activeRoomId = response.room.id; renderAll(); showView("room"); notify(`${response.room.name} created.`);
  } catch (error) { notify(error.message, true); }
}

async function renameRoom() {
  const room = activeRoom();
  if (!room) return;
  const name = await userInput("Rename this room", "Room name", room.name);
  if (!name?.trim()) return;
  try {
    const response = await api(`/api/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    Object.assign(room, response.room); renderAll(); notify("Room updated.");
  } catch (error) { notify(error.message, true); }
}
