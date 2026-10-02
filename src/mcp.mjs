import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  { name: 'preview_stop', description: 'Stop live screenshot polling. An optional sessionId prevents stopping a newer session.', properties: { sessionId: { type: 'string', minLength: 1 } }, required: [] },
  { name: 'build_run', description: 'Build the configured project, install its HAP and launch it. Changes device state; requires user authorization.', properties: { deviceId: device }, required: ['deviceId'] },
  { name: 'preview_info', description: 'Return the local preview URL and current MCP preview session status.', properties: {}, required: [] }
].map(({ properties, required, ...tool }) => ({ ...tool, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));

const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const defaultPreviewStatePath = fileURLToPath(new URL('../.runtime/preview-session.json', import.meta.url));

export async function startMcp({ input = process.stdin, output = process.stdout, deviceAdapter = createDeviceAdapter(),
  projectPath = process.env.HARMONY_PROJECT, port = Number(process.env.HARMONY_PREVIEW_PORT ?? 0), previewTimeoutMs = 10000,
  previewUrl = process.env.HARMONY_PREVIEW_URL, previewStatePath = process.env.HARMONY_PREVIEW_STATE ?? defaultPreviewStatePath,
  previewStateTtlMs = Number(process.env.HARMONY_PREVIEW_STATE_TTL_MS ?? 86400000), autoStartPreview = process.env.HARMONY_PREVIEW_AUTOSTART === '1' } = {}) {
  const configuredPreviewUrl = previewUrl ? normalizePreviewUrl(previewUrl) : null;
  const ownsPreviewServer = !configuredPreviewUrl;
  const server = ownsPreviewServer ? createPreviewServer({ deviceAdapter }) : null;
  if (server) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const serverUrl = configuredPreviewUrl ?? `http://127.0.0.1:${server.address().port}/`;
  const wsUrl = serverUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + 'preview';
  let livePreview;
  await ensurePreviewService();
  let persistedPreview = ownsPreviewServer ? null : await readPreviewState(previewStatePath, previewStateTtlMs);
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
  } finally { lines.close(); await stopLivePreview(undefined, { clearPersisted: false }); if (server) await server.shutdown(); }

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
      if (tool.name === 'preview_info') { await ensurePreviewService(); return textResult({ ...previewInfo(), projectPath: projectPath ?? null }); }
      if (tool.name === 'tap') return textResult(await deviceAdapter.tap(args));
      if (tool.name === 'swipe') return textResult(await deviceAdapter.swipe(args));
      if (tool.name === 'long_press') return textResult(await deviceAdapter.longPress(args));
      if (tool.name === 'key_event') return textResult(await deviceAdapter.keyEvent(args));
      if (tool.name === 'input_text') return textResult(await deviceAdapter.inputText(args));
      if (tool.name === 'build_run') return textResult(await buildAndRun(deviceAdapter, { projectPath, deviceId: args.deviceId }));
      if (tool.name === 'preview_start') return textResult(await startLivePreview(args.deviceId));
      if (tool.name === 'preview_stop') return textResult(await stopLivePreview(args.sessionId));
      if (tool.name === 'capture' && livePreview?.deviceId === args.deviceId && livePreview.connected && livePreview.frame) {
        return imageResult(livePreview.frame, livePreview.mimeType, { deviceId: args.deviceId, live: true, sessionId: livePreview.sessionId });
      }
      const frame = await deviceAdapter.capture(args);
      return imageResult(frame.data, frame.mimeType, { deviceId: args.deviceId, live: false, sessionId: null });
    } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
  }

  async function startLivePreview(deviceId) {
    if (livePreview?.deviceId === deviceId && livePreview.frame) return previewInfo();
    await ensurePreviewService();
    await stopLivePreview();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const state = { socket, sessionId: randomUUID(), deviceId, frame: null, mimeType: 'image/jpeg', started: false, connected: false, settled: false, pollMs: null };
      livePreview = state;
      const timer = setTimeout(() => fail(new Error('Timed out waiting for the first preview frame; check device connection')), previewTimeoutMs);
      const fail = (error) => {
        if (state.settled) return;
        state.settled = true;
        clearTimeout(timer);
        if (livePreview === state) livePreview = undefined;
        socket.terminate();
        reject(error);
      };
      socket.on('open', () => socket.send(JSON.stringify({ type: 'preview-start', deviceId })));
      socket.on('error', fail);
      socket.on('close', () => {
        fail(new Error('Preview connection closed before the first frame'));
        if (livePreview === state) livePreview = undefined;
      });
      socket.on('message', async (message, isBinary) => {
        if (!isBinary) {
          let event;
          try { event = JSON.parse(message.toString()); } catch { return; }
          if (event.type === 'frame-meta') state.mimeType = event.mimeType;
          if (event.type === 'preview-status') {
            if (event.running) state.started = true;
            state.connected = event.running;
            if (event.pollMs) state.pollMs = event.pollMs;
          }
          if (event.type === 'error') fail(new Error(event.error));
          return;
        }
        if (!state.started) return;
        state.frame = Buffer.from(message);
        state.connected = true;
        if (!state.settled) {
          state.settled = true;
          clearTimeout(timer);
          try { await savePreviewState(state); resolve(previewInfo()); } catch (error) { fail(error); }
        }
      });
    });
  }

  async function stopLivePreview(sessionId, { clearPersisted = true } = {}) {
    const state = livePreview;
    const current = state ?? persistedPreview;
    if (sessionId && current && sessionId !== current.sessionId) throw new Error('Preview sessionId does not match the active session');
    livePreview = undefined;
    if (clearPersisted && !ownsPreviewServer) {
      persistedPreview = null;
      await clearPreviewState(previewStatePath);
    }
    if (!state?.socket) return current ? { running: false, deviceId: current.deviceId, sessionId: current.sessionId } : { running: false };
    if (state.socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((resolve) => state.socket.once('close', resolve));
      state.socket.terminate();
      await closed;
    }
    return { running: false, deviceId: state.deviceId, sessionId: state.sessionId };
  }

  function previewInfo() {
    const saved = !livePreview && !ownsPreviewServer ? persistedPreview : null;
    const active = livePreview ?? saved;
    const previewUrl = `${serverUrl}${active?.deviceId ? `?deviceId=${encodeURIComponent(active.deviceId)}` : ''}`;
    return { previewUrl, serverUrl, wsUrl, running: Boolean(active), connected: livePreview?.connected ?? false,
      restored: Boolean(saved), sessionId: active?.sessionId ?? null, deviceId: active?.deviceId ?? null, pollMs: livePreview?.pollMs ?? active?.pollMs ?? null,
      capabilities: tools.map((tool) => tool.name) };
  }

  async function savePreviewState(state) {
    if (ownsPreviewServer) return;
    persistedPreview = { sessionId: state.sessionId, deviceId: state.deviceId, serverUrl, wsUrl, pollMs: state.pollMs, lastSeen: Date.now() };
    await writePreviewState(previewStatePath, persistedPreview);
  }

  async function ensurePreviewService() {
    if (ownsPreviewServer || !autoStartPreview || await previewHealthy()) return;
    if (!projectPath) throw new Error('HARMONY_PROJECT is required to restart the preview service');
    const preview = new URL(serverUrl);
    const entry = fileURLToPath(new URL('../bin/harmonyos-preview.mjs', import.meta.url));
    const child = spawn(process.execPath, [entry, '--project', projectPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, HARMONY_PROJECT: projectPath, HARMONY_PREVIEW_PORT: preview.port || '4100' }
    });
    child.unref();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await previewHealthy()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Preview service did not start at ${serverUrl}`);
  }

  async function previewHealthy() {
    try { return (await fetch(`${serverUrl}health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }
}

async function readPreviewState(path, ttlMs) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (Number.isFinite(ttlMs) && ttlMs >= 0 && Number.isFinite(value.lastSeen) && Date.now() - value.lastSeen > ttlMs) {
      await clearPreviewState(path);
      return null;
    }
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writePreviewState(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', 'utf8');
  await rename(temporary, path);
}

async function clearPreviewState(path) {
  try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function normalizePreviewUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('HARMONY_PREVIEW_URL must point to a local HTTP service');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function imageResult(data, mimeType, structuredContent) {
  return { content: [{ type: 'image', mimeType, data: data.toString('base64') }], structuredContent };
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
