/**
 * Server-Sent Events: кезек өзгерген сәтте барлық ашық беттерге (әкімші, клиент, табло)
 * қысқа хабар жібереді, олар деректі қайта сұрайды. Хабарда жеке дерек жоқ.
 */
export function createEventHub({ maxClients = 5000, heartbeatMs = 25_000 } = {}) {
  const clients = new Set();
  let version = 0;

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  return {
    handler(req, res) {
      if (clients.size >= maxClients) return res.status(503).json({ error: 'busy' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\nevent: hello\ndata: {"v":${version}}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },

    /** @param {'queue' | 'types' | 'settings'} type */
    emit(type) {
      version += 1;
      const message = `event: ${type}\ndata: {"v":${version}}\n\n`;
      for (const res of clients) res.write(message);
    },

    get size() {
      return clients.size;
    },

    close() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
