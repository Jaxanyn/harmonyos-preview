import { createInterface } from 'node:readline';
import { createDeviceAdapter } from './device.mjs';
import { createPreviewServer } from './server.mjs';
import { buildAndRun } from './build.mjs';

const device = { type: 'string', minLength: 1, description: 'Device ID from list_devices' };
const tools = [
  { name: 'list_devices', description: 'List connected HarmonyOS devices and emulators.', properties: {}, required: [] },
  { name: 'capture', description: 'Return the selected device screenshot as an MCP image.', properties: { deviceId: device }, required: ['deviceId'] },
  { name: 'tap', description: 'Click the device at screenshot pixel coordinates. Changes device UI state.', properties: { deviceId: device, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, required: ['deviceId', 'x', 'y'] },
  { name: 'build_run', description: 'Build the configured project, install its HAP and launch it. Changes device state; requires user authorization.', properties: { deviceId: device }, required: ['deviceId'] },
  { name: 'preview_info', description: 'Return the local preview URL. Open it in the agent browser, select a device and start preview.', properties: {}, required: [] }
].map(({ properties, required, ...tool }) => ({ ...tool, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));

const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function startMcp({ input = process.stdin, output = process.stdout, deviceAdapter = createDeviceAdapter(),
  projectPath = process.env.HARMONY_PROJECT, port = Number(process.env.HARMONY_PREVIEW_PORT ?? 0) } = {}) {
  const server = createPreviewServer({ deviceAdapter });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const previewUrl = `http://127.0.0.1:${server.address().port}/`;
  const lines = createInterface({ input, crlfDelay: Infinity });
  let state = 'new';
  try {
    // ponytail: serial tool calls for one-device prototype; add cancellation/concurrency with the MCP SDK when needed.
    for await (const line of lines) {
      let request;
      let response;
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Message too large');
        request = JSON.parse(line);
      } catch { response = rpcError(null, -32700, 'Parse error or message too large'); }
      if (!response) {
        const valid = request && !Array.isArray(request) && request.jsonrpc === '2.0' && typeof request.method === 'string'
          && (!Object.hasOwn(request, 'id') || typeof request.id === 'string' || Number.isInteger(request.id));
        if (!valid) response = rpcError(null, -32600, 'Invalid Request');
        else if (!Object.hasOwn(request, 'id')) {
          if (request.method === 'notifications/initialized' && state === 'initializing') state = 'ready';
          continue;
        } else {
          try { response = { jsonrpc: '2.0', id: request.id, result: await dispatch(request) }; }
          catch (error) { response = rpcError(request.id, error.rpcCode ?? -32603, error.message); }
        }
      }
      await new Promise((resolve, reject) => output.write(JSON.stringify(response) + '\n', (error) => error ? reject(error) : resolve()));
    }
  } finally { lines.close(); await server.shutdown(); }

  async function dispatch({ method, params }) {
    if (method === 'ping') return {};
    if (method === 'initialize') {
      if (state !== 'new') throw Object.assign(new Error('Already initialized'), { rpcCode: -32600 });
      if (!params || typeof params.protocolVersion !== 'string' || !params.clientInfo || !params.capabilities) {
        throw Object.assign(new Error('Invalid initialize params'), { rpcCode: -32602 });
      }
      state = 'initializing';
      const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
      return { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions.at(-1),
        capabilities: { tools: {} }, serverInfo: { name: 'harmonyos-preview', version: '0.1.0' } };
    }
    if (state !== 'ready') throw Object.assign(new Error('Initialize the session first'), { rpcCode: -32600 });
    if (method === 'tools/list') return { tools };
    if (method !== 'tools/call') throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
    const tool = tools.find((item) => item.name === params?.name);
    if (!tool) throw Object.assign(new Error('Unknown tool'), { rpcCode: -32602 });
    const args = params.arguments ?? {};
    validateArguments(tool.inputSchema, args);
    try {
      if (tool.name === 'list_devices') return textResult({ devices: await deviceAdapter.listTargets() });
      if (tool.name === 'preview_info') return textResult({ previewUrl, projectPath: projectPath ?? null });
      if (tool.name === 'tap') return textResult(await deviceAdapter.tap(args));
      if (tool.name === 'build_run') return textResult(await buildAndRun(deviceAdapter, { projectPath, deviceId: args.deviceId }));
      const frame = await deviceAdapter.capture(args);
      return { content: [{ type: 'image', mimeType: frame.mimeType, data: frame.data.toString('base64') }] };
    } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
  }
}

function validateArguments(schema, args) {
  const fail = () => { throw Object.assign(new Error('Invalid tool arguments'), { rpcCode: -32602 }); };
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail();
  if (schema.required.some((key) => !Object.hasOwn(args, key))) fail();
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property || typeof value !== property.type) fail();
    if (property.type === 'string' && !value.trim()) fail();
    if (property.type === 'number' && (!Number.isFinite(value) || value < property.minimum)) fail();
  }
}
