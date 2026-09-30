import assert from 'node:assert/strict';
import { createPreviewServer } from '../src/server.mjs';
import WebSocket from 'ws';
import { createDeviceAdapter } from '../src/device.mjs';
import { readProjectConfig } from '../src/project.mjs';
import { access } from 'node:fs/promises';

const calls = [];
const fakeDevice = createDeviceAdapter({ runtime: async (command, args) => {
  calls.push({ command, args });
  if (args.includes('list')) return { code: 0, stdout: 'test-device\n', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
} });
assert.deepEqual(await fakeDevice.listTargets(), ['test-device']);
assert.deepEqual(await fakeDevice.tap({ deviceId: 'test-device', x: 12.4, y: 30.6 }), { deviceId: 'test-device', x: 12, y: 31 });
assert.deepEqual(await fakeDevice.swipe({ deviceId: 'test-device', fromX: 10, fromY: 20, toX: 30, toY: 40 }), { deviceId: 'test-device', fromX: 10, fromY: 20, toX: 30, toY: 40, velocity: 600 });
assert.deepEqual(await fakeDevice.longPress({ deviceId: 'test-device', x: 12.4, y: 30.6 }), { deviceId: 'test-device', x: 12, y: 31 });
assert.deepEqual(await fakeDevice.keyEvent({ deviceId: 'test-device', key: 'Back' }), { deviceId: 'test-device', key: 'Back' });
assert.deepEqual(await fakeDevice.inputText({ deviceId: 'test-device', text: 'hello' }), { deviceId: 'test-device', text: 'hello' });
assert.equal(calls.length, 6);
assert.deepEqual(calls[1].args, ['-t', 'test-device', 'shell', 'uitest', 'uiInput', 'click', '12', '31']);
assert.deepEqual(calls[2].args, ['-t', 'test-device', 'shell', 'uitest', 'uiInput', 'swipe', '10', '20', '30', '40', '600']);
assert.deepEqual(calls[3].args, ['-t', 'test-device', 'shell', 'uitest', 'uiInput', 'longClick', '12', '31']);
assert.deepEqual(calls[4].args, ['-t', 'test-device', 'shell', 'uitest', 'uiInput', 'keyEvent', 'Back']);
assert.deepEqual(calls[5].args, ['-t', 'test-device', 'shell', 'uitest', 'uiInput', 'text', 'hello']);
for (const x of [-1, NaN, Infinity, '12']) {
  await assert.rejects(fakeDevice.tap({ deviceId: 'test-device', x, y: 30 }), /non-negative finite/);
}
assert.equal(calls.length, 6, 'invalid coordinates must not reach hdc');
const failingDevice = createDeviceAdapter({ runtime: async () => ({ code: 1, stdout: '', stderr: 'device disconnected' }) });
await assert.rejects(failingDevice.tap({ deviceId: 'test-device', x: 12, y: 30 }), /device disconnected/);
assert.deepEqual(readProjectConfig('C:/path/to/my-harmonyos-project'), {
  projectPath: 'C:/path/to/my-harmonyos-project', moduleName: 'entry', bundleName: 'com.example.preview', ability: 'EntryAbility'
});
await access(new URL('../bin/harmonyos-preview.mjs', import.meta.url));

let captured = 0;
const sessionDevice = {
  listTargets: async () => ['test-device'],
  tap: fakeDevice.tap,
  swipe: fakeDevice.swipe,
  longPress: fakeDevice.longPress,
  keyEvent: fakeDevice.keyEvent,
  inputText: fakeDevice.inputText,
  install: async () => ({}),
  launch: async () => ({}),
  capture: async () => { captured += 1; return { mimeType: 'image/jpeg', data: Buffer.from('frame') }; }
};

const server = createPreviewServer({ deviceAdapter: sessionDevice });
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

  const capabilities = await fetch(`http://127.0.0.1:${port}/api/capabilities`);
  assert.deepEqual(await capabilities.json(), {
    name: 'harmonyos-preview', version: 1,
    http: ['GET /api/devices', 'POST /api/capture', 'POST /api/tap'],
    websocket: `ws://127.0.0.1:${port}/preview`,
    messages: ['device-list', 'screenshot', 'tap', 'swipe', 'long-press', 'key-event', 'input-text', 'preview-start', 'preview-stop', 'build-run']
  });

  const apiTap = await fetch(`http://127.0.0.1:${port}/api/tap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'test-device', x: 5, y: 6 })
  });
  assert.deepEqual(await apiTap.json(), { deviceId: 'test-device', x: 5, y: 6 });

  const apiCapture = await fetch(`http://127.0.0.1:${port}/api/capture`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'test-device' })
  });
  assert.deepEqual(await apiCapture.json(), { mimeType: 'image/jpeg', data: Buffer.from('frame').toString('base64') });

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
  const tapAck = await new Promise((resolve, reject) => {
    socket.once('message', resolve);
    socket.once('error', reject);
    socket.send(JSON.stringify({ type: 'tap', deviceId: 'test-device', x: 120, y: 240 }));
  });
  assert.deepEqual(JSON.parse(tapAck.toString()), { type: 'tap-ack', deviceId: 'test-device', x: 120, y: 240 });
  const invalidTap = await new Promise((resolve) => {
    socket.once('message', resolve);
    socket.send(JSON.stringify({ type: 'tap', deviceId: 'test-device', x: -1, y: 240 }));
  });
  assert.match(JSON.parse(invalidTap.toString()).error, /non-negative finite/);
  const screenshot = await new Promise((resolve) => {
    socket.once('message', resolve);
    socket.send(JSON.stringify({ type: 'screenshot', deviceId: 'test-device' }));
  });
  assert.deepEqual(JSON.parse(screenshot.toString()), { type: 'frame-meta', mimeType: 'image/jpeg', deviceId: 'test-device' });

  socket.send(JSON.stringify({ type: 'preview-start', deviceId: 'test-device' }));
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.ok(captured >= 1);
  socket.send(JSON.stringify({ type: 'preview-stop' }));
} finally {
  socket?.terminate();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

let reconnectCaptures = 0;
const reconnectDevice = {
  listTargets: async () => reconnectCaptures < 2 ? [] : ['test-device'],
  capture: async () => {
    reconnectCaptures += 1;
    if (reconnectCaptures === 1) throw new Error('device disconnected');
    return { mimeType: 'image/jpeg', data: Buffer.from('reconnected-frame') };
  },
  tap: sessionDevice.tap,
  swipe: sessionDevice.swipe,
  longPress: sessionDevice.longPress,
  keyEvent: sessionDevice.keyEvent,
  inputText: sessionDevice.inputText
};
const reconnectServer = createPreviewServer({ deviceAdapter: reconnectDevice });
await new Promise((resolve) => reconnectServer.listen(0, '127.0.0.1', resolve));
const reconnectSocket = new WebSocket('ws://127.0.0.1:' + reconnectServer.address().port + '/preview');
const reconnectMessages = [];
reconnectSocket.on('message', (message) => reconnectMessages.push(message));
await new Promise((resolve, reject) => {
  reconnectSocket.once('open', resolve);
  reconnectSocket.once('error', reject);
});
reconnectSocket.send(JSON.stringify({ type: 'preview-start', deviceId: 'test-device' }));
await new Promise((resolve) => setTimeout(resolve, 750));
const reconnectEvents = reconnectMessages.filter((message) => message[0] === 0x7b).map((message) => JSON.parse(message.toString()));
assert.ok(reconnectEvents.some((event) => event.type === 'preview-status' && event.reason === 'device-disconnected'));
assert.ok(reconnectEvents.some((event) => event.type === 'devices' && event.devices.length === 0));
assert.ok(reconnectEvents.some((event) => event.type === 'preview-status' && event.running && event.reconnecting === false));
assert.ok(reconnectMessages.some((message) => message.toString() === 'reconnected-frame'));
reconnectSocket.terminate();
await reconnectServer.shutdown();

console.log('smoke: ok');
