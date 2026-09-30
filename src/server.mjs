import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createDeviceAdapter } from './device.mjs';

const host = process.env.HARMONY_PREVIEW_HOST ?? '127.0.0.1';
const port = Number(process.env.HARMONY_PREVIEW_PORT ?? 4100);

const previewPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HarmonyOS Preview</title>
<style>
  :root{color-scheme:dark;font:14px system-ui,sans-serif}body{margin:0;min-height:100vh;background:#0c0f14;color:#f4f6fa;display:grid;grid-template-columns:240px 1fr}
  aside{padding:20px;background:#151a22;border-right:1px solid #2a303b}h1{font-size:18px;margin:0 0 8px}p{color:#aeb8c8;line-height:1.5}#status{color:#75e0aa}
  main{display:grid;place-items:center;min-width:0;padding:24px}#stage{max-width:100%;max-height:calc(100vh - 48px);background:#000;box-shadow:0 16px 50px #0009;cursor:crosshair}
</style></head><body><aside><h1>HarmonyOS Preview</h1><p id="status">Connecting…</p><select id="devices"><option value="">No device selected</option></select><button id="refresh">Refresh devices</button><button id="shot">Capture screenshot</button><button id="start">Start preview</button><button id="stop">Stop preview</button><p>Device frame polling</p></aside><main><img id="stage" alt="HarmonyOS preview frame"></main>
<script>
const stage=document.querySelector('#stage');const status=document.querySelector('#status');const devices=document.querySelector('#devices');let deviceId='';
const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/preview');let frameMime='image/png';
socket.binaryType='blob';
socket.onopen=()=>status.textContent='Connected';
socket.onclose=()=>status.textContent='Disconnected';
socket.onerror=()=>status.textContent='Connection error';
socket.onmessage=event=>{if(typeof event.data==='string'){const message=JSON.parse(event.data);if(message.type==='status')status.textContent=message.text;if(message.type==='frame-meta')frameMime=message.mimeType;if(message.type==='devices'){devices.replaceChildren(...message.devices.map(id=>new Option(id,id)));deviceId=message.devices[0]??'';if(!deviceId)status.textContent='No device connected';}if(message.type==='tap-ack')status.textContent='Tapped '+message.x+','+message.y;if(message.type==='error')status.textContent=message.error;return;}const old=stage.src;stage.onload=()=>{if(old.startsWith('blob:'))URL.revokeObjectURL(old)};stage.src=URL.createObjectURL(new Blob([event.data],{type:frameMime}))};
document.querySelector('#refresh').onclick=()=>socket.send(JSON.stringify({type:'device-list'}));document.querySelector('#shot').onclick=()=>{if(deviceId)socket.send(JSON.stringify({type:'screenshot',deviceId}));};document.querySelector('#start').onclick=()=>{if(deviceId)socket.send(JSON.stringify({type:'preview-start',deviceId}));};document.querySelector('#stop').onclick=()=>socket.send(JSON.stringify({type:'preview-stop'}));devices.onchange=()=>{deviceId=devices.value};
stage.onclick=event=>{if(!deviceId){status.textContent='Select a device first';return;}const box=stage.getBoundingClientRect();const x=(event.clientX-box.left)*stage.naturalWidth/box.width;const y=(event.clientY-box.top)*stage.naturalHeight/box.height;socket.send(JSON.stringify({type:'tap',deviceId,x:Math.round(x),y:Math.round(y)}))};
</script></body></html>`;

const staticFrame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920"><rect width="1080" height="1920" fill="#10151c"/><rect x="48" y="70" width="984" height="1780" rx="42" fill="#1b2430"/><text x="540" y="850" text-anchor="middle" fill="#f4f6fa" font-size="56" font-family="system-ui">HarmonyOS Preview</text><text x="540" y="940" text-anchor="middle" fill="#9eabbc" font-size="34" font-family="system-ui">Static frame</text><circle cx="540" cy="1070" r="54" fill="#4f7cff"/></svg>`);
const pollMs = Number(process.env.HARMONY_PREVIEW_POLL_MS ?? 500);

export function createPreviewServer({ deviceAdapter = createDeviceAdapter() } = {}) {
  const server = createServer((request, response) => {
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
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  const sockets = new WebSocketServer({ server, path: '/preview' });
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
  return server;
}

async function handleSocketMessage(socket, deviceAdapter, sessions, message) {
  let action;
  try { action = JSON.parse(message.toString()); } catch { throw new Error('invalid_message'); }
  if (action.type === 'tap') {
    if (!action.deviceId) throw new Error('deviceId is required');
    socket.send(JSON.stringify({ type: 'tap-ack', ...(await deviceAdapter.tap(action)) }));
    return;
  }
  if (action.type === 'device-list') {
    socket.send(JSON.stringify({ type: 'devices', devices: await deviceAdapter.listTargets() }));
    return;
  }
  if (action.type === 'screenshot') {
    const frame = await deviceAdapter.capture(action);
    sendFrame(socket, frame);
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

function sendFrame(socket, frame) {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify({ type: 'frame-meta', mimeType: frame.mimeType }));
  socket.send(frame.data);
}

function startPolling(socket, deviceAdapter, sessions, deviceId) {
  stopPolling(socket, sessions);
  const session = { stopped: false, timer: null };
  sessions.set(socket, session);
  const poll = async () => {
    if (session.stopped || socket.readyState !== 1) return;
    try {
      sendFrame(socket, await deviceAdapter.capture({ deviceId }));
      socket.send(JSON.stringify({ type: 'preview-tick', at: Date.now() }));
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', error: error.message }));
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
