// Wait for a signed reply through notifications, never model or network polling.
export function createLinkedRoomWaiters() {
  const waiters = new Set();
  const failure = (message, status = 409) => Object.assign(new Error(message), {status});
  function wait({room, eventId, requestId, signal}) {
    if (waiters.size >= 64) return Promise.reject(failure('Too many conversations are waiting for replies.',503));
    return new Promise((resolve,reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); waiters.delete(check); signal?.removeEventListener('abort',aborted); };
      const finish = (error,result) => { cleanup(); error ? reject(error) : resolve(result); };
      const aborted = () => finish(failure('The reply wait stopped. Saved messages are retained.'));
      const pending = () => room.messages.find(message => message.linkedTurn?.eventId === eventId && message.linkedTurn.requestId === requestId);
      const check = () => {
        const message = pending();
        if (!message || room.archived || !room.agentIds.includes(message.agentId)) return finish(failure('This reply request is no longer available.'));
        if (message.linkedTurn.status === 'completed') {
          const reply = room.messages.find(item => item.inReplyTo === message.id && item.delivery === 'signed-link');
          return reply ? finish(null,{room,message:reply}) : finish(failure('The signed reply is unavailable.'));
        }
        if (message.linkedTurn.status !== 'queued') return finish(failure('This reply request was cancelled.'));
        if (!Number.isFinite(Date.parse(message.linkedTurn.expiresAt)) || Date.parse(message.linkedTurn.expiresAt) <= Date.now()) return finish(failure('The external reply request expired.'));
      };
      waiters.add(check);
      signal?.addEventListener('abort',aborted,{once:true});
      if (signal?.aborted) return aborted();
      check(); // A fast reply may have arrived before the owner begins waiting.
      if (!waiters.has(check)) return;
      const expiresAt = Date.parse(pending()?.linkedTurn.expiresAt);
      timer = setTimeout(() => finish(failure('The external reply request expired.')),Math.min(15 * 60 * 1000,Math.max(1,expiresAt - Date.now() + 1)));
      timer.unref?.();
    });
  }
  function changed() { for (const check of [...waiters]) check(); }
  return {wait,changed};
}
