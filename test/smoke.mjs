import assert from 'node:assert/strict';
import { createPreviewServer } from '../src/server.mjs';
import WebSocket from 'ws';
import { createDeviceAdapter } from '../src/device.mjs';

const calls = [];
const fakeDevice = createDeviceAdapter({ runtime: async (command, args) => {
  calls.push({ command, args });
  if (args.includes('list')) return { code: 0, stdout: 'test-device\n', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
} });
assert.deepEqual(await fakeDevice.listTargets(), ['test-device']);
assert.deepEqual(await fakeDevice.tap({ deviceId: 'test-device', x: 12.4, y: 30.6 }), { deviceId: 'test-device', x: 12, y: 31 });
assert.equal(calls.length, 2);

const server = createPreviewServer({ deviceAdapter: fakeDevice });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
let socket;

try {
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { name: 'harmonyos-preview', status: 'ok' });

  const missing = await fetch(`http://127.0.0.1:${port}/missing`);
  assert.equal(missing.status, 404);

  const devices = await fetch(`http://127.0.0.1:${port}/api/devices`);
  assert.deepEqual(await devices.json(), { devices: ['test-device'] });

  socket = new WebSocket(`ws://127.0.0.1:${port}/preview`);
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
  socket.send(JSON.stringify({ type: 'tap', deviceId: 'test-device', x: 120, y: 240 }));
  const tapAck = await new Promise((resolve, reject) => {
    socket.once('message', resolve);
    socket.once('error', reject);
  });
  assert.deepEqual(JSON.parse(tapAck.toString()), { type: 'tap-ack', deviceId: 'test-device', x: 120, y: 240 });
} finally {
  socket?.terminate();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('smoke: ok');
