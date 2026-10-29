import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(previewStatePath, JSON.stringify({ ...persisted, lastSeen: Date.now() - 5000 }));
  const staleInput = new PassThrough();
  const staleOutput = new PassThrough();
  const staleRunning = startMcp({ input: staleInput, output: staleOutput, previewUrl, previewStatePath, previewStateTtlMs: 1000, deviceAdapter: adapter });
  const staleResponses = createInterface({ input: staleOutput })[Symbol.asyncIterator]();
  staleInput.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  await staleResponses.next();
  staleInput.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  staleInput.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'preview_info', arguments: {} } }) + '\n');
  const staleInfo = JSON.parse((await staleResponses.next()).value);
  assert.equal(JSON.parse(staleInfo.result.content[0].text).restored, false);
  staleInput.end();
  await staleRunning;
  assert.equal((await fetch(`${previewUrl}/health`)).status, 200, 'external preview server must outlive MCP');
  await previewServer.shutdown();
  await rm(stateDirectory, { recursive: true, force: true });
  output.end();
}
// A rename failure after the first frame must reject start, not wedge the stdio loop.
const failedDirectory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-save-failure-'));
const failedState = join(failedDirectory, 'preview-session.json');
let failSave = true;
const failureAdapter = { ...adapter, capture: async () => {
  if (failSave) await mkdir(failedState, { recursive: true });
  return adapter.capture();
} };
const failureServer = createPreviewServer({ deviceAdapter: failureAdapter });
await new Promise((resolve) => failureServer.listen(0, '127.0.0.1', resolve));
const failedInput = new PassThrough();
const failedOutput = new PassThrough();
const failedResponses = createInterface({ input: failedOutput })[Symbol.asyncIterator]();
const failedRunning = startMcp({ input: failedInput, output: failedOutput, deviceAdapter: failureAdapter,
  previewUrl: `http://127.0.0.1:${failureServer.address().port}`, previewStatePath: failedState, previewTimeoutMs: 500, projectPath: '', autoStartPreview: true });
let failureServerClosed = false;
// A regressed pending dispatch also blocks EOF cleanup, so bound the whole failure case.
const failureWatchdog = setTimeout(() => {
  console.error('MCP save-failure regression blocked request or shutdown');
  process.exit(1);
}, 10000);
failureWatchdog.unref();
let failureTimer;
const boundedRequest = async (id, method, params) => {
  failedInput.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  try {
    return await Promise.race([
      failedResponses.next().then(({ value }) => JSON.parse(value)),
      new Promise((_, reject) => { failureTimer = setTimeout(() => reject(new Error('MCP request hung after save failure')), 2000); })
    ]);
  } finally { clearTimeout(failureTimer); }
};
try {
  await boundedRequest(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  failedInput.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const failed = await boundedRequest(2, 'tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  assert.equal(failed.result.isError, true, 'state persistence failure must end preview_start');
  assert.equal(failed.result.structuredContent.errorCode, 'STATE_WRITE_FAILED');
  assert.equal(failed.result.structuredContent.stage, 'state_save');
  assert.equal(failed.result.structuredContent.deviceId, 'test-device');
  assert.equal(typeof failed.result.structuredContent.cause.code, 'string');
  assert.ok(failed.result.structuredContent.elapsedMs >= 0);
  assert.deepEqual((await boundedRequest(3, 'ping')).result, {}, 'later requests must still be processed');
  assert.deepEqual((await boundedRequest(4, 'tools/call', { name: 'list_devices' })).result.structuredContent.devices, ['test-device']);
  assert.deepEqual((await readdir(failedDirectory)).filter((name) => name.endsWith('.tmp')), [], 'failed state writes must clean their temporary files');
  const info = (await boundedRequest(5, 'tools/call', { name: 'preview_info' })).result.structuredContent;
  assert.equal(info.running, false);
  assert.equal(info.restored, false, 'failed writes must not publish an in-memory persisted session');
  failSave = false;
  await rm(failedState, { recursive: true });
  assert.equal((await boundedRequest(6, 'tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } })).result.isError, undefined, 'preview can start again after the storage problem is fixed');
  await boundedRequest(7, 'tools/call', { name: 'preview_stop' });
  await failureServer.shutdown();
  failureServerClosed = true;
  const unavailable = (await boundedRequest(8, 'tools/call', { name: 'preview_info', arguments: { deviceId: 'test-device' } })).result;
  assert.equal(unavailable.isError, undefined, 'an unavailable HTTP service must not hide the local runtime report');
  assert.deepEqual(unavailable.structuredContent.runtime, info.runtime);
  assert.equal(unavailable.structuredContent.serviceDiagnostic.errorCode, 'PREVIEW_UNAVAILABLE');
  assert.equal(unavailable.structuredContent.serviceDiagnostic.stage, 'preview_service');
  assert.equal(unavailable.structuredContent.deviceCheck.status, 'connected');
} finally {
  failedInput.end();
  await failedRunning;
  if (!failureServerClosed) await failureServer.shutdown();
  failedOutput.end();
  await rm(failedDirectory, { recursive: true, force: true });
  clearTimeout(failureWatchdog);
}
console.log('external preview: ok');
