import assert from 'node:assert/strict';
import { createFrameSource } from '../src/frame-source.mjs';

let now = 100;
const source = createFrameSource({
  deviceAdapter: {
    capture: async ({ deviceId }) => ({ deviceId, mimeType: 'image/jpeg', data: Buffer.from('jpeg') })
  },
  clock: () => now += 17,
  now: () => '2026-10-29T00:00:00.000Z'
});

assert.equal(source.name, 'jpeg');
assert.equal(source.supportsStreaming, false);
const sample = await source.capture({ deviceId: 'test-device' });
assert.deepEqual(sample.frame, { deviceId: 'test-device', mimeType: 'image/jpeg', data: Buffer.from('jpeg') });
assert.deepEqual(sample.metrics, {
  source: 'jpeg', mimeType: 'image/jpeg', frameBytes: 4, captureMs: 17, capturedAt: '2026-10-29T00:00:00.000Z'
});
console.log('frame source: ok');
