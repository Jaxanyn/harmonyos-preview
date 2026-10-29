const parentWindow = window.parent;
const pending = new Map();
let nextRequestId = 0;

const status = document.querySelector('#status');
const devices = document.querySelector('#devices');
const stage = document.querySelector('#stage');
const frameShell = document.querySelector('#frame-shell');
const overlay = document.querySelector('#stage-overlay');
const overlayText = document.querySelector('#overlay-text');
const gestureMarker = document.querySelector('#gesture-marker');
const metrics = document.querySelector('#metrics');
const buttons = [...document.querySelectorAll('button')];
const fitButton = document.querySelector('#fit');
const zoomOutButton = document.querySelector('#zoom-out');
const zoomInButton = document.querySelector('#zoom-in');
const fullscreenButton = document.querySelector('#fullscreen');
let deviceId = '';
let sessionId = '';
let generation = 0;
let previewRunning = false;
let disposed = false;
let frame;
let frameSeq = 0;
let pollMs = 500;
let pollTimer;
let gestureStart;
let gesturePending = false;
let captureQueue = Promise.resolve();
let zoom = 1;
let markerTimer;
const now = () => globalThis.performance?.now?.() ?? Date.now();

function setStatus(message, error = false) {
  status.textContent = message;
  status.className = error ? 'error' : 'status';
}

function setOverlay(message, visible = true) {
  overlayText.textContent = message;
  overlay.hidden = !visible;
}

function setMetrics(nextFrame) {
  if (!nextFrame) {
    metrics.textContent = 'No frame yet';
    return;
  }
  const time = nextFrame.capturedAt ? new Date(nextFrame.capturedAt).toLocaleTimeString() : 'unknown time';
  const capture = Number.isFinite(nextFrame.metrics?.captureMs) ? ` · ${nextFrame.metrics.captureMs}ms` : '';
  const source = nextFrame.metrics?.source ? ` · ${nextFrame.metrics.source}` : '';
  const render = Number.isFinite(nextFrame.metrics?.renderMs) ? ` · render ${nextFrame.metrics.renderMs}ms` : '';
  metrics.textContent = `${nextFrame.width}×${nextFrame.height} · ${time}${capture}${source}${render} · ${Math.round(zoom * 100)}%`;
}

function setZoom(nextZoom) {
  zoom = Math.min(1.5, Math.max(0.75, nextZoom));
  stage.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
  if (frame) setMetrics(frame);
}

function hideGestureMarker() {
  clearTimeout(markerTimer);
  markerTimer = undefined;
  gestureMarker.hidden = true;
}

function showGestureMarker(point) {
  if (!frame) return;
  const stageBox = stage.getBoundingClientRect();
  const shellBox = frameShell.getBoundingClientRect();
  if (!stageBox.width || !stageBox.height || !shellBox.width || !shellBox.height) return;
  gestureMarker.style.left = `${stageBox.left - shellBox.left + point.x * stageBox.width / frame.width}px`;
  gestureMarker.style.top = `${stageBox.top - shellBox.top + point.y * stageBox.height / frame.height}px`;
  gestureMarker.hidden = false;
  clearTimeout(markerTimer);
  markerTimer = setTimeout(() => { gestureMarker.hidden = true; }, 400);
}

function setBusy(busy) {
  buttons.forEach((button) => { button.disabled = busy; });
}

function applyHostContext(context) {
  if (context?.theme) document.documentElement.style.colorScheme = context.theme;
  const variables = context?.styles?.variables;
  if (variables && typeof variables === 'object') {
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === 'string') document.documentElement.style.setProperty(name, value);
    }
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== parentWindow) return;
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'ui/notifications/host-context-changed') {
    applyHostContext(message.params);
    return;
  }
  if (message.method === 'ui/resource-teardown') {
    teardown();
    if (Object.hasOwn(message, 'id')) parentWindow.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
    return;
  }
  if (!Object.hasOwn(message, 'id')) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message || 'Host request failed'));
  else request.resolve(message.result);
});

