import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
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
const input = new PassThrough();
const output = new PassThrough();
const running = startMcp({ input, output, previewUrl, previewTimeoutMs: 500, deviceAdapter: adapter });

function request(id, method, params) {
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk) => {
      text += chunk.toString();
      const line = text.split('\n').find(Boolean);
      if (!line) return;
      output.off('data', onData);
      resolve(JSON.parse(line));
    };
    output.on('data', onData);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  const initialized = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const started = await request(2, 'tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  const session = JSON.parse(started.result.content[0].text);
  assert.equal(session.serverUrl, `${previewUrl}/`);
  assert.equal(session.wsUrl, `${previewUrl.replace('http:', 'ws:')}/preview`);
  assert.equal((await fetch(`${previewUrl}/health`)).status, 200);
} finally {
  input.end();
  await running;
  assert.equal((await fetch(`${previewUrl}/health`)).status, 200, 'external preview server must outlive MCP');
  await previewServer.shutdown();
  output.end();
}
console.log('external preview: ok');
