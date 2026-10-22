// Owner-only invalidation stream. Never send conversation text or credentials.
export function createRoomEvents({ authorized, headers, intervalMs = 30000 }) {
  const clients = new Set();
  function subscribe(req, res) {
    if (!authorized(req)) return false;
    if (clients.size >= 64) { res.writeHead(503, headers('text/plain')); res.end('Too many live conversation views.'); return true; }
    res.writeHead(200, { ...headers('text/event-stream'), connection:'keep-alive' });
    res.write('retry: 3000\n\n');
    const client = {req,res};
    clients.add(client);
    const cleanup = () => { clearInterval(client.timer); clients.delete(client); };
    client.timer = setInterval(() => {
      if (!authorized(req)) { cleanup(); res.end(); return; }
      res.write(': keepalive\n\n');
    },intervalMs);
    client.timer.unref?.();
    res.once('close',cleanup);
    return true;
  }
  function publish() {
    for (const client of clients) {
      if (!authorized(client.req) || client.res.destroyed) { clearInterval(client.timer); clients.delete(client); client.res.end(); continue; }
      if (!client.res.write('event: rooms-changed\ndata: {}\n\n')) {
        clearInterval(client.timer); clients.delete(client); client.res.end();
      }
    }
  }
  return {subscribe,publish};
}
