import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createDeviceAdapter } from './device.mjs';
import { buildAndRun } from './build.mjs';

const host = process.env.HARMONY_PREVIEW_HOST ?? '127.0.0.1';
const port = Number(process.env.HARMONY_PREVIEW_PORT ?? 4100);

const previewPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HarmonyOS Preview</title>
<style>
  :root{color-scheme:dark;font:14px system-ui,sans-serif}body{margin:0;min-height:100vh;background:#0c0f14;color:#f4f6fa;display:grid;grid-template-columns:240px 1fr}
  aside{padding:20px;background:#151a22;border-right:1px solid #2a303b}h1{font-size:18px;margin:0 0 8px}p{color:#aeb8c8;line-height:1.5}#status{color:#75e0aa}
  main{display:grid;place-items:center;min-width:0;padding:24px}#stage{max-width:100%;max-height:calc(100vh - 48px);background:#000;box-shadow:0 16px 50px #0009;cursor:crosshair}
</style></head><body><aside><h1>HarmonyOS Preview</h1><p id="status">Connecting…</p><select id="devices"><option value="">No device selected</option></select><button id="refresh">Refresh devices</button><button id="build">Build · Install · Run</button><button id="shot">Capture screenshot</button><button id="start">Start preview</button><button id="stop">Stop preview</button><p>Device frame polling</p></aside><main><img id="stage" alt="HarmonyOS preview frame"></main>
<script>
const stage=document.querySelector('#stage');const status=document.querySelector('#status');const devices=document.querySelector('#devices');let deviceId='',frameDeviceId='',nextFrameDeviceId='',tapPending=false;
const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/preview');let frameMime='image/png';
socket.binaryType='blob';
socket.onopen=()=>status.textContent='Connected';
socket.onclose=()=>status.textContent='Disconnected';
socket.onerror=()=>status.textContent='Connection error';
socket.onmessage=event=>{if(typeof event.data==='string'){const message=JSON.parse(event.data);if(message.type==='status'||message.type==='run-status')status.textContent=message.text;if(message.type==='frame-meta'){frameMime=message.mimeType;nextFrameDeviceId=message.deviceId??'';}if(message.type==='devices'){const previous=deviceId;devices.replaceChildren(...message.devices.map(id=>new Option(id,id)));deviceId=message.devices.includes(previous)?previous:(message.devices[0]??'');devices.value=deviceId;if(!deviceId)status.textContent='No device connected';}if(message.type==='tap-ack'||message.type==='swipe-ack'||message.type==='long-press-ack'||message.type==='key-event-ack'||message.type==='input-text-ack'){tapPending=false;status.textContent=message.type.replace('-ack','')+' complete';}if(message.type==='preview-status')status.textContent=message.running?(message.reconnecting?'Reconnecting':'Preview running'):(message.reason==='device-disconnected'?'Device disconnected; retrying':'Preview stopped');if(message.type==='error'){tapPending=false;status.textContent=message.error;}return;}const old=stage.src;const sourceDeviceId=nextFrameDeviceId;stage.onload=()=>{frameDeviceId=sourceDeviceId;if(old.startsWith('blob:'))URL.revokeObjectURL(old)};stage.src=URL.createObjectURL(new Blob([event.data],{type:frameMime}))};
document.querySelector('#refresh').onclick=()=>socket.send(JSON.stringify({type:'device-list'}));document.querySelector('#build').onclick=()=>{if(deviceId)socket.send(JSON.stringify({type:'build-run',deviceId}));};document.querySelector('#shot').onclick=()=>{if(deviceId)socket.send(JSON.stringify({type:'screenshot',deviceId}));};document.querySelector('#start').onclick=()=>{if(deviceId)socket.send(JSON.stringify({type:'preview-start',deviceId}));};document.querySelector('#stop').onclick=()=>socket.send(JSON.stringify({type:'preview-stop'}));devices.onchange=()=>{deviceId=devices.value;frameDeviceId='';socket.send(JSON.stringify({type:'preview-stop'}));};
let gestureStart,longTimer,longFired=false;
const point=event=>{const box=stage.getBoundingClientRect();return {x:Math.min(stage.naturalWidth-1,Math.max(0,Math.round((event.clientX-box.left)*stage.naturalWidth/box.width))),y:Math.min(stage.naturalHeight-1,Math.max(0,Math.round((event.clientY-box.top)*stage.naturalHeight/box.height)))}};
const sendGesture=(type,data)=>{if(!deviceId||frameDeviceId!==deviceId){status.textContent='Capture or start preview for the selected device first';return;}if(tapPending||socket.readyState!==WebSocket.OPEN)return;tapPending=true;socket.send(JSON.stringify({type,deviceId,...data}))};
stage.onpointerdown=event=>{gestureStart=point(event);longFired=false;longTimer=setTimeout(()=>{longFired=true;const {x,y}=gestureStart;status.textContent='Long pressing '+x+','+y;sendGesture('long-press',{x,y})},600);stage.setPointerCapture?.(event.pointerId)};
stage.onpointerup=event=>{clearTimeout(longTimer);if(!gestureStart||longFired){gestureStart=null;return;}const end=point(event);const moved=Math.hypot(end.x-gestureStart.x,end.y-gestureStart.y);if(moved>12)sendGesture('swipe',{fromX:gestureStart.x,fromY:gestureStart.y,toX:end.x,toY:end.y});else sendGesture('tap',end);gestureStart=null};
stage.onpointercancel=()=>{clearTimeout(longTimer);gestureStart=null};
</script></body></html>`;

const staticFrame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920"><rect width="1080" height="1920" fill="#10151c"/><rect x="48" y="70" width="984" height="1780" rx="42" fill="#1b2430"/><text x="540" y="850" text-anchor="middle" fill="#f4f6fa" font-size="56" font-family="system-ui">HarmonyOS Preview</text><text x="540" y="940" text-anchor="middle" fill="#9eabbc" font-size="34" font-family="system-ui">Static frame</text><circle cx="540" cy="1070" r="54" fill="#4f7cff"/></svg>`);
const configuredPollMs = Number(process.env.HARMONY_PREVIEW_POLL_MS ?? 500);
const pollMs = Number.isFinite(configuredPollMs) ? Math.max(100, Math.floor(configuredPollMs)) : 500;
const maxBodyBytes = 1024 * 1024;
const projectPath = process.env.HARMONY_PROJECT;

export function createPreviewServer({ deviceAdapter = createDeviceAdapter() } = {}) {
  const server = createServer((request, response) => {
    if (!isAllowedOrigin(request.headers.origin, server.address()?.port ?? port)) {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'origin_not_allowed' }));
      return;
    }
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(previewPage);
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ name: 'harmonyos-preview', status: 'ok' }));
      return;
    }
    if (request.url === '/api/devices') {
      deviceAdapter.listTargets().then((devices) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ devices }));
      }).catch((error) => {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      });
      return;
    }
    if (request.url === '/api/capabilities') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        name: 'harmonyos-preview',
        version: 1,
        http: ['GET /api/devices', 'POST /api/capture', 'POST /api/tap'],
        websocket: 'ws://127.0.0.1:' + (server.address()?.port ?? port) + '/preview',
        messages: ['device-list', 'screenshot', 'tap', 'swipe', 'long-press', 'key-event', 'input-text', 'preview-start', 'preview-stop', 'build-run']
      }));
      return;
    }
    if (request.url === '/api/capture' || request.url === '/api/tap') {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      readJson(request).then(async (body) => {
        const result = request.url === '/api/capture'
          ? await deviceAdapter.capture(body)
          : await deviceAdapter.tap(body);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(request.url === '/api/capture'
          ? { mimeType: result.mimeType, data: result.data.toString('base64') }
          : result));
      }).catch((error) => sendJsonError(response, error));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  const sockets = new WebSocketServer({
    server,
    path: '/preview',
    verifyClient: ({ origin }) => isAllowedOrigin(origin, server.address()?.port ?? port)
  });
  const sessions = new Map();
  sockets.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'status', text: 'Preview connected' }));
    socket.send(JSON.stringify({ type: 'frame-meta', mimeType: 'image/svg+xml', width: 1080, height: 1920 }));
    socket.send(staticFrame);
    socket.on('message', (message) => {
      handleSocketMessage(socket, deviceAdapter, sessions, message).catch((error) => socket.send(JSON.stringify({ type: 'error', error: error.message })));
    });
    socket.on('close', () => stopPolling(socket, sessions));
  });
  server.shutdown = () => {
    for (const socket of sockets.clients) { stopPolling(socket, sessions); socket.terminate(); }
    server.closeAllConnections();
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  return server;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        request.resume();
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('invalid_json')); }
    });
    request.on('error', reject);
  });
}