function request(method, params = {}) {
  if (disposed) return Promise.reject(new Error('Preview panel closed'));
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    const timeoutMs = params.name === 'build_run' ? 330000 : 30000;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${params.name || method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    parentWindow.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
}

function notify(method, params = {}) {
  parentWindow.postMessage({ jsonrpc: '2.0', method, params }, '*');
}

async function connect() {
  const context = await request('ui/initialize', {
    appCapabilities: {},
    appInfo: { name: 'harmonyos-preview', version: '0.1.0' },
    protocolVersion: '2026-01-26',
  });
  applyHostContext(context?.hostContext);
  notify('ui/notifications/initialized');
}

function parseText(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : result?.structuredContent ?? {};
}

async function callServerTool(name, arguments_ = {}) {
  const result = await request('tools/call', { name, arguments: arguments_ });
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
  return result;
}

async function refreshDevices() {
  const requestedGeneration = generation;
  const result = parseText(await callServerTool('list_devices'));
  if (disposed || requestedGeneration !== generation) return;
  const available = Array.isArray(result.devices) ? result.devices : [];
  const previous = deviceId;
  devices.replaceChildren(...available.map((id) => new Option(id, id)));
  const selected = available.includes(previous) ? previous : (available[0] ?? '');
  if (selected !== previous) selectDevice(selected);
  devices.value = deviceId;
  if (!previewRunning) setStatus(deviceId ? `Device ready: ${deviceId}` : 'No device connected', !deviceId);
}

function isCurrent(requestedGeneration, requestedDevice) {
  return !disposed && previewRunning && generation === requestedGeneration && deviceId === requestedDevice;
}

function clearFrame(message = 'Waiting for first frame', showOverlay = true) {
  frame = undefined;
  gestureStart = undefined;
  hideGestureMarker();
  setZoom(1);
  setMetrics(undefined);
  setOverlay(message, showOverlay);
  stage.hidden = true;
  stage.removeAttribute('src');
}

function resetPreview() {
  generation += 1;
  previewRunning = false;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  clearFrame();
  frameSeq = 0;
  const previousSession = sessionId;
  sessionId = '';
  return previousSession;
}

async function stopSession(id) {
  if (id) await callServerTool('preview_stop', { sessionId: id });
}

function selectDevice(selected) {
  const previousSession = resetPreview();
  deviceId = selected;
  devices.value = selected;
  stopSession(previousSession).catch(() => {});
  setStatus(selected ? `Device ready: ${selected}` : 'No device connected', !selected);
}

async function renderImage(result, requestedGeneration, requestedDevice) {
  const structured = result?.structuredContent ?? {};
  const liveFrame = result?.structuredContent?.frame;
  const image = liveFrame ?? result?.content?.find((item) => item.type === 'image');
  if (!image || structured.deviceId !== requestedDevice) throw new Error('Screenshot does not match the selected device');
  if (!isCurrent(requestedGeneration, requestedDevice)) return false;
  frame = undefined;
  const renderStartedAt = now();
  stage.src = `data:${image.mimeType};base64,${image.data}`;
  await stage.decode();
  if (!isCurrent(requestedGeneration, requestedDevice)) return false;
  if (!stage.naturalWidth || !stage.naturalHeight) throw new Error('Screenshot has no decoded dimensions');
  frame = {
    deviceId: requestedDevice,
    width: stage.naturalWidth,
    height: stage.naturalHeight,
    frameId: image.frameId,
    capturedAt: image.capturedAt,
    metrics: structured.metrics ? { ...structured.metrics, renderMs: Math.max(0, Math.round(now() - renderStartedAt)) } : null,
  };
  stage.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
  stage.hidden = false;
  setOverlay('', false);
  setMetrics(frame);
  return true;
}

function requestFrame(requestedGeneration, requestedDevice, waitMs = 0) {
  const captureTask = captureQueue.then(async () => {
    if (!isCurrent(requestedGeneration, requestedDevice)) return false;
    try {
      const arguments_ = waitMs > 0 ? { afterSeq: frameSeq, waitMs } : { afterSeq: frameSeq };
      const result = await callServerTool('preview_frame', arguments_);
      if (!isCurrent(requestedGeneration, requestedDevice)) return false;
      const structured = result.structuredContent ?? {};
      if (Number.isInteger(structured.seq)) frameSeq = Math.max(frameSeq, structured.seq);
      if (!structured.frame) {
        if (structured.connected === false) {
          setOverlay('Device disconnected. Waiting for reconnection.');
          setStatus(`Preview disconnected: ${requestedDevice}`, true);
        }
        return false;
      }
      const rendered = await renderImage(result, requestedGeneration, requestedDevice);
      if (rendered) setStatus(`Preview running: ${requestedDevice}`);
      return rendered;
    } catch (error) {
      if (isCurrent(requestedGeneration, requestedDevice)) {
        const message = /disconnect|offline/i.test(error.message)
          ? 'Device disconnected. Waiting for reconnection.'
          : 'Preview unavailable. Waiting for a new frame.';
        clearFrame(message);
        setStatus(error.message, true);
      }
      return false;
    }
  });
  captureQueue = captureTask;
  return captureTask;
}

async function requestFreshFrame(requestedGeneration, requestedDevice) {
  return requestFrame(requestedGeneration, requestedDevice, 2500);
}

function scheduleCapture(requestedGeneration, requestedDevice) {
  if (!isCurrent(requestedGeneration, requestedDevice) || !sessionId || gesturePending) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await requestFrame(requestedGeneration, requestedDevice);
    scheduleCapture(requestedGeneration, requestedDevice);
  }, pollMs);
}

async function startPreview() {
  if (!deviceId) throw new Error('Select a device first');
  if (previewRunning || disposed) return;
  const requestedDevice = deviceId;
  const requestedGeneration = ++generation;
  previewRunning = true;
  clearFrame('Connecting to the device…');
  try {
    const info = parseText(await callServerTool('preview_start', { deviceId: requestedDevice }));
    if (!isCurrent(requestedGeneration, requestedDevice)) {
      if (!previewRunning || deviceId !== requestedDevice) await stopSession(info.sessionId).catch(() => {});
      return;
    }
    sessionId = info.sessionId || '';
    pollMs = Math.max(500, info.pollMs || 500);
    await requestFrame(requestedGeneration, requestedDevice);
    scheduleCapture(requestedGeneration, requestedDevice);
  } catch (error) {
    if (isCurrent(requestedGeneration, requestedDevice)) {
      resetPreview();
      setOverlay('Preview failed. Check the device connection.');
      setStatus(error.message, true);
    }
  }
}

