import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtimeDirectory = fileURLToPath(new URL('../.runtime', import.meta.url));

export function createDeviceAdapter({ command = process.env.HDC ?? 'hdc', runtime = runCommand } = {}) {
  let captures = Promise.resolve();
  async function hdc(args) {
    return runtime(command, args);
  }

  async function listTargets() {
    const result = await hdc(['list', 'targets']);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'hdc list targets failed');
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== '[Empty]');
  }

  function capture(options) {
    // Browser polling and MCP share one screenshot file; serialize to prevent mixed frames.
    const next = captures.then(() => captureFrame(options));
    captures = next.catch(() => {});
    return next;
  }

  async function captureFrame({ deviceId, directory = runtimeDirectory, fileName = 'latest.jpeg' } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    mkdirSync(directory, { recursive: true });
    const remote = `/data/local/tmp/harmonyos-preview-${process.pid}.jpeg`;
    const local = join(directory, fileName);
    const shot = await hdc(['-t', deviceId, 'shell', 'snapshot_display', '-f', remote]);
    if (shot.code !== 0) throw new Error(shot.stderr.trim() || 'device screenshot failed');
    const recv = await hdc(['-t', deviceId, 'file', 'recv', remote, local]);
    if (recv.code !== 0) throw new Error(recv.stderr.trim() || 'screenshot download failed');
    return { mimeType: 'image/jpeg', data: readFileSync(local), path: local };
  }

  async function install({ deviceId, hapPath } = {}) {
    if (!deviceId || !hapPath) throw new Error('deviceId and hapPath are required');
    const result = await hdc(['-t', deviceId, 'install', '-r', hapPath]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'HAP install failed');
    return { deviceId, hapPath };
  }

  async function launch({ deviceId, bundleName, ability } = {}) {
    if (!deviceId || !bundleName || !ability) throw new Error('deviceId, bundleName and ability are required');
    const result = await hdc(['-t', deviceId, 'shell', 'aa', 'start', '-b', bundleName, '-a', ability]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'application launch failed');
    return { deviceId, bundleName, ability };
  }

  async function tap({ deviceId, x, y } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new Error('x and y must be non-negative finite numbers');
    const result = await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', 'click', String(Math.round(x)), String(Math.round(y))]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'device tap failed');
    return { deviceId, x: Math.round(x), y: Math.round(y) };
  }

  return { listTargets, capture, install, launch, tap };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
