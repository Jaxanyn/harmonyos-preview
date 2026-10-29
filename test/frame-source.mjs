import assert from 'node:assert/strict';
import { createFrameSource } from '../src/frame-source.mjs';

let now = 100;
let captureOptions;
const source = createFrameSource({
  deviceAdapter: {
    capture: async ({ deviceId }, options) => { captureOptions = options; return { deviceId, mimeType: 'image/jpeg', data: Buffer.from('jpeg') }; }
  },
  clock: () => now += 17,
  now: () => '2026-10-29T00:00:00.000Z'
});

assert.equal(source.name, 'jpeg');
assert.equal(source.supportsStreaming, false);
const signal = new AbortController().signal;
const sample = await source.capture({ deviceId: 'test-device', signal });
assert.equal(captureOptions.signal, signal);
assert.deepEqual(sample.frame, { deviceId: 'test-device', mimeType: 'image/jpeg', data: Buffer.from('jpeg') });
assert.deepEqual(sample.metrics, {
  source: 'jpeg', mimeType: 'image/jpeg', frameBytes: 4, captureMs: 17, capturedAt: '2026-10-29T00:00:00.000Z'
});
console.log('frame source: ok');