async function stopPreview() {
  const previousSession = resetPreview();
  const stoppedGeneration = generation;
  setOverlay('Preview stopped. Start again to view the device.');
  setStatus('Preview stopped');
  try { await stopSession(previousSession); }
  catch (error) { if (!disposed && generation === stoppedGeneration) setStatus(error.message, true); }
}

async function buildRun() {
  if (!deviceId) throw new Error('Select a device first');
  const requestedGeneration = generation;
  setBusy(true);
  try {
    await callServerTool('build_run', { deviceId });
    if (!disposed && generation === requestedGeneration) setStatus('Build, install and launch completed');
  } finally {
    setBusy(false);
  }
}

function imagePoint(event) {
  if (!frame || frame.deviceId !== deviceId) return;
  const box = stage.getBoundingClientRect();
  if (!box.width || !box.height) return;
  return {
    x: Math.min(frame.width - 1, Math.max(0, Math.round((event.clientX - box.left) * frame.width / box.width))),
    y: Math.min(frame.height - 1, Math.max(0, Math.round((event.clientY - box.top) * frame.height / box.height))),
  };
}

async function sendGesture(event, start) {
  if (!previewRunning || gesturePending || !start || start.generation !== generation || start.deviceId !== deviceId) return;
  if (!frame || start.width !== frame.width || start.height !== frame.height) return;
  const end = imagePoint(event);
  if (!end) return;
  const requestedGeneration = generation;
  const requestedDevice = deviceId;
  const moved = Math.hypot(end.x - start.x, end.y - start.y);
  const action = moved > 12 ? 'swipe' : 'tap';
  if (action === 'tap') showGestureMarker(end);
  setStatus(action === 'tap' ? 'Sending tap…' : 'Sending swipe…');
  const arguments_ = action === 'tap'
    ? { action, seq: frameSeq, x: end.x, y: end.y }
    : { action, seq: frameSeq, x: start.x, y: start.y, toX: end.x, toY: end.y };
  gesturePending = true;
  clearTimeout(pollTimer);
  try {
    await captureQueue;
    if (!isCurrent(requestedGeneration, requestedDevice)) return;
    if (!frame || start.width !== frame.width || start.height !== frame.height) return;
    frame = undefined;
    const actionResult = await callServerTool('preview_action', arguments_);
    const actionMs = actionResult?.structuredContent?.metrics?.actionMs;
    if (Number.isFinite(actionMs) && isCurrent(requestedGeneration, requestedDevice)) {
      setStatus(`${action === 'tap' ? 'Tap' : 'Swipe'} sent in ${actionMs}ms; waiting for frame`);
    }
    await requestFreshFrame(requestedGeneration, requestedDevice);
  } catch (error) {
    if (isCurrent(requestedGeneration, requestedDevice)) {
      clearFrame('Action failed. Waiting for a new frame.');
      setStatus(error.message, true);
    }
  } finally {
    gesturePending = false;
    scheduleCapture(generation, deviceId);
  }
}

function teardown() {
  if (disposed) return;
  stopPreview().catch(() => {});
  disposed = true;
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error('Preview panel closed'));
  }
  pending.clear();
}

devices.addEventListener('change', () => selectDevice(devices.value));
document.querySelector('#refresh').addEventListener('click', () => refreshDevices().catch((error) => setStatus(error.message, true)));
document.querySelector('#build').addEventListener('click', () => buildRun().catch((error) => setStatus(error.message, true)));
document.querySelector('#start').addEventListener('click', () => startPreview().catch((error) => setStatus(error.message, true)));
document.querySelector('#stop').addEventListener('click', () => stopPreview().catch((error) => setStatus(error.message, true)));
fitButton.addEventListener('click', () => setZoom(1));
zoomOutButton.addEventListener('click', () => setZoom(zoom - 0.25));
zoomInButton.addEventListener('click', () => setZoom(zoom + 0.25));
fullscreenButton.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else frameShell.requestFullscreen?.();
});
stage.addEventListener('pointerdown', (event) => {
  if (!previewRunning || gesturePending) return;
  const point = imagePoint(event);
  if (!point) return;
  gestureStart = { ...point, generation, deviceId, width: frame.width, height: frame.height };
  stage.setPointerCapture?.(event.pointerId);
});
stage.addEventListener('pointerup', (event) => { const start = gestureStart; gestureStart = undefined; if (start) sendGesture(event, start).catch((error) => setStatus(error.message, true)); });
stage.addEventListener('pointercancel', () => { gestureStart = undefined; });
window.addEventListener('pagehide', teardown);

async function initialize() {
  try {
    await connect();
    setStatus('HarmonyOS Preview connected');
    await refreshDevices();
  } catch (error) {
    setStatus(`Cannot connect to Codex: ${error.message}`, true);
  }
}

initialize();
