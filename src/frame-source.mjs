/**
 * The preview server consumes this small contract so a future MJPEG/H.264
 * source can replace the JPEG sampler without changing session handling.
 */
export function createFrameSource({ deviceAdapter, clock = () => performance.now(), now = () => new Date().toISOString() } = {}) {
  const previewSizes = new Map();
  const deviceSizes = new Map();
  return {
    name: 'jpeg',
    supportsStreaming: false,
    async capture({ deviceId, signal } = {}) {
      if (!deviceAdapter || typeof deviceAdapter.capture !== 'function') throw new TypeError('deviceAdapter.capture is required');
      const startedAt = clock();
      const size = previewSizes.get(deviceId);
      const frame = await deviceAdapter.capture({ deviceId, ...(size ?? {}) }, { signal });
      const dimensions = readJpegSize(frame.data);
      if (!deviceSizes.has(deviceId) && dimensions) deviceSizes.set(deviceId, dimensions);
      if (!size && dimensions) previewSizes.set(deviceId, {
        width: Math.max(1, Math.round(dimensions.width / 2)),
        height: Math.max(1, Math.round(dimensions.height / 2))
      });
      const deviceSize = deviceSizes.get(deviceId) ?? dimensions;
      return {
        frame,
        metrics: {
          source: 'jpeg',
          mimeType: frame.mimeType,
          frameBytes: Buffer.isBuffer(frame.data) ? frame.data.byteLength : 0,
          ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
          ...(deviceSize ? { deviceWidth: deviceSize.width, deviceHeight: deviceSize.height } : {}),
          ...(size ? { scaled: true, requestedWidth: size.width, requestedHeight: size.height } : { scaled: false }),
          captureMs: Math.max(0, Math.round(clock() - startedAt)),
          capturedAt: frame.capturedAt ?? now()
        }
      };
    }
  };
}

function readJpegSize(data) {
  if (!Buffer.isBuffer(data) || data.length < 10 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  for (let offset = 2; offset + 9 < data.length;) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
    if (offset + 4 > data.length) return null;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}