function sendJsonError(response, error) {
  if (response.headersSent) return;
  response.writeHead(error.statusCode ?? 400, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: error.message }));
}

function isAllowedOrigin(origin, actualPort) {
  if (!origin) return true;
  const configured = process.env.HARMONY_PREVIEW_ORIGIN;
  if (configured) return origin === configured;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      Number(parsed.port || 80) === actualPort;
  } catch {
    return false;
  }
}

async function handleSocketMessage(socket, deviceAdapter, sessions, message) {
  let action;
  try { action = JSON.parse(message.toString()); } catch { throw new Error('invalid_message'); }
  if (action.type === 'build-run') {
    const result = await buildAndRun(deviceAdapter, { projectPath, deviceId: action.deviceId },
      (text) => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'run-status', text })); });
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'run-status', text: 'Running', ...result }));
    return;
  }
  if (action.type === 'tap') {
    if (!action.deviceId) throw new Error('deviceId is required');
    socket.send(JSON.stringify({ type: 'tap-ack', ...(await deviceAdapter.tap(action)) }));
    return;
  }
  if (action.type === 'swipe') {
    socket.send(JSON.stringify({ type: 'swipe-ack', ...(await deviceAdapter.swipe(action)) }));
    return;
  }
  if (action.type === 'long-press') {
    socket.send(JSON.stringify({ type: 'long-press-ack', ...(await deviceAdapter.longPress(action)) }));
    return;
  }
  if (action.type === 'key-event') {
    socket.send(JSON.stringify({ type: 'key-event-ack', ...(await deviceAdapter.keyEvent(action)) }));
    return;
  }
  if (action.type === 'input-text') {
    socket.send(JSON.stringify({ type: 'input-text-ack', ...(await deviceAdapter.inputText(action)) }));
    return;
  }
  if (action.type === 'device-list') {
    socket.send(JSON.stringify({ type: 'devices', devices: await deviceAdapter.listTargets() }));
    return;
  }
  if (action.type === 'screenshot') {
    const frame = await deviceAdapter.capture(action);
    sendFrame(socket, frame, action.deviceId);
    return;
  }
  if (action.type === 'preview-start') {
    if (!action.deviceId) throw new Error('deviceId is required');
    startPolling(socket, deviceAdapter, sessions, action.deviceId);
    socket.send(JSON.stringify({ type: 'preview-status', running: true, deviceId: action.deviceId, pollMs }));
    return;
  }
  if (action.type === 'preview-stop') {
    stopPolling(socket, sessions);
    socket.send(JSON.stringify({ type: 'preview-status', running: false }));
  }
}

