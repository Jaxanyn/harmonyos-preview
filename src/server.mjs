import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const host = process.env.HARMONY_PREVIEW_HOST ?? '127.0.0.1';
const port = Number(process.env.HARMONY_PREVIEW_PORT ?? 4100);

const previewPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HarmonyOS Preview</title>
<style>
  :root{color-scheme:dark;font:14px system-ui,sans-serif}body{margin:0;min-height:100vh;background:#0c0f14;color:#f4f6fa;display:grid;grid-template-columns:240px 1fr}
  aside{padding:20px;background:#151a22;border-right:1px solid #2a303b}h1{font-size:18px;margin:0 0 8px}p{color:#aeb8c8;line-height:1.5}#status{color:#75e0aa}
  main{display:grid;place-items:center;min-width:0;padding:24px}#stage{max-width:100%;max-height:calc(100vh - 48px);background:#000;box-shadow:0 16px 50px #0009;cursor:crosshair}
</style></head><body><aside><h1>HarmonyOS Preview</h1><p id="status">Connecting…</p><p>Static frame mode</p></aside><main><img id="stage" alt="HarmonyOS preview frame"></main>
<script>
const stage=document.querySelector('#stage');const status=document.querySelector('#status');
const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/preview');let frameMime='image/png';
socket.binaryType='blob';
socket.onopen=()=>status.textContent='Connected';
socket.onclose=()=>status.textContent='Disconnected';
socket.onerror=()=>status.textContent='Connection error';
socket.onmessage=event=>{if(typeof event.data==='string'){const message=JSON.parse(event.data);if(message.type==='status')status.textContent=message.text;if(message.type==='frame-meta')frameMime=message.mimeType;return;}const old=stage.src;stage.onload=()=>{if(old.startsWith('blob:'))URL.revokeObjectURL(old)};stage.src=URL.createObjectURL(new Blob([event.data],{type:frameMime}))};
stage.onclick=event=>{const box=stage.getBoundingClientRect();const x=(event.clientX-box.left)*stage.naturalWidth/box.width;const y=(event.clientY-box.top)*stage.naturalHeight/box.height;socket.send(JSON.stringify({type:'tap',x:Math.round(x),y:Math.round(y)}))};
</script></body></html>`;

const staticFrame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920"><rect width="1080" height="1920" fill="#10151c"/><rect x="48" y="70" width="984" height="1780" rx="42" fill="#1b2430"/><text x="540" y="850" text-anchor="middle" fill="#f4f6fa" font-size="56" font-family="system-ui">HarmonyOS Preview</text><text x="540" y="940" text-anchor="middle" fill="#9eabbc" font-size="34" font-family="system-ui">Static frame</text><circle cx="540" cy="1070" r="54" fill="#4f7cff"/></svg>`);

export function createPreviewServer() {
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
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  const sockets = new WebSocketServer({ server, path: '/preview' });
  sockets.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'status', text: 'Preview connected' }));
    socket.send(JSON.stringify({ type: 'frame-meta', mimeType: 'image/svg+xml', width: 1080, height: 1920 }));
    socket.send(staticFrame);
    socket.on('message', (message) => {
      try {
        const action = JSON.parse(message.toString());
        if (action.type === 'tap') {
          socket.send(JSON.stringify({ type: 'tap-ack', x: action.x, y: action.y }));
        }
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'invalid_message' }));
      }
    });
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(port, host, () => {
    console.log(`HarmonyOS Preview listening at http://${host}:${port}`);
  });
}
