#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDeviceAdapter } from '../src/device.mjs';

const args = process.argv.slice(2);
const projectIndex = args.indexOf('--project');
const projectPath = projectIndex >= 0 ? args[projectIndex + 1] : process.env.HARMONY_PROJECT;
const build = args.includes('--build');
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/check-codex.mjs [--project <HarmonyOS project>] [--device <device ID>] [--build]');
  process.exit(0);
}
if (!projectPath) throw new Error('--project or HARMONY_PROJECT is required');
if (projectIndex >= 0 && (!args[projectIndex + 1] || args[projectIndex + 1].startsWith('-'))) throw new Error('--project requires a path');

const deviceIndex = args.indexOf('--device');
const requestedDevice = deviceIndex >= 0 ? args[deviceIndex + 1] : undefined;
if (deviceIndex >= 0 && (!requestedDevice || requestedDevice.startsWith('-'))) throw new Error('--device requires an ID');

const adapter = createDeviceAdapter();
const devices = await adapter.listTargets();
if (!devices.length) throw new Error('No HarmonyOS device or emulator is connected');
const deviceId = requestedDevice ?? devices[0];
if (!devices.includes(deviceId)) throw new Error(`Device is not connected: ${deviceId}`);

const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/harmonyos-preview.mjs', import.meta.url)), '--mcp'], {
  cwd: process.cwd(), env: { ...process.env, HARMONY_PROJECT: projectPath, HARMONY_PREVIEW_PORT: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
});
const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
let id = 0;
async function request(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  const line = await replies.next();
  if (line.done) throw new Error(`MCP process exited unexpectedly: ${stderr}`);
  const reply = JSON.parse(line.value);
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  if (reply.result?.isError) throw new Error(`${method}: ${reply.result.content?.[0]?.text ?? 'tool failed'}`);
  return reply.result;
}

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harmonyos-preview-check', version: '0.1.0' } });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const listed = JSON.parse((await request('tools/call', { name: 'list_devices' })).content[0].text).devices;
  assert.ok(listed.includes(deviceId), `MCP did not report ${deviceId}`);
  if (build) await request('tools/call', { name: 'build_run', arguments: { deviceId } });
  const started = JSON.parse((await request('tools/call', { name: 'preview_start', arguments: { deviceId } })).content[0].text);
  assert.equal(new URL(started.previewUrl).searchParams.get('deviceId'), deviceId);
  assert.equal((await fetch(started.previewUrl)).status, 200);
  const capture = await request('tools/call', { name: 'capture', arguments: { deviceId } });
  assert.equal(capture.content[0].type, 'image');
  const imageBytes = Buffer.from(capture.content[0].data, 'base64').length;
  assert.ok(imageBytes > 1000, `Screenshot is too small: ${imageBytes} bytes`);
  await request('tools/call', { name: 'preview_stop', arguments: { sessionId: started.sessionId } });
  console.log(JSON.stringify({ check: 'codex: ok', deviceId, sessionId: started.sessionId, imageBytes, built: build }));
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
}
