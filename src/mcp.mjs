import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { OpenAIUiResourceMetadataSchema, OpenAIUiToolMetadataSchema } from '@openai/mcp-extensions/server';
import { createDeviceAdapter } from './device.mjs';
import { createPreviewServer } from './server.mjs';
import { buildAndRun } from './build.mjs';
import { serverVersion, diagnosticsVersion, tagError, toDiagnostic } from './diagnostics.mjs';

const device = { type: 'string', minLength: 1, description: 'Device ID from list_devices' };
const selector = {
  type: 'object', minProperties: 1, additionalProperties: false,
  properties: {
    text: { type: 'string', minLength: 1 }, textContains: { type: 'string', minLength: 1 },
    id: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 },
    clickable: { type: 'boolean' }, enabled: { type: 'boolean' }
  }, required: []
};
const bundleName = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+$', description: 'Optional target application bundle name.' };
const buildModuleName = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$', description: 'Optional HarmonyOS module directory. Defaults to entry.' };
const buildArtifactName = { type: 'string', minLength: 5, maxLength: 255, pattern: '^[A-Za-z0-9._-]+\\.hap$', description: 'Optional HAP file name when a module produces multiple artifacts.' };
const appResourceUri = 'ui://harmonyos-preview/app';
const appResourcePath = fileURLToPath(new URL('./app/resource.html', import.meta.url));
const appToolUiMetadata = { entrypoints: [{ type: 'global' }] };
const panelToolUiMetadata = { entrypoints: [{ type: 'thread' }] };
const appResourceUiMetadata = { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen', 'inline'] };
OpenAIUiToolMetadataSchema.parse(appToolUiMetadata);
OpenAIUiToolMetadataSchema.parse(panelToolUiMetadata);
OpenAIUiResourceMetadataSchema.parse(appResourceUiMetadata);
const tools = [
  { name: 'list_devices', description: 'List connected HarmonyOS devices and emulators.', properties: {}, required: [] },
  { name: 'capture', description: 'Capture a fresh device image. Never returns a cached preview frame; asynchronous page transitions may still require another observation.', properties: { deviceId: device }, required: ['deviceId'] },
  { name: 'observe', description: 'Read the current UITest component tree. Exposed nodes may omit custom-rendered content; truncated or empty trees do not prove absence. Falls back to a fresh screenshot on empty or unavailable layout.', properties: { deviceId: device, bundleName, maxNodes: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['deviceId'] },
  { name: 'find', description: 'Find current components by exact text, ID, type or textContains and optional state filters (AND). Returns all candidates up to limit without clicking. No matches triggers a fresh screenshot; do not infer absence from an incomplete tree.', properties: { deviceId: device, bundleName, selector, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['deviceId', 'selector'] },
  { name: 'wait_for', description: 'Wait for a selector to be present or absent in the exposed UI hierarchy; use id and text together to wait for expected text. Absence requires a nonempty full hierarchy and does not prove business success. Returns matched, timeout or observation_failed with the last observation. Failures try a fresh screenshot with a 3s budget; HDC cleanup can add up to 2s each for the final observation and screenshot.', properties: { deviceId: device, bundleName, selector, state: { type: 'string', enum: ['present', 'absent'] }, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000, description: 'Polling budget in milliseconds; default 5000.' }, intervalMs: { type: 'integer', minimum: 100, maximum: 5000, description: 'Delay between completed observations in milliseconds; default 500.' } }, required: ['deviceId', 'selector'] },
  { name: 'tap', description: 'Click the device at screenshot pixel coordinates. Changes device UI state.', properties: { deviceId: device, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, required: ['deviceId', 'x', 'y'] },
  { name: 'tap_element', description: 'Find and tap exactly one current control using the same AND selector as find. Requires a clickable control that is not explicitly disabled or hidden, valid bounds/center, and an observation no older than 1s. Refuses missing, ambiguous, invalid or stale targets without tapping. Executes at most one tap, with no retries. Changes device UI state and requires user authorization. Success returns verified:false; use wait_for and capture to verify the expected result. UI changes can still race the tap; never repeat a failed action automatically.', properties: { deviceId: device, bundleName, selector }, required: ['deviceId', 'selector'] },
  { name: 'swipe', description: 'Swipe between two screenshot pixel coordinates. Changes device UI state.', properties: { deviceId: device, fromX: { type: 'number', minimum: 0 }, fromY: { type: 'number', minimum: 0 }, toX: { type: 'number', minimum: 0 }, toY: { type: 'number', minimum: 0 }, velocity: { type: 'number', minimum: 200, maximum: 40000 } }, required: ['deviceId', 'fromX', 'fromY', 'toX', 'toY'] },
  { name: 'long_press', description: 'Long press a screenshot pixel coordinate. Changes device UI state.', properties: { deviceId: device, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, required: ['deviceId', 'x', 'y'] },
  { name: 'key_event', description: 'Send Back, Home or Power to the device. Changes device UI state.', properties: { deviceId: device, key: { type: 'string', enum: ['Back', 'Home', 'Power'] } }, required: ['deviceId'] },
  { name: 'input_text', description: 'Input text at the focused field or a coordinate. Changes device UI state.', properties: { deviceId: device, text: { type: 'string', minLength: 1 }, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, required: ['deviceId', 'text'] },
  {
    name: 'preview_frame',
    description: 'Return the newest in-memory live preview frame for the MCP App. App-only; use afterSeq to avoid rendering the same frame twice. Optionally wait for the next frame after an interaction.',
    properties: {
      afterSeq: { type: 'integer', minimum: 0 },
      waitMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'Optional wait for a frame newer than afterSeq.' }
    }, required: [],
    _meta: { ui: { visibility: ['app'] } }
  },
  {
    name: 'preview_action',
    description: 'Execute one pointer action from the MCP App against the current live preview frame. App-only and rejected when the frame sequence is stale.',
    properties: {
      action: { type: 'string', enum: ['tap', 'swipe'] },
      seq: { type: 'integer', minimum: 0 },
      x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
      toX: { type: 'number', minimum: 0 }, toY: { type: 'number', minimum: 0 }
    }, required: ['action', 'seq'],
    _meta: { ui: { visibility: ['app'] } }
  },
  { name: 'preview_start', description: 'Start live screenshot polling and return the preview URL.', properties: { deviceId: device }, required: ['deviceId'] },
  { name: 'preview_stop', description: 'Stop live screenshot polling. An optional sessionId prevents stopping a newer session.', properties: { sessionId: { type: 'string', minLength: 1 } }, required: [] },
  { name: 'build_run', description: 'Build the configured project, install one selected module HAP and launch it. Defaults to entry; specify artifactName when the module produces multiple HAP artifacts. Changes device state; requires user authorization.', properties: { deviceId: device, moduleName: buildModuleName, artifactName: buildArtifactName }, required: ['deviceId'] },
  { name: 'preview_info', description: 'Return preview status, loaded capabilities and runtime identity. Optional deviceId checks HDC availability without starting preview. connected describes live preview frames, not device connectivity; this service cannot verify or refresh the host tool cache.', properties: { deviceId: device }, required: [] },
  {
    name: 'preview_open', title: 'HarmonyOS Preview',
    description: 'Open the HarmonyOS Preview app. The app can select a device and control its live preview.',
    properties: {}, required: [],
    _meta: {
      ui: { resourceUri: appResourceUri, visibility: ['app'] },
      'openai/ui': appToolUiMetadata
    }
  },
  {
    name: 'preview_panel', title: '鸿蒙真机预览',
    description: 'Open the HarmonyOS live device preview beside the current conversation in its right side panel.',
    properties: {}, required: [],
    _meta: {
      ui: { resourceUri: appResourceUri, visibility: ['model', 'app'] },
      'openai/ui': panelToolUiMetadata
    }
  }
].map(({ properties, required, ...tool }) => ({ ...tool, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));

const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const defaultPreviewStatePath = fileURLToPath(new URL('../.runtime/preview-session.json', import.meta.url));

export async function startMcp({ input = process.stdin, output = process.stdout, deviceAdapter = createDeviceAdapter(),
  projectPath = process.env.HARMONY_PROJECT, port = Number(process.env.HARMONY_PREVIEW_PORT ?? 0), previewTimeoutMs = 10000,
  previewUrl = process.env.HARMONY_PREVIEW_URL, previewStatePath = process.env.HARMONY_PREVIEW_STATE ?? defaultPreviewStatePath,
  previewStateTtlMs = Number(process.env.HARMONY_PREVIEW_STATE_TTL_MS ?? 86400000),
  frameLeaseMs = 5000, autoStartPreview = process.env.HARMONY_PREVIEW_AUTOSTART === '1' } = {}) {
  const configuredPreviewUrl = previewUrl ? normalizePreviewUrl(previewUrl) : null;
  const runtime = { serverVersion, diagnosticsVersion, startedAt: new Date().toISOString(), instanceId: randomUUID() };
  const ownsPreviewServer = !configuredPreviewUrl;
  const server = ownsPreviewServer ? createPreviewServer({ deviceAdapter }) : null;
  if (server) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const serverUrl = configuredPreviewUrl ?? `http://127.0.0.1:${server.address().port}/`;
  const wsUrl = serverUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + 'preview';
  frameLeaseMs = Number.isFinite(frameLeaseMs) && frameLeaseMs > 0 ? frameLeaseMs : 5000;
  let livePreview;
  await ensurePreviewService();
  let persistedPreview = ownsPreviewServer ? null : await readPreviewState(previewStatePath, previewStateTtlMs);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let state = 'new';
  const inFlight = new Map();
  const pending = new Set();
  const deviceTails = new Map();
  let writes = Promise.resolve();
  try {
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
          if (request.method === 'notifications/cancelled' || request.method === '$/cancelRequest') {
            const requestId = request.params?.requestId ?? request.params?.id;
            const controller = inFlight.get(requestId);
            controller?.abort(new Error(request.params?.reason || 'Request cancelled'));
            continue;
          }
          if (request.method === 'notifications/initialized' && state === 'initializing') state = 'ready';
          continue;
        } else {
          const controller = new AbortController();
          inFlight.set(request.id, controller);
          const task = (async () => {
            let result;
            try {
              result = { jsonrpc: '2.0', id: request.id, result: await dispatch(request, { signal: controller.signal }) };
            } catch (error) {
              result = controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
                ? rpcError(request.id, -32800, 'Request cancelled')
                : rpcError(request.id, error.rpcCode ?? -32603, error.message);
            } finally {
              if (inFlight.get(request.id) === controller) inFlight.delete(request.id);
            }
            writes = writes.then(() => writeResponse(result));
            await writes;
          })();
          pending.add(task);
          task.finally(() => pending.delete(task)).catch(() => {});
          continue;
        }
      }
      writes = writes.then(() => writeResponse(response));
      await writes;
    }
  } finally {
    lines.close();
    for (const controller of inFlight.values()) controller.abort(new Error('MCP connection closed'));
    await Promise.allSettled([...pending]);
    await writes;
    await stopLivePreview(undefined, { clearPersisted: false });
    if (server) await server.shutdown();
  }

  async function writeResponse(response) {
    if (output.writableEnded || output.destroyed) return;
    await new Promise((resolve, reject) => output.write(JSON.stringify(response) + '\n', (error) => error ? reject(error) : resolve()));
  }

  async function withDeviceLock(deviceId, signal, operation) {
    if (!deviceId) return operation();
    const previous = deviceTails.get(deviceId) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => turn);
    deviceTails.set(deviceId, tail);
    try {
      await waitForTurn(previous, signal);
      if (signal?.aborted) throw cancellationError();
      return await operation();
    } finally {
      release();
      if (deviceTails.get(deviceId) === tail) deviceTails.delete(deviceId);
    }
  }

  function waitForTurn(previous, signal) {
    if (signal?.aborted) return Promise.reject(cancellationError());
    if (!signal) return previous;
    return Promise.race([previous, new Promise((_, reject) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(cancellationError()); };
      signal.addEventListener('abort', onAbort, { once: true });
      previous.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
    })]);
  }

  async function dispatch({ method, params }, { signal } = {}) {
    if (signal?.aborted) throw cancellationError();
    if (method === 'ping') return {};
    if (method === 'initialize') {
      if (state !== 'new') throw Object.assign(new Error('Already initialized'), { rpcCode: -32600 });
      if (!params || typeof params.protocolVersion !== 'string' || !params.clientInfo || !params.capabilities) {
        throw Object.assign(new Error('Invalid initialize params'), { rpcCode: -32602 });
      }
      state = 'initializing';
      const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
      return { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions.at(-1),
        capabilities: { tools: {}, resources: { read: true } }, serverInfo: { name: 'harmonyos-preview', version: serverVersion } };
    }
    if (state !== 'ready') throw Object.assign(new Error('Initialize the session first'), { rpcCode: -32600 });
    if (method === 'tools/list') return { tools };
    if (method === 'resources/read') {
      if (params?.uri !== appResourceUri) throw Object.assign(new Error('Unknown resource'), { rpcCode: -32602 });
      return {
        contents: [{
          uri: appResourceUri,
          mimeType: 'text/html;profile=mcp-app',
          text: await readFile(appResourcePath, 'utf8'),
          _meta: { 'openai/ui': appResourceUiMetadata }
        }]
      };
    }
    if (method !== 'tools/call') throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
    const tool = tools.find((item) => item.name === params?.name);
    if (!tool) throw Object.assign(new Error('Unknown tool'), { rpcCode: -32602 });
    const args = params.arguments ?? {};
    validateArguments(tool.inputSchema, args);
    const startedAt = performance.now();
    try {
      if (tool.name === 'preview_open' || tool.name === 'preview_panel') return { content: [], structuredContent: { app: 'harmonyos-preview' } };
      if (tool.name === 'list_devices') return textResult({ devices: await deviceAdapter.listTargets({ signal }) });
      if (tool.name === 'preview_info') {
        const info = { ...previewInfo(), projectPath: projectPath ?? null };
        try { await ensurePreviewService(); }
        catch (error) {
          if (signal?.aborted) throw cancellationError();
          info.serviceDiagnostic = toDiagnostic(error,
            { errorCode: 'PREVIEW_UNAVAILABLE', stage: 'preview_service', deviceId: args.deviceId, elapsedMs: performance.now() - startedAt });
        }
        if (args.deviceId) {
          const checkedAt = new Date().toISOString();
          try {
            const devices = await deviceAdapter.listTargets({ signal });
            info.deviceCheck = devices.includes(args.deviceId)
              ? { status: 'connected', deviceId: args.deviceId, devices, checkedAt, elapsedMs: Math.round(performance.now() - startedAt) }
              : { status: 'disconnected', devices, checkedAt, ...toDiagnostic(new Error('Device is not connected: ' + args.deviceId),
                { errorCode: 'DEVICE_OFFLINE', stage: 'device_check', deviceId: args.deviceId, elapsedMs: performance.now() - startedAt }) };
          } catch (error) {
            if (signal?.aborted) throw cancellationError();
            info.deviceCheck = { status: 'error', checkedAt, ...toDiagnostic(error,
              { errorCode: 'HDC_FAILED', stage: 'device_check', deviceId: args.deviceId, elapsedMs: performance.now() - startedAt }) };
          }
        }
        if (signal?.aborted) throw cancellationError();
        return textResult(info);
      }
      if (tool.name === 'wait_for') {
        const waited = await deviceAdapter.waitFor(args, { signal });
        return waited.status === 'matched' ? textResult(waited) : observationFallback({ ...waited, ...toDiagnostic(waited,
          { errorCode: waited.status === 'timeout' ? 'WAIT_TIMEOUT' : 'LAYOUT_UNAVAILABLE', stage: 'wait_for', deviceId: args.deviceId, elapsedMs: waited.elapsedMs }) }, args.deviceId, true, { timeoutMs: 3000 });
      }
      if (tool.name === 'observe' || tool.name === 'find') {
        try {
          const observed = await deviceAdapter[tool.name](args, { signal });
          if (tool.name === 'find' ? observed.totalMatches === 0 : observed.totalNodes === 0 || observed.truncated) {
            return observationFallback(observed, args.deviceId, false, { timeoutMs: 3000, signal });
          }
          return textResult(observed);
        } catch (error) {
          return observationFallback({ ...toDiagnostic(error,
            { errorCode: 'LAYOUT_UNAVAILABLE', stage: tool.name, deviceId: args.deviceId, elapsedMs: performance.now() - startedAt }),
            warnings: ['UITest layout is unavailable. Inspect the screenshot; no device action was executed.'] }, args.deviceId, true, { timeoutMs: 3000, signal });
        }
      }
      if (tool.name === 'tap') return textResult(await withDeviceLock(args.deviceId, signal, () => deviceAdapter.tap(args, { signal })));
      if (tool.name === 'tap_element') return textResult(await withDeviceLock(args.deviceId, signal, () => deviceAdapter.tapElement(args, { signal })));
      if (tool.name === 'swipe') return textResult(await withDeviceLock(args.deviceId, signal, () => deviceAdapter.swipe(args, { signal })));
      if (tool.name === 'long_press') return textResult(await withDeviceLock(args.deviceId, signal, () => deviceAdapter.longPress(args, { signal })));
      if (tool.name === 'key_event') return textResult(await withDeviceLock(args.deviceId, signal, () => deviceAdapter.keyEvent(args, { signal })));
      if (tool.name === 'input_text') return textResult(await withDeviceLock(args.deviceId, signal, () => deviceAdapter.inputText(args, { signal })));
      if (tool.name === 'build_run') return textResult(await withDeviceLock(args.deviceId, signal, () => buildAndRun(deviceAdapter, {
        projectPath, deviceId: args.deviceId, moduleName: args.moduleName, artifactName: args.artifactName, signal
      })));
      if (tool.name === 'preview_frame') return liveFrameResult(args.afterSeq ?? 0, args.waitMs ?? 0);
      if (tool.name === 'preview_action') return await withDeviceLock(livePreview?.deviceId, signal, () => previewAction(args, { signal }));
      if (tool.name === 'preview_start') return textResult(await startLivePreview(args.deviceId, { signal }));
      if (tool.name === 'preview_stop') return textResult(await stopLivePreview(args.sessionId));
      const frame = await deviceAdapter.capture({ deviceId: args.deviceId }, { signal });
      return imageResult(frame.data, frame.mimeType, frameMetadata(frame, args.deviceId));
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      const errorCode = tool.name === 'capture' ? 'CAPTURE_FAILED' : tool.name === 'list_devices' ? 'HDC_FAILED'
        : tool.name === 'build_run' ? 'BUILD_FAILED' : tool.name.startsWith('preview_') ? 'PREVIEW_UNAVAILABLE' : 'ACTION_FAILED';
      const diagnostic = toDiagnostic(error, { errorCode, stage: tool.name, deviceId: args.deviceId, elapsedMs: performance.now() - startedAt });
      if (args.deviceId && tool.name !== 'capture') return observationFallback(diagnostic, args.deviceId, true, { timeoutMs: 3000, signal });
      return { ...textResult(diagnostic), isError: true };
    }
  }

  async function observationFallback(observed, deviceId, isError = false, captureOptions = { timeoutMs: 3000 }) {
    if (captureOptions.signal?.aborted) throw cancellationError();
    const result = textResult({ ...observed, screenshotFallback: true });
    if (isError) result.isError = true;
    const startedAt = performance.now();
    try {
      const frame = await deviceAdapter.capture({ deviceId }, captureOptions);
      result.content.push(...imageResult(frame.data, frame.mimeType, {}).content);
      result.structuredContent.screenshot = frameMetadata(frame, deviceId);
    } catch (error) {
      if (captureOptions.signal?.aborted) throw cancellationError();
      result.structuredContent.screenshotError = error.message;
      result.structuredContent.screenshotDiagnostic = toDiagnostic(error,
        { errorCode: 'CAPTURE_FAILED', stage: 'capture', deviceId, elapsedMs: performance.now() - startedAt });
    }
    result.content[0].text = JSON.stringify(result.structuredContent);
    return result;
  }

  async function startLivePreview(deviceId, { signal } = {}) {
    if (signal?.aborted) throw cancellationError();
    if (livePreview?.deviceId === deviceId && livePreview.paused && livePreview.socket?.readyState === WebSocket.OPEN) {
      livePreview.paused = false;
      livePreview.lastFrameAccessAt = Date.now();
      livePreview.socket.send(JSON.stringify({ type: 'preview-resume', deviceId }));
      touchFrameLease(livePreview);
      return previewInfo();
    }
    if (livePreview?.deviceId === deviceId && livePreview.connected && livePreview.frame) return previewInfo();
    await ensurePreviewService();
    await stopLivePreview();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const state = { socket, sessionId: randomUUID(), deviceId, frame: null, frameMeta: null, seq: 0, receivedAt: null,
        lastFrameAccessAt: Date.now(), leaseTimer: null, paused: false, mimeType: 'image/jpeg', started: false,
        connected: false, settled: false, saving: false, pollMs: null, frameSource: null, lastMetrics: null, frameWaiters: new Set() };
      livePreview = state;
      const timer = setTimeout(() => fail(Object.assign(new Error('Timed out waiting for the first preview frame; check device connection'),
        state.lastDiagnostic ? { errorCode: state.lastDiagnostic.errorCode, stage: state.lastDiagnostic.stage, cause: state.lastDiagnostic.cause } : {})), previewTimeoutMs);
      const fail = (error) => {
        if (state.settled) return;
        state.settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (livePreview === state) livePreview = undefined;
        socket.terminate();
        reject(tagError(error, 'PREVIEW_UNAVAILABLE', 'preview_start'));
      };
      const onAbort = () => fail(cancellationError());
      signal?.addEventListener('abort', onAbort, { once: true });
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
          if (event.type === 'frame-meta') {
            state.mimeType = event.mimeType || state.mimeType;
            state.frameMeta = { deviceId: event.deviceId ?? state.deviceId, frameId: event.frameId,
              capturedAt: event.capturedAt, width: event.width, height: event.height, mimeType: state.mimeType };
          }
          if (event.type === 'preview-status') {
            if (event.running) state.started = true;
            if (!event.running) state.connected = false;
            if (event.paused !== undefined) state.paused = event.paused === true;
            if (event.diagnostic) state.lastDiagnostic = event.diagnostic;
            if (event.pollMs) state.pollMs = event.pollMs;
            if (event.frameSource) state.frameSource = event.frameSource;
          }
          if (event.type === 'preview-tick' && event.metrics) {
            state.lastMetrics = event.metrics;
            if (state.frameMeta) state.frameMeta.capturedAt ??= event.metrics.capturedAt;
          }
          if (event.type === 'error') fail(Object.assign(new Error(event.error),
            { ...(event.errorCode ? { errorCode: event.errorCode } : {}), ...(event.stage ? { stage: event.stage } : {}),
              ...(event.cause ? { cause: event.cause } : {}) }));
          return;
        }
        if (!state.started || livePreview !== state) return;
        state.frame = Buffer.from(message);
        state.seq += 1;
        state.receivedAt = Date.now();
        state.connected = true;
        state.paused = false;
        resolveFrameWaiters(state);
        touchFrameLease(state);
        state.lastDiagnostic = null;
        if (!state.settled && !state.saving) {
          state.saving = true;
          try {
            await savePreviewState(state);
            if (state.settled) return;
            state.settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(previewInfo());
          } catch (error) { fail(error); }
        }
      });
    });
  }

  function liveFrameResult(afterSeq = 0, waitMs = 0) {
    const state = livePreview;
    if (!state) return { content: [], structuredContent: { running: false, connected: false, sessionId: null, deviceId: null, seq: 0, frame: null } };
    state.lastFrameAccessAt = Date.now();
    const resumedFromPause = state.paused;
    if (state.paused && state.socket?.readyState === WebSocket.OPEN) {
      state.paused = false;
      state.socket.send(JSON.stringify({ type: 'preview-resume', deviceId: state.deviceId }));
    }
    touchFrameLease(state, waitMs > 0 ? Math.max(frameLeaseMs, waitMs) : frameLeaseMs);
    if (waitMs > 0 && (state.connected || resumedFromPause) && !(state.frame && state.seq > afterSeq)) {
      return waitForFrame(state, afterSeq, waitMs).then(() => liveFrameResult(afterSeq));
    }
    const frameMeta = state.frameMeta ?? {};
    const hasNewFrame = Boolean(state.frame && state.seq > afterSeq);
    return {
      content: [],
      structuredContent: {
        running: true,
        connected: state.connected,
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        seq: state.seq,
        frameAgeMs: state.receivedAt ? Math.max(0, Date.now() - state.receivedAt) : null,
        frameSource: state.frameSource,
        metrics: state.lastMetrics,
        frame: hasNewFrame ? {
          mimeType: frameMeta.mimeType || state.mimeType,
          data: state.frame.toString('base64'),
          frameId: frameMeta.frameId ?? null,
          capturedAt: frameMeta.capturedAt ?? null,
          width: frameMeta.width ?? null,
          height: frameMeta.height ?? null
        } : null
      }
    };
  }

  function waitForFrame(state, afterSeq, waitMs) {
    if (state.frame && state.seq > afterSeq) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { afterSeq, resolve, timer: setTimeout(() => {
        state.frameWaiters.delete(waiter);
        resolve();
      }, waitMs) };
      state.frameWaiters.add(waiter);
    });
  }

  function resolveFrameWaiters(state) {
    for (const waiter of state.frameWaiters ?? []) {
      if (state.seq <= waiter.afterSeq) continue;
      clearTimeout(waiter.timer);
      state.frameWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  function cancelFrameWaiters(state) {
    for (const waiter of state.frameWaiters ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    state.frameWaiters?.clear();
  }

  async function previewAction(args, { signal } = {}) {
    if (signal?.aborted) throw cancellationError();
    const state = livePreview;
    if (!state) throw tagError(new Error('No active preview session'), 'PREVIEW_UNAVAILABLE', 'preview_action');
    if (state.paused || !state.connected) throw tagError(new Error('Preview is not connected'), 'PREVIEW_UNAVAILABLE', 'preview_action');
    if (state.seq !== args.seq) throw tagError(new Error('Preview frame is stale; request a new frame before acting'), 'STALE_PREVIEW_FRAME', 'preview_action');
    if (args.action === 'tap') {
      if (![args.x, args.y].every((value) => Number.isFinite(value))) throw Object.assign(new Error('tap requires x and y'), { rpcCode: -32602 });
      const result = await deviceAdapter.tap({ deviceId: state.deviceId, x: args.x, y: args.y }, { signal });
      if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'preview-refresh', deviceId: state.deviceId }));
      return { content: [], structuredContent: result };
    }
    if (![args.x, args.y, args.toX, args.toY].every((value) => Number.isFinite(value))) throw Object.assign(new Error('swipe requires x, y, toX and toY'), { rpcCode: -32602 });
    const result = await deviceAdapter.swipe({ deviceId: state.deviceId,
      fromX: args.x, fromY: args.y, toX: args.toX, toY: args.toY }, { signal });
    if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'preview-refresh', deviceId: state.deviceId }));
    return { content: [], structuredContent: result };
  }

  async function stopLivePreview(sessionId, { clearPersisted = true } = {}) {
    const state = livePreview;
    const current = state ?? persistedPreview;
    if (sessionId && current && sessionId !== current.sessionId) throw new Error('Preview sessionId does not match the active session');
    livePreview = undefined;
    if (state) cancelFrameWaiters(state);
    if (state?.leaseTimer) clearTimeout(state.leaseTimer);
    if (state?.socket && state.socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((resolve) => state.socket.once('close', resolve));
      state.socket.terminate();
      await closed;
    }
    if (clearPersisted && !ownsPreviewServer) {
      persistedPreview = null;
      await clearPreviewState(previewStatePath);
    }
    return current ? { running: false, deviceId: current.deviceId, sessionId: current.sessionId } : { running: false };
  }

  function previewInfo() {
    const saved = !livePreview && !ownsPreviewServer ? persistedPreview : null;
    const active = livePreview ?? saved;
    const previewUrl = `${serverUrl}${active?.deviceId ? `?deviceId=${encodeURIComponent(active.deviceId)}` : ''}`;
    return { previewUrl, serverUrl, wsUrl, running: Boolean(active), connected: livePreview?.connected ?? false,
      paused: livePreview?.paused ?? false,
      restored: Boolean(saved), sessionId: active?.sessionId ?? null, deviceId: active?.deviceId ?? null, pollMs: livePreview?.pollMs ?? active?.pollMs ?? null,
      frameSource: livePreview?.frameSource ?? active?.frameSource ?? null,
      capabilities: tools.map((tool) => tool.name), runtime, deviceCheck: { status: 'not_checked' } };
  }

  function touchFrameLease(state, requestedLeaseMs = frameLeaseMs) {
    if (!state || livePreview !== state) return;
    const leaseMs = Math.max(frameLeaseMs, requestedLeaseMs);
    state.lastFrameAccessAt = Date.now();
    if (state.leaseTimer) clearTimeout(state.leaseTimer);
    state.leaseTimer = setTimeout(() => {
      if (livePreview !== state || state.paused) return;
      if (Date.now() - state.lastFrameAccessAt < leaseMs) {
        touchFrameLease(state, leaseMs);
        return;
      }
      state.paused = true;
      state.connected = false;
      if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'preview-pause', deviceId: state.deviceId }));
    }, leaseMs + 25);
  }

  async function savePreviewState(state) {
    if (ownsPreviewServer) return;
    const saved = { sessionId: state.sessionId, deviceId: state.deviceId, serverUrl, wsUrl, pollMs: state.pollMs, lastSeen: Date.now() };
    try { await writePreviewState(previewStatePath, saved); }
    catch (error) { throw tagError(error, 'STATE_WRITE_FAILED', 'state_save'); }
    if (livePreview === state && !state.settled) persistedPreview = saved;
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

function cancellationError() {
  return Object.assign(new Error('Request cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
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
  const temporary = `${path}.${randomUUID()}.tmp`;
  let failure;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', 'utf8');
    await rename(temporary, path);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT' && !failure) throw error; }
  }
}

async function clearPreviewState(path) {
  try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw tagError(error, 'STATE_WRITE_FAILED', 'state_clear'); }
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

function frameMetadata(frame, deviceId) {
  return { deviceId, live: false, sessionId: null, frameId: frame.frameId ?? randomUUID(),
    capturedAt: frame.capturedAt ?? new Date().toISOString(),
    ...(frame.width && frame.height ? { width: frame.width, height: frame.height } : {}) };
}

function validateArguments(schema, args) {
  const fail = () => { throw Object.assign(new Error('Invalid tool arguments'), { rpcCode: -32602 }); };
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail();
  if ((schema.required ?? []).some((key) => !Object.hasOwn(args, key))) fail();
  if (Object.keys(args).length < (schema.minProperties ?? 0)) fail();
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) fail();
    if (property.type === 'integer' ? !Number.isInteger(value) : typeof value !== property.type) fail();
    if (property.type === 'object') { validateArguments(property, value); continue; }
    if (property.type === 'string' && (!value.trim() || value.length < (property.minLength ?? 0) || value.length > (property.maxLength ?? Infinity) || property.enum && !property.enum.includes(value))) fail();
    if (property.pattern && !new RegExp(property.pattern).test(value)) fail();
    if (['number', 'integer'].includes(property.type) && (!Number.isFinite(value) || value < property.minimum || value > (property.maximum ?? Infinity))) fail();
  }
}
