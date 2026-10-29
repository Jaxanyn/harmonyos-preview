import assert from 'node:assert/strict';
import { createFrameSource } from '../src/frame-source.mjs';

let now = 100;
let captureOptions;
let captureArgs;
const jpeg = (width, height) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
  height >> 8, height & 0xff, width >> 8, width & 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00]);
const source = createFrameSource({
  deviceAdapter: {
    capture: async ({ deviceId, width, height }, options) => {
      captureArgs = { deviceId, ...(width === undefined ? {} : { width, height }) };
      captureOptions = options;
      return { deviceId, mimeType: 'image/jpeg', data: jpeg(width ?? 10, height ?? 20) };
    }
  },
  clock: () => now += 17,
  now: () => '2026-10-29T00:00:00.000Z'
});

assert.equal(source.name, 'jpeg');
assert.equal(source.supportsStreaming, false);
const signal = new AbortController().signal;
const sample = await source.capture({ deviceId: 'test-device', signal });
assert.equal(captureOptions.signal, signal);
assert.deepEqual(captureArgs, { deviceId: 'test-device' });
assert.deepEqual(sample.frame, { deviceId: 'test-device', mimeType: 'image/jpeg', data: jpeg(10, 20) });
assert.deepEqual(sample.metrics, {
  source: 'jpeg', mimeType: 'image/jpeg', frameBytes: 21, width: 10, height: 20, deviceWidth: 10, deviceHeight: 20,
  scaled: false, captureMs: 17, capturedAt: '2026-10-29T00:00:00.000Z'
});
const scaled = await source.capture({ deviceId: 'test-device' });
assert.deepEqual(captureArgs, { deviceId: 'test-device', width: 5, height: 10 });
assert.equal(scaled.metrics.scaled, true);
assert.equal(scaled.metrics.requestedWidth, 5);
assert.equal(scaled.metrics.requestedHeight, 10);
assert.equal(scaled.metrics.deviceWidth, 10);
assert.equal(scaled.metrics.deviceHeight, 20);
console.log('frame source: ok');
