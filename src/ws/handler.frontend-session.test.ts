import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { websocket } from 'hono/bun';
import { closeDatabase, getDb, initDatabase } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { sendToFrontendSession } from '../spindle/frontend-session';
import { eventBus } from './bus';
import { EventType } from './events';
import { issueTicket, stopTicketSweep } from './tickets';

test('real sockets reconnect within one document while preserving user isolation and close events', async () => {
  closeDatabase();
  await runMigrations(initDatabase(':memory:'));
  for (const id of ['owner', 'other']) getDb().run('INSERT INTO user(id,name,email) VALUES(?,?,?)', [id, id, `${id}@example.test`]);
  const { wsHandler } = await import('./handler');
  const app = new Hono().get('/ws', wsHandler);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket });
  const sockets: WebSocket[] = [];
  const closed: unknown[] = [];
  const off = eventBus.on(EventType.FRONTEND_SESSION_CLOSED, event => closed.push(event));
  const documentId = '0123456789abcdef0123456789abcdef';
  const nextMessage = (socket: WebSocket) => new Promise<any>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true }));
  const nextClose = (socket: WebSocket) => new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }));
  async function connect(userId: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?ticket=${issueTicket(userId)}&frontend_session=${documentId}`);
    sockets.push(socket);
    expect((await nextMessage(socket)).event).toBe(EventType.CONNECTED);
    return socket;
  }
  try {
    const original = await connect('owner');
    const replaced = nextClose(original);
    const current = await connect('owner');
    await replaced;
    await Bun.sleep(0);
    expect(closed).toEqual([]);
    const other = await connect('other');
    expect(current.readyState).toBe(WebSocket.OPEN);
    const currentMessage = nextMessage(current);
    const otherMessage = nextMessage(other);
    expect(sendToFrontendSession('owner', documentId, { destination: 'owner' })).toBe(true);
    expect(sendToFrontendSession('other', documentId, { destination: 'other' })).toBe(true);
    expect(await currentMessage).toEqual({ destination: 'owner' });
    expect(await otherMessage).toEqual({ destination: 'other' });
    const currentClosed = nextClose(current);
    const notified = new Promise<void>(resolve => {
      const remove = eventBus.on(EventType.FRONTEND_SESSION_CLOSED, () => { remove(); resolve(); });
    });
    current.close();
    await Promise.all([currentClosed, notified]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ userId: 'owner', payload: { frontendSessionId: documentId } });
    expect(sendToFrontendSession('owner', documentId, {})).toBe(false);
    expect(other.readyState).toBe(WebSocket.OPEN);
  } finally {
    off();
    const closing = sockets.filter(socket => socket.readyState !== WebSocket.CLOSED).map(socket => {
      const done = nextClose(socket); socket.close(); return done;
    });
    await Promise.all(closing);
    server.stop(true);
    eventBus.stopSweep();
    stopTicketSweep();
    closeDatabase();
  }
});
