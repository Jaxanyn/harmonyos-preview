import assert from 'node:assert/strict';
import { createPreviewServer } from '../src/server.mjs';
import WebSocket from 'ws';

const server = createPreviewServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { name: 'harmonyos-preview', status: 'ok' });

  const missing = await fetch(`http://127.0.0.1:${port}/missing`);
  assert.equal(missing.status, 404);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/preview`);
  const messages = [];
  await new Promise((resolve, reject) => {
    socket.on('message', (message) => {
      messages.push(message);
      if (messages.length === 3) resolve();
    });
    socket.on('error', reject);
  });
  assert.equal(JSON.parse(messages[0].toString()).type, 'status');
  assert.deepEqual(JSON.parse(messages[1].toString()), { type: 'frame-meta', mimeType: 'image/svg+xml', width: 1080, height: 1920 });
  assert.equal(messages[2][0], 0x3c);
  socket.send(JSON.stringify({ type: 'tap', x: 120, y: 240 }));
  const tapAck = await new Promise((resolve, reject) => {
    socket.once('message', resolve);
    socket.once('error', reject);
  });
  assert.deepEqual(JSON.parse(tapAck.toString()), { type: 'tap-ack', x: 120, y: 240 });
  socket.close();
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('smoke: ok');