function sendFrame(socket, frame, deviceId, session) {
  if (socket.readyState !== 1) return;
  const hash = createHash('sha1').update(frame.data).digest('hex');
  if (session?.lastHash === hash) return false;
  if (session) session.lastHash = hash;
  socket.send(JSON.stringify({ type: 'frame-meta', mimeType: frame.mimeType, deviceId }));
  socket.send(frame.data);
  return true;
}

function startPolling(socket, deviceAdapter, sessions, deviceId) {
  stopPolling(socket, sessions);
  const session = { stopped: false, timer: null, connected: true, lastHash: null };
  sessions.set(socket, session);
  const poll = async () => {
    if (session.stopped || socket.readyState !== 1) return;
    try {
      const changed = sendFrame(socket, await deviceAdapter.capture({ deviceId }), deviceId, session);
      if (!session.connected) {
        session.connected = true;
        socket.send(JSON.stringify({ type: 'preview-status', running: true, deviceId, reconnecting: false }));
      }
      socket.send(JSON.stringify({ type: 'preview-tick', at: Date.now(), changed }));
    } catch (error) {
      if (session.connected) {
        session.connected = false;
        socket.send(JSON.stringify({ type: 'preview-status', running: false, deviceId, reason: 'device-disconnected' }));
      }
      const devices = await deviceAdapter.listTargets().catch(() => []);
      socket.send(JSON.stringify({ type: 'devices', devices }));
    }
    if (!session.stopped) session.timer = setTimeout(poll, pollMs);
  };
  poll();
}

function stopPolling(socket, sessions) {
  const session = sessions.get(socket);
  if (!session) return;
  session.stopped = true;
  if (session.timer) clearTimeout(session.timer);
  sessions.delete(socket);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(port, host, () => {
    console.log(`HarmonyOS Preview listening at http://${host}:${port}`);
  });
}
