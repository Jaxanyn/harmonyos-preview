/**
 * The preview server consumes this small contract so a future MJPEG/H.264
 * source can replace the JPEG sampler without changing session handling.
 */
export function createFrameSource({ deviceAdapter, clock = () => performance.now(), now = () => new Date().toISOString() } = {}) {
  return {
    name: 'jpeg',
    supportsStreaming: false,
    async capture({ deviceId, signal } = {}) {
      if (!deviceAdapter || typeof deviceAdapter.capture !== 'function') throw new TypeError('deviceAdapter.capture is required');
      const startedAt = clock();
      const frame = await deviceAdapter.capture({ deviceId }, { signal });
      return {
        frame,
        metrics: {
          source: 'jpeg',
          mimeType: frame.mimeType,
          frameBytes: Buffer.isBuffer(frame.data) ? frame.data.byteLength : 0,
          captureMs: Math.max(0, Math.round(clock() - startedAt)),
          capturedAt: frame.capturedAt ?? now()
        }
      };
    }
  };
}
