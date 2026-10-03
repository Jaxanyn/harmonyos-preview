import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtimeDirectory = fileURLToPath(new URL('../.runtime', import.meta.url));
const configuredTimeoutMs = Number(process.env.HARMONY_PREVIEW_HDC_TIMEOUT_MS ?? 15000);
const defaultTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 15000;

export function createDeviceAdapter({ command = process.env.HDC ?? 'hdc', runtime = runCommand, timeoutMs = defaultTimeoutMs } = {}) {
  const commandTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
  let captures = Promise.resolve();
  async function hdc(args, { timeoutMs: callTimeoutMs = commandTimeoutMs } = {}) {
    return runtime(command, args, { timeoutMs: callTimeoutMs });
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

  async function captureFrame({ deviceId, directory = runtimeDirectory, fileName } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    mkdirSync(directory, { recursive: true });
    const captureId = randomUUID();
    const remote = `/data/local/tmp/harmonyos-preview-${process.pid}-${captureId}.jpeg`;
    const local = join(directory, fileName ?? `capture-${process.pid}-${captureId}.jpeg`);
    try {
      const shot = await hdc(['-t', deviceId, 'shell', 'snapshot_display', '-f', remote]);
      if (shot.code !== 0) throw new Error(shot.stderr.trim() || 'device screenshot failed');
      const recv = await hdc(['-t', deviceId, 'file', 'recv', remote, local]);
      if (recv.code !== 0) throw new Error(recv.stderr.trim() || 'screenshot download failed');
      return { mimeType: 'image/jpeg', data: readFileSync(local) };
    } finally {
      try { unlinkSync(local); } catch {}
      await hdc(['-t', deviceId, 'shell', 'rm', '-f', remote], { timeoutMs: Math.min(commandTimeoutMs, 2000) }).catch(() => {});
    }
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

  async function swipe({ deviceId, fromX, fromY, toX, toY, velocity = 600 } = {}) {
    const points = [fromX, fromY, toX, toY];
    if (!deviceId) throw new Error('deviceId is required');
    if (points.some((point) => !Number.isFinite(point) || point < 0)) throw new Error('swipe coordinates must be non-negative finite numbers');
    if (!Number.isInteger(velocity) || velocity < 200 || velocity > 40000) throw new Error('velocity must be an integer from 200 to 40000');
    const result = await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', 'swipe',
      ...points.map((point) => String(Math.round(point))), String(velocity)]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'device swipe failed');
    return { deviceId, fromX: Math.round(fromX), fromY: Math.round(fromY), toX: Math.round(toX), toY: Math.round(toY), velocity };
  }

  async function longPress({ deviceId, x, y } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (![x, y].every((point) => Number.isFinite(point) && point >= 0)) throw new Error('long press coordinates must be non-negative finite numbers');
    const result = await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', 'longClick', String(Math.round(x)), String(Math.round(y))]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'device long press failed');
    return { deviceId, x: Math.round(x), y: Math.round(y) };
  }

  async function keyEvent({ deviceId, key = 'Back' } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (!['Back', 'Home', 'Power'].includes(key)) throw new Error('key must be Back, Home or Power');
    const result = await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', 'keyEvent', key]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'device key event failed');
    return { deviceId, key };
  }

  async function inputText({ deviceId, text, x, y } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (typeof text !== 'string' || !text) throw new Error('text must be a non-empty string');
    const hasPoint = x !== undefined || y !== undefined;
    if (hasPoint && ![x, y].every((point) => Number.isFinite(point) && point >= 0)) throw new Error('input coordinates must be provided together');
    const args = hasPoint
      ? ['inputText', String(Math.round(x)), String(Math.round(y)), text]
      : ['text', text];
    const result = await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', ...args]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'device text input failed');
    return { deviceId, text, ...(hasPoint ? { x: Math.round(x), y: Math.round(y) } : {}) };
  }

  return { listTargets, capture, install, launch, tap, swipe, longPress, keyEvent, inputText };
}

export function runCommand(command, args, { timeoutMs = defaultTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      stderr += `command timed out after ${timeoutMs}ms`;
      terminateProcessTree(child);
      settled = true;
      resolve({ code: 124, stdout, stderr });
    }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!settled) { settled = true; resolve({ code: code ?? 1, stdout, stderr }); }
    });
  });
}

function terminateProcessTree(child) {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => {});
    killer.unref();
  }
  try { child.kill(); } catch {}
}
