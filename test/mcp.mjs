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
const running = startMcp({ input, output, port: 0, projectPath: '', deviceAdapter: {
  listTargets: async () => ['test-device'],
  capture: async ({ deviceId }) => {
    if (deviceId === 'disconnected') throw new Error('device disconnected');
    return { mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]) };
  },
  tap: async (args) => { taps += 1; return args; }
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
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['list_devices', 'capture', 'tap', 'build_run', 'preview_info']);
  assert.deepEqual((await request('ping')).result, {});
  const devices = await request('tools/call', { name: 'list_devices' });
  assert.deepEqual(JSON.parse(devices.result.content[0].text), { devices: ['test-device'] });
  const image = await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(image.result.content[0], { type: 'image', mimeType: 'image/jpeg', data: '/9j/' });
  await request('tools/call', { name: 'tap', arguments: { deviceId: 'test-device', x: 12, y: 24 } });
  assert.equal(taps, 1);
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
