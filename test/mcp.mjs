import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startMcp } from '../src/mcp.mjs';

const input = new PassThrough();
const output = new PassThrough();
const responses = createInterface({ input: output })[Symbol.asyncIterator]();
let taps = 0;
let offline = false;
const running = startMcp({ input, output, port: 0, projectPath: '', previewTimeoutMs: 200, deviceAdapter: {
  listTargets: async () => ['test-device'],
  capture: async ({ deviceId }) => {
    if (offline || deviceId === 'disconnected') throw new Error('device disconnected');
    if (deviceId === 'png-device') return { mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
    return { mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]) };
  },
  tap: async (args) => { taps += 1; return args; },
  swipe: async (args) => args,
  longPress: async (args) => args,
  keyEvent: async (args) => args,
  inputText: async (args) => args
} });
let id = 0;
async function request(method, params) {
  input.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  const line = await responses.next();
  const reply = JSON.parse(line.value);
  assert.equal(reply.id, id);
  return reply;
}

let previewUrl;
let socket;
try {
  assert.equal((await request('tools/list')).error.code, -32600);
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result.capabilities, { tools: {} });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const listed = await request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['list_devices', 'capture', 'tap', 'swipe', 'long_press', 'key_event', 'input_text', 'preview_start', 'preview_stop', 'build_run', 'preview_info']);
  assert.deepEqual((await request('ping')).result, {});
  const devices = await request('tools/call', { name: 'list_devices' });
  assert.deepEqual(JSON.parse(devices.result.content[0].text), { devices: ['test-device'] });
  const image = await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(image.result.content[0], { type: 'image', mimeType: 'image/jpeg', data: '/9j/' });
  assert.deepEqual(image.result.structuredContent, { deviceId: 'test-device', live: false, sessionId: null });
  const previewStarted = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  const session = JSON.parse(previewStarted.result.content[0].text);
  assert.equal(session.deviceId, 'test-device');
  assert.equal(session.running, true);
  assert.equal(session.connected, true);
  assert.equal(session.pollMs, 500);
  assert.match(session.sessionId, /^[\da-f-]{36}$/);
  assert.equal(session.wsUrl, session.previewUrl.replace('http:', 'ws:') + 'preview');
  assert.ok(session.capabilities.includes('tap'));
  const repeated = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(JSON.parse(repeated.result.content[0].text), session, 'repeated start must reuse the same session');
  assert.equal((await request('tools/call', { name: 'preview_stop', arguments: { sessionId: 'stale-session' } })).result.isError, true);
  assert.equal(JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text).sessionId, session.sessionId);
  const liveImage = await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(liveImage.result.content[0], { type: 'image', mimeType: 'image/jpeg', data: '/9j/' });
  assert.deepEqual(liveImage.result.structuredContent, { deviceId: 'test-device', live: true, sessionId: session.sessionId });
  offline = true;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text).connected, false);
  assert.equal((await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } })).result.isError, true, 'offline capture must not return a stale cached image');
  offline = false;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text).connected, true);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'swipe', arguments: { deviceId: 'test-device', fromX: 1, fromY: 2, toX: 3, toY: 4 } })).result.content[0].text).toX, 3);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'long_press', arguments: { deviceId: 'test-device', x: 1, y: 2 } })).result.content[0].text).x, 1);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'key_event', arguments: { deviceId: 'test-device', key: 'Back' } })).result.content[0].text).key, 'Back');
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'input_text', arguments: { deviceId: 'test-device', text: 'hello' } })).result.content[0].text).text, 'hello');
  await request('tools/call', { name: 'tap', arguments: { deviceId: 'test-device', x: 12, y: 24 } });
  assert.equal(taps, 1);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'preview_stop', arguments: { sessionId: session.sessionId } })).result.content[0].text), { running: false, deviceId: 'test-device', sessionId: session.sessionId });
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'preview_stop' })).result.content[0].text), { running: false });
  const pngStarted = JSON.parse((await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'png-device' } })).result.content[0].text);
  assert.notEqual(pngStarted.sessionId, session.sessionId);
  const pngCapture = await request('tools/call', { name: 'capture', arguments: { deviceId: 'png-device' } });
  assert.deepEqual(pngCapture.result.content[0], { type: 'image', mimeType: 'image/png', data: 'iVBORw==' });
  assert.deepEqual(pngCapture.result.structuredContent, { deviceId: 'png-device', live: true, sessionId: pngStarted.sessionId });
  const replaced = JSON.parse((await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } })).result.content[0].text);
  assert.notEqual(replaced.sessionId, pngStarted.sessionId, 'switching device must replace the session');
  const timedOut = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'disconnected' } });
  assert.equal(timedOut.result.isError, true);
  assert.match(timedOut.result.content[0].text, /Timed out/);
  const stoppedInfo = JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text);
  assert.equal(stoppedInfo.running, false);
  assert.equal(stoppedInfo.sessionId, null);
  for (const args of [{ deviceId: 'test-device', x: -1, y: 24 }, { deviceId: 'test-device', x: '12', y: 24 }, null]) {
    assert.equal((await request('tools/call', { name: 'tap', arguments: args })).error.code, -32602);
  }
  assert.equal(taps, 1, 'invalid arguments must not reach the device');
  assert.equal((await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device', directory: 'outside' } })).error.code, -32602);
  assert.equal((await request('tools/call', { name: 'unknown' })).error.code, -32602);
  assert.equal((await request('unknown')).error.code, -32601);
  const disconnected = await request('tools/call', { name: 'capture', arguments: { deviceId: 'disconnected' } });
  assert.equal(disconnected.result.isError, true);
  assert.match(disconnected.result.content[0].text, /disconnected/);
  const build = await request('tools/call', { name: 'build_run', arguments: { deviceId: 'test-device' } });
  assert.equal(build.result.isError, true);
  assert.match(build.result.content[0].text, /HARMONY_PROJECT/);
  input.write('invalid json\n');
  assert.equal(JSON.parse((await responses.next()).value).error.code, -32700);
  const info = await request('tools/call', { name: 'preview_info' });
  previewUrl = JSON.parse(info.result.content[0].text).previewUrl;
  assert.equal((await fetch(previewUrl + 'health')).status, 200);
  socket = new WebSocket(previewUrl.replace('http:', 'ws:') + 'preview');
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  assert.equal((await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } })).result.isError, undefined, 'leave a live session for EOF cleanup');
} finally {
  input.end();
  await running;
  socket?.terminate();
  output.end();
}
await assert.rejects(fetch(previewUrl + 'health'), /fetch failed/);

// Exercise the actual CLI over stdio, including a working directory outside the repository.
const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/harmonyos-preview.mjs', import.meta.url)), '--mcp'], {
  cwd: process.env.TEMP, env: { ...process.env, HARMONY_PREVIEW_PORT: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
const cliReplies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' }
} }) + '\n');
assert.equal(JSON.parse((await cliReplies.next()).value).result.serverInfo.name, 'harmonyos-preview');
child.stdin.end();
assert.equal(await exited, 0, stderr);
assert.equal((await cliReplies.next()).done, true, 'stdout must contain only MCP responses');
console.log('mcp: ok');
