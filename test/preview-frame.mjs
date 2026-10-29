import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { startMcp } from '../src/mcp.mjs';

const input = new PassThrough();
const output = new PassThrough();
const responses = createInterface({ input: output })[Symbol.asyncIterator]();
let id = 0;
let captures = 0;
let taps = 0;
const running = startMcp({
  input, output, port: 0, projectPath: '', frameLeaseMs: 50,
  deviceAdapter: {
    listTargets: async () => ['test-device'],
    capture: async () => { captures += 1; return { mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, captures]) }; },
    tap: async (args) => { taps += 1; return args; },
    swipe: async (args) => args,
    observe: async () => ({ nodes: [], totalNodes: 0, truncated: false }),
    find: async () => ({ matches: [], totalMatches: 0, truncated: false }),
    waitFor: async () => ({ status: 'matched', attempts: 1, elapsedMs: 1, lastObservation: null }),
    longPress: async (args) => args,
    keyEvent: async (args) => args,
    inputText: async (args) => args,
  }
});

async function request(method, params) {
  input.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  const line = await responses.next();
  const reply = JSON.parse(line.value);
  assert.equal(reply.id, id);
  return reply;
}

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'preview-frame-test', version: '1' } });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const started = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  const session = JSON.parse(started.result.content[0].text);
  const first = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } });
  const firstData = first.result.structuredContent;
  assert.equal(first.result.content.length, 0);
  assert.equal(firstData.connected, true);
  assert.ok(firstData.frame);
  const duplicate = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: firstData.seq } });
  assert.equal(duplicate.result.structuredContent.frame, null);
  const waitedAt = performance.now();
  const waited = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: firstData.seq, waitMs: 600 } });
  assert.ok(waited.result.structuredContent.frame, 'waitMs should resolve on the next live frame');
  assert.ok(waited.result.structuredContent.seq > firstData.seq);
  assert.ok(performance.now() - waitedAt < 650, 'frame wait should resolve within its bound');
  const latestSeq = waited.result.structuredContent.seq;
  const stale = await request('tools/call', { name: 'preview_action', arguments: { action: 'tap', seq: 0, x: 1, y: 1 } });
  assert.equal(stale.result.isError, true);
  assert.equal(stale.result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  assert.equal(taps, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const paused = (await request('tools/call', { name: 'preview_info' })).result.structuredContent;
  assert.equal(paused.paused, true);
  assert.equal(paused.sessionId, session.sessionId);
  let resumed;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: latestSeq, waitMs: 600 } });
    resumed = next.result.structuredContent;
    if (resumed.frame) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(resumed.frame, 'frame lease should resume on demand');
  assert.equal(resumed.connected, true);
  assert.equal(resumed.sessionId, session.sessionId);
  assert.ok(resumed.seq > firstData.seq);
  await request('tools/call', { name: 'preview_stop', arguments: { sessionId: session.sessionId } });
  console.log('preview frame: ok');
} finally {
  input.end();
  await running;
}
