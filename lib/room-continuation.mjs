// The encrypted room owns its continuation; an HTTP connection does not.
export const ongoingRoomReply = room => ['ready','waiting','running'].includes(room?.replyChain?.status);

export function createRoomContinuations({rooms, save, publish, turns, findAgent, isBrowser, queue, wait, respond, message, validate, prepareCompleted, completed}) {
  const workers = new Map();
  const transcript = room => room.messages.slice(-18).map(item => `${item.author || item.role}: ${item.content}`).join('\n');
  async function persist() { await save(); publish(); }
  function kick(room) {
    if (workers.has(room.id) || !ongoingRoomReply(room)) return;
    const chain = room.replyChain;
    const turn = {requestId:chain.requestId,controller:new AbortController()};
    if (turns.has(room.id)) return;
    turns.set(room.id,turn);
    const work = (async () => {
      try {
        while (ongoingRoomReply(room) && room.replyChain === chain) {
          if (turn.controller.signal.aborted) break;
          if (room.archived) throw new Error('Room archived. Remaining responders were not run.');
          if (!Array.isArray(chain.agentIds) || !Number.isSafeInteger(chain.index) || chain.index<0 || chain.index>=chain.agentIds.length || !room.messages.some(item=>item.id===chain.ownerMessageId && item.role==='user')) throw new Error('The saved continuation is incomplete. Send a new message to continue.');
          const agentId = chain.agentIds[chain.index];
          const agent = findAgent(agentId);
          if (!agent || !room.agentIds.includes(agentId)) throw new Error('A responder was removed. Remaining responders were not run.');
          validate(agent,chain);
          if (chain.status === 'waiting') {
            await wait({room,eventId:chain.eventId,requestId:chain.requestId,signal:turn.controller.signal});
            if (turn.controller.signal.aborted || room.replyChain !== chain) break;
          } else {
            if (isBrowser(agent)) throw new Error('This responder needs an open browser. Send a new message with its browser model selected.');
            const queued = queue(room,agent,chain,transcript(room));
            if (queued) {
              chain.status='waiting'; chain.eventId=queued.linkedTurn.eventId;
              await persist();
              continue;
            }
            // Durable intent before dispatch. A restart here is uncertain, never retried automatically.
            chain.status='running'; delete chain.eventId;
            await persist();
            if (turn.controller.signal.aborted || room.replyChain!==chain || room.archived) break;
            validate(agent,chain);
            const response = await respond(agent,transcript(room),chain,turn.controller.signal);
            if (turn.controller.signal.aborted || room.replyChain !== chain || room.archived) break;
            if (findAgent(agentId)!==agent || !room.agentIds.includes(agentId)) throw new Error('A responder changed while replying. Remaining responders were not run.');
            validate(agent,chain);
            if (!response.ok) throw new Error(response.error || 'The responder could not answer.');
            room.messages.push(message(agent,response,chain));
          }
          chain.index += 1;
          chain.status = chain.index >= chain.agentIds.length ? 'completed' : 'ready';
          delete chain.eventId;
          if (chain.status === 'completed' && typeof prepareCompleted === 'function') {
            try { prepareCompleted(room, chain); } catch { /* Optional post-completion work cannot block the room reply. */ }
          }
          await persist();
          if (chain.status === 'completed' && typeof completed === 'function') {
            // Queueing is reference-only and detached from the settled room response.
            // Source references live on the room so a following replyChain cannot replace them.
            void Promise.resolve().then(async () => {
              try { await completed(room, chain); }
              catch { /* Room-level source references remain for startup recovery. */ }
            });
          }
        }
      } catch(error) {
        if (!turn.controller.signal.aborted && room.replyChain === chain) {
          chain.status='blocked'; chain.error=error.message;
          try { await persist(); } catch { /* The saved pre-dispatch state stays conservative. */ }
        }
      } finally {
        if (turns.get(room.id) === turn) turns.delete(room.id);
        workers.delete(room.id);
      }
    })();
    workers.set(room.id,work);
    return work;
  }
  async function recover() {
    for (const room of rooms()) {
      if (room.replyChain?.status === 'running') {
        room.replyChain.status='interrupted';
        room.replyChain.error='HexiGrid restarted during a model call. Its outcome is uncertain; it was not retried. Send a new message if needed.';
        await persist();
      } else kick(room);
      if (typeof completed === 'function') {
        try { await completed(room, room.replyChain); }
        catch { /* Room-level source references are retried on the next launch. */ }
      }
    }
  }
  async function stop(room,reason='The owner stopped this reply. Saved messages are retained.') {
    if (!ongoingRoomReply(room)) return false;
    room.replyChain.status='cancelled'; room.replyChain.error=reason;
    turns.get(room.id)?.controller.abort('owner-stop');
    await persist();
    return true;
  }
  return {kick,recover,stop,settled:room => workers.get(room.id)};
}
