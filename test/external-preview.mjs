import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreviewServer } from '../src/server.mjs';
import { startMcp } from '../src/mcp.mjs';

const adapter = {
  listTargets: async () => ['test-device'],
  capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]) }),
  tap: async (args) => args,
  swipe: async (args) => args,
  longPress: async (args) => args,
  keyEvent: async (args) => args,
  inputText: async (args) => args
};
const previewServer = createPreviewServer({ deviceAdapter: adapter });
await new Promise((resolve) => previewServer.listen(0, '127.0.0.1', resolve));
const previewUrl = `http://127.0.0.1:${previewServer.address().port}`;
const stateDirectory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-state-'));
const previewStatePath = join(stateDirectory, 'preview-session.json');
const input = new PassThrough();
const output = new PassThrough();
const running = startMcp({ input, output, previewUrl, previewStatePath, previewTimeoutMs: 500, deviceAdapter: adapter });
const responses = createInterface({ input: output })[Symbol.asyncIterator]();

async function request(id, method, params) {
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return JSON.parse((await responses.next()).value);
}

let session;
try {
  const initialized = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const started = await request(2, 'tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  session = JSON.parse(started.result.content[0].text);
  assert.equal(session.serverUrl, `${previewUrl}/`);
  assert.equal(session.wsUrl, `${previewUrl.replace('http:', 'ws:')}/preview`);
  assert.equal((await fetch(`${previewUrl}/health`)).status, 200);
} finally {
  input.end();
  await running;
  const persisted = JSON.parse(await readFile(previewStatePath, 'utf8'));
  assert.equal(persisted.deviceId, 'test-device');
  const restoredInput = new PassThrough();
  const restoredOutput = new PassThrough();
  const restoredRunning = startMcp({ input: restoredInput, output: restoredOutput, previewUrl, previewStatePath, previewTimeoutMs: 500, deviceAdapter: adapter });
  const restoredResponses = createInterface({ input: restoredOutput })[Symbol.asyncIterator]();
  const restoredRequest = async (id, method, params) => {
    restoredInput.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return JSON.parse((await restoredResponses.next()).value);
  };
  await restoredRequest(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  restoredInput.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const info = await restoredRequest(2, 'tools/call', { name: 'preview_info', arguments: {} });
  const restored = JSON.parse(info.result.content[0].text);
  assert.equal(restored.restored, true);
  assert.equal(restored.sessionId, session.sessionId);
  restoredInput.end();
  await restoredRunning;
  assert.equal((await fetch(`${previewUrl}/health`)).status, 200, 'external preview server must outlive MCP');
  await previewServer.shutdown();
  await rm(stateDirectory, { recursive: true, force: true });
  output.end();
}
console.log('external preview: ok');
