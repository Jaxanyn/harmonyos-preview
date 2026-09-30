import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { createDeviceAdapter } from './device.mjs';
import { createPreviewServer } from './server.mjs';
import { buildAndRun } from './build.mjs';

const device = { type: 'string', minLength: 1, description: 'Device ID from list_devices' };
const tools = [
  { name: 'list_devices', description: 'List connected HarmonyOS devices and emulators.', properties: {}, required: [] },
  { name: 'capture', description: 'Return the selected device screenshot as an MCP image.', properties: { deviceId: device }, required: ['deviceId'] },
  { name: 'tap', description: 'Click the device at screenshot pixel coordinates. Changes device UI state.', properties: { deviceId: device, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, required: ['deviceId', 'x', 'y'] },
  { name: 'swipe', description: 'Swipe between two screenshot pixel coordinates. Changes device UI state.', properties: { deviceId: device, fromX: { type: 'number', minimum: 0 }, fromY: { type: 'number', minimum: 0 }, toX: { type: 'number', minimum: 0 }, toY: { type: 'number', minimum: 0 }, velocity: { type: 'number', minimum: 200, maximum: 40000 } }, required: ['deviceId', 'fromX', 'fromY', 'toX', 'toY'] },
  { name: 'long_press', description: 'Long press a screenshot pixel coordinate. Changes device UI state.', properties: { deviceId: device, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, required: ['deviceId', 'x', 'y'] },
  { name: 'key_event', description: 'Send Back, Home or Power to the device. Changes device UI state.', properties: { deviceId: device, key: { type: 'string', enum: ['Back', 'Home', 'Power'] } }, required: ['deviceId'] },
  { name: 'input_text', description: 'Input text at the focused field or a coordinate. Changes device UI state.', properties: { deviceId: device, text: { type: 'string', minLength: 1 }, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, required: ['deviceId', 'text'] },
  { name: 'preview_start', description: 'Start live screenshot polling and return the preview URL.', properties: { deviceId: device }, required: ['deviceId'] },
  { name: 'preview_stop', description: 'Stop live screenshot polling.', properties: {}, required: [] },
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
  let livePreview;
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
  } finally { lines.close(); await stopLivePreview(); await server.shutdown(); }

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
      if (tool.name === 'swipe') return textResult(await deviceAdapter.swipe(args));
      if (tool.name === 'long_press') return textResult(await deviceAdapter.longPress(args));
      if (tool.name === 'key_event') return textResult(await deviceAdapter.keyEvent(args));
      if (tool.name === 'input_text') return textResult(await deviceAdapter.inputText(args));
      if (tool.name === 'build_run') return textResult(await buildAndRun(deviceAdapter, { projectPath, deviceId: args.deviceId }));
      if (tool.name === 'preview_start') return textResult(await startLivePreview(args.deviceId));
      if (tool.name === 'preview_stop') return textResult(await stopLivePreview());
      if (tool.name === 'capture' && livePreview?.deviceId === args.deviceId && livePreview.frame) {
        return { content: [{ type: 'image', mimeType: livePreview.mimeType, data: livePreview.frame.toString('base64') }] };
      }
      const frame = await deviceAdapter.capture(args);
      return { content: [{ type: 'image', mimeType: frame.mimeType, data: frame.data.toString('base64') }] };
    } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
  }

  function startLivePreview(deviceId) {
    return new Promise((resolve, reject) => {
      stopLivePreview();
      const socket = new WebSocket(previewUrl.replace('http:', 'ws:') + 'preview');
      const state = { socket, deviceId, frame: null, mimeType: 'image/jpeg', started: false, settled: false };
      livePreview = state;
      const fail = (error) => { if (!state.settled) { state.settled = true; reject(error); } };
      socket.on('open', () => socket.send(JSON.stringify({ type: 'preview-start', deviceId })));
      socket.on('error', fail);
      socket.on('close', () => { if (livePreview === state) livePreview = undefined; });
      socket.on('message', (message) => {
        if (typeof message === 'string' || Buffer.isBuffer(message) && message[0] !== 0xff) {
          let event;
          try { event = JSON.parse(message.toString()); } catch { return; }
          if (event.type === 'frame-meta') state.mimeType = event.mimeType;
          if (event.type === 'preview-status' && event.running) state.started = true;
          if (event.type === 'error') fail(new Error(event.error));
          return;
        }
        if (!state.started) return;
        state.frame = Buffer.from(message);
        if (!state.settled) { state.settled = true; resolve({ deviceId, previewUrl, pollMs: eventPollMs() }); }
      });
    });
  }

  async function stopLivePreview() {
    const state = livePreview;
    livePreview = undefined;
    if (!state?.socket) return { running: false };
    if (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING) state.socket.close();
    return { running: false, deviceId: state.deviceId };
  }

  function eventPollMs() { return Number(process.env.HARMONY_PREVIEW_POLL_MS ?? 500); }
}

function validateArguments(schema, args) {
  const fail = () => { throw Object.assign(new Error('Invalid tool arguments'), { rpcCode: -32602 }); };
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail();
  if (schema.required.some((key) => !Object.hasOwn(args, key))) fail();
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property || typeof value !== property.type) fail();
    if (property.type === 'string' && (!value.trim() || value.length < (property.minLength ?? 0) || property.enum && !property.enum.includes(value))) fail();
    if (property.type === 'number' && (!Number.isFinite(value) || value < property.minimum || value > (property.maximum ?? Infinity))) fail();
  }
}
