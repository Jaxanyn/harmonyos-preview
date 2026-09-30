import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const host = process.env.HARMONY_PREVIEW_HOST ?? '127.0.0.1';
const port = Number(process.env.HARMONY_PREVIEW_PORT ?? 4100);

export function createPreviewServer() {
  return createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ name: 'harmonyos-preview', status: 'ok' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(port, host, () => {
    console.log(`HarmonyOS Preview listening at http://${host}:${port}`);
  });
}
