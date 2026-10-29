import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flattenLayout, layoutWarnings, matchesSelector, requireTapTarget, validateSelector } from './layout.mjs';
import { tagError, toDiagnostic } from './diagnostics.mjs';

const runtimeDirectory = fileURLToPath(new URL('../.runtime', import.meta.url));
const configuredTimeoutMs = Number(process.env.HARMONY_PREVIEW_HDC_TIMEOUT_MS ?? 15000);
const defaultTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 15000;

export function createDeviceAdapter({ command = process.env.HDC ?? 'hdc', runtime = runCommand, timeoutMs = defaultTimeoutMs, directory = runtimeDirectory } = {}) {
  const commandTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
  let captures = Promise.resolve();
  async function hdc(args, { timeoutMs: callTimeoutMs = commandTimeoutMs, deadline = Infinity, errorCode = 'HDC_FAILED', stage = 'hdc', probe = true, signal } = {}) {
    const remaining = deadline - performance.now();
    try {
      if (signal?.aborted) throw abortError();
      if (remaining <= 0) throw deadlineError(stage, errorCode);
      const result = await awaitWithAbort(runtime(command, args, { timeoutMs: Math.min(callTimeoutMs, remaining), signal }), signal);
      if (hdcFailed(result)) {
        const error = tagError(Object.assign(new Error(result.stderr.trim() || result.stdout.trim() || 'HDC command failed'), { exitCode: result.code }), result.code === 124 ? 'HDC_TIMEOUT' : errorCode, stage);
        if (result.code === 124 && remaining <= callTimeoutMs) error.code = 'WAIT_TIMEOUT';
        throw error;
      }
      if (performance.now() >= deadline) throw deadlineError(stage, errorCode);
      return result;
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw abortError();
      const tagged = tagError(error, error.code === 'ENOENT' ? 'HDC_UNAVAILABLE' : errorCode, stage);
      tagged.deviceId ??= args[0] === '-t' ? args[1] : null;
      const probeBudget = Math.min(1000, commandTimeoutMs, deadline - performance.now());
      if (probe && args[0] === '-t' && probeBudget > 0 && !['HDC_TIMEOUT', 'HDC_UNAVAILABLE'].includes(tagged.errorCode) && tagged.code !== 'WAIT_TIMEOUT') {
        try {
          const listed = await awaitWithAbort(runtime(command, ['list', 'targets'], { timeoutMs: probeBudget, signal }), signal);
          if (!hdcFailed(listed) && !parseTargets(listed.stdout).includes(args[1])) tagged.errorCode = 'DEVICE_OFFLINE';
        } catch {}
      }
      throw tagged;
    }
  }

  async function listTargets(_options = {}) {
    const result = await hdc(['list', 'targets'], { ..._options, stage: 'device_list', probe: false });
    return parseTargets(result.stdout);
  }

  function capture(options, { timeoutMs: budgetMs, signal } = {}) {
    // Keep screenshot transfers ordered across browser polling and MCP captures.
    const deadline = budgetMs === undefined ? Infinity : performance.now() + budgetMs;
    let started = false;
    let timer;
    const next = captures.then(() => {
      if (signal?.aborted) throw abortError();
      started = true;
      clearTimeout(timer);
      return captureFrame(options, { deadline, signal });
    });
    captures = next.catch(() => {});
    if (!Number.isFinite(deadline)) return next;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => { if (!settled) { settled = true; reject(abortError()); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (!started && !settled) { settled = true; reject(Object.assign(deadlineError('capture_queue', 'CAPTURE_FAILED'), { deviceId: options?.deviceId ?? null })); }
      }, Math.max(1, deadline - performance.now()));
      next.then((value) => { if (!settled) { settled = true; resolve(value); } }, (error) => { if (!settled) { settled = true; reject(error); } }).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      });
    });
  }

  async function captureFrame({ deviceId } = {}, { deadline = Infinity, signal } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (signal?.aborted) throw abortError();
    if (performance.now() >= deadline) throw Object.assign(deadlineError('capture_queue', 'CAPTURE_FAILED'), { deviceId });
    try { mkdirSync(directory, { recursive: true }); } catch (error) { throw tagError(error, 'CAPTURE_FAILED', 'capture'); }
    const captureId = randomUUID();
    const remote = `/data/local/tmp/harmonyos-preview-${process.pid}-${captureId}.jpeg`;
    const local = join(directory, `capture-${process.pid}-${captureId}.jpeg`);
    let stage = 'capture';
    let frameReady = false;
    try {
      await hdc(['-t', deviceId, 'shell', 'snapshot_display', '-f', remote], { deadline, signal, errorCode: 'CAPTURE_FAILED', stage });
      stage = 'capture_transfer';
      await hdc(['-t', deviceId, 'file', 'recv', remote, local], { deadline, signal, errorCode: 'CAPTURE_FAILED', stage });
      stage = 'capture_read';
      const frame = { mimeType: 'image/jpeg', data: readFileSync(local) };
      frameReady = true;
      return frame;
    } catch (error) {
      throw tagError(error, 'CAPTURE_FAILED', stage);
    } finally {
      try { unlinkSync(local); } catch {}
      const cleanup = hdc(['-t', deviceId, 'shell', 'rm', '-f', remote], { timeoutMs: Math.min(commandTimeoutMs, 2000), stage: 'capture_cleanup', probe: false }).catch(() => {});
      if (!frameReady) await cleanup;
    }
  }

  async function readLayout({ deviceId, bundleName } = {}, { deadline = Infinity, signal } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (signal?.aborted) throw abortError();
    validateBundleName(bundleName);
    try { mkdirSync(directory, { recursive: true }); } catch (error) { throw tagError(error, 'LAYOUT_UNAVAILABLE', 'layout_dump'); }
    const layoutId = randomUUID();
    const remote = `/data/local/tmp/harmonyos-preview-layout-${process.pid}-${layoutId}.json`;
    const local = join(directory, `layout-${process.pid}-${layoutId}.json`);
    let stage = 'layout_dump';
    try {
      const args = ['-t', deviceId, 'shell', 'uitest', 'dumpLayout', '-p', remote];
      if (bundleName) args.push('-b', bundleName);
      await hdc(args, { deadline, signal, errorCode: 'LAYOUT_UNAVAILABLE', stage });
      stage = 'layout_transfer';
      await hdc(['-t', deviceId, 'file', 'recv', remote, local], { deadline, signal, errorCode: 'LAYOUT_UNAVAILABLE', stage });
      stage = 'layout_parse';
      let layout;
      try { layout = JSON.parse(readFileSync(local, 'utf8').replace(/^\uFEFF/, '')); } catch (error) {
        throw Object.assign(new Error('device UI hierarchy is not valid JSON'), { cause: toDiagnostic(error).cause });
      }
      return { nodes: flattenLayout(layout), observedAt: Date.now(), deviceId };
    } catch (error) {
      throw tagError(error, 'LAYOUT_UNAVAILABLE', stage);
    } finally {
      try { unlinkSync(local); } catch {}
      await hdc(['-t', deviceId, 'shell', 'rm', '-f', remote], { timeoutMs: Math.min(commandTimeoutMs, 2000), stage: 'layout_cleanup', probe: false }).catch(() => {});
    }
  }

  async function observe({ deviceId, bundleName, maxNodes = 200 } = {}, options = {}) {
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 1000) throw new Error('maxNodes must be an integer from 1 to 1000');
    const result = await readLayout({ deviceId, bundleName }, options);
    return { ...result, nodes: result.nodes.slice(0, maxNodes), totalNodes: result.nodes.length, truncated: result.nodes.length > maxNodes, warnings: [...layoutWarnings] };
  }

  async function find({ deviceId, bundleName, selector, limit = 20 } = {}, options = {}) {
    validateSelector(selector);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
    const result = await readLayout({ deviceId, bundleName }, options);
    const matches = result.nodes.filter((node) => matchesSelector(node, selector));
    return { deviceId, observedAt: result.observedAt, matches: matches.slice(0, limit), totalMatches: matches.length, truncated: matches.length > limit, warnings: [...layoutWarnings] };
  }

  async function waitFor({ deviceId, bundleName, selector, state = 'present', timeoutMs = 5000, intervalMs = 500 } = {}, { signal } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    validateBundleName(bundleName);
    validateSelector(selector);
    if (!['present', 'absent'].includes(state)) throw new Error('state must be present or absent');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('timeoutMs must be an integer from 1 to 30000');
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 5000) throw new Error('intervalMs must be an integer from 100 to 5000');
    const startedAt = performance.now();
    const deadline = startedAt + timeoutMs;
    let attempts = 0;
    let lastObservation = null;
    let timeoutCause;
    const result = (status, error) => ({ deviceId, selector, state, status, attempts,
      elapsedMs: Math.round(performance.now() - startedAt), lastObservation, warnings: [...layoutWarnings],
      ...(error ? toDiagnostic(error, { deviceId, elapsedMs: performance.now() - startedAt, stage: 'wait_for' }) : {}) });
    while (performance.now() < deadline) {
      if (signal?.aborted) throw abortError();
      attempts += 1;
      try {
        const observed = await readLayout({ deviceId, bundleName }, { deadline, signal });
        const matches = observed.nodes.filter((node) => matchesSelector(node, selector));
        lastObservation = { observedAt: observed.observedAt, nodes: observed.nodes.slice(0, 200),
          totalNodes: observed.nodes.length, truncated: observed.nodes.length > 200,
          matches: matches.slice(0, 20), totalMatches: matches.length, matchesTruncated: matches.length > 20 };
        if (performance.now() >= deadline) break;
        if (state === 'present' ? matches.length > 0 : observed.nodes.length > 0 && matches.length === 0) return result('matched');
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw abortError();
        if (error.code === 'WAIT_TIMEOUT') { timeoutCause = error; break; }
        return result('observation_failed', error);
      }
      const remaining = deadline - performance.now();
      if (remaining > 0) await abortableDelay(Math.min(intervalMs, remaining), signal);
    }
    const error = tagError(Object.assign(new Error(`Timed out waiting for selector to be ${state}${lastObservation?.totalNodes === 0 ? '; an empty hierarchy cannot establish absence' : ''}`),
      { code: 'WAIT_TIMEOUT', ...(timeoutCause ? { cause: toDiagnostic(timeoutCause).cause } : {}) }), 'WAIT_TIMEOUT', 'wait_for');
    return result('timeout', error);
  }

  async function install({ deviceId, hapPath } = {}, { signal } = {}) {
    if (!deviceId || !hapPath) throw new Error('deviceId and hapPath are required');
    await hdc(['-t', deviceId, 'install', '-r', hapPath], { signal, errorCode: 'BUILD_FAILED', stage: 'install' });
    return { deviceId, hapPath };
  }

  async function launch({ deviceId, bundleName, ability, moduleName } = {}, { signal } = {}) {
    if (!deviceId || !bundleName || !ability) throw new Error('deviceId, bundleName and ability are required');
    const args = ['-t', deviceId, 'shell', 'aa', 'start', '-b', bundleName, '-a', ability];
    if (moduleName) args.push('-m', moduleName);
    await hdc(args, { signal, errorCode: 'BUILD_FAILED', stage: 'launch' });
    return { deviceId, bundleName, ability, ...(moduleName ? { moduleName } : {}) };
  }

  async function tap({ deviceId, x, y } = {}, { signal } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new Error('x and y must be non-negative finite numbers');
    await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', 'click', String(Math.round(x)), String(Math.round(y))], { signal, errorCode: 'ACTION_FAILED', stage: 'tap' });
    return { deviceId, x: Math.round(x), y: Math.round(y) };
  }

  async function tapElement({ deviceId, bundleName, selector } = {}, options = {}) {
    const found = await find({ deviceId, bundleName, selector, limit: 2 }, options);
    const target = requireTapTarget(found);
    await tap({ deviceId, x: target.center.x, y: target.center.y }, options);
    return { deviceId, selector, observedAt: found.observedAt, target, action: 'tap', verified: false };
  }

  async function swipe({ deviceId, fromX, fromY, toX, toY, velocity = 600 } = {}, { signal } = {}) {
    const points = [fromX, fromY, toX, toY];
    if (!deviceId) throw new Error('deviceId is required');
    if (points.some((point) => !Number.isFinite(point) || point < 0)) throw new Error('swipe coordinates must be non-negative finite numbers');
    if (!Number.isInteger(velocity) || velocity < 200 || velocity > 40000) throw new Error('velocity must be an integer from 200 to 40000');
    await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', 'swipe',
      ...points.map((point) => String(Math.round(point))), String(velocity)], { signal, errorCode: 'ACTION_FAILED', stage: 'swipe' });
    return { deviceId, fromX: Math.round(fromX), fromY: Math.round(fromY), toX: Math.round(toX), toY: Math.round(toY), velocity };
  }

  async function longPress({ deviceId, x, y } = {}, { signal } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (![x, y].every((point) => Number.isFinite(point) && point >= 0)) throw new Error('long press coordinates must be non-negative finite numbers');
    await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', 'longClick', String(Math.round(x)), String(Math.round(y))], { signal, errorCode: 'ACTION_FAILED', stage: 'long_press' });
    return { deviceId, x: Math.round(x), y: Math.round(y) };
  }

  async function keyEvent({ deviceId, key = 'Back' } = {}, { signal } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (!['Back', 'Home', 'Power'].includes(key)) throw new Error('key must be Back, Home or Power');
    await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', 'keyEvent', key], { signal, errorCode: 'ACTION_FAILED', stage: 'key_event' });
    return { deviceId, key };
  }

  async function inputText({ deviceId, text, x, y } = {}, { signal } = {}) {
    if (!deviceId) throw new Error('deviceId is required');
    if (typeof text !== 'string' || !text) throw new Error('text must be a non-empty string');
    const hasPoint = x !== undefined || y !== undefined;
    if (hasPoint && ![x, y].every((point) => Number.isFinite(point) && point >= 0)) throw new Error('input coordinates must be provided together');
    const args = hasPoint
      ? ['inputText', String(Math.round(x)), String(Math.round(y)), text]
      : ['text', text];
    await hdc(['-t', deviceId, 'shell', 'uitest', 'uiInput', ...args], { signal, errorCode: 'ACTION_FAILED', stage: 'input_text' });
    return { deviceId, text, ...(hasPoint ? { x: Math.round(x), y: Math.round(y) } : {}) };
  }

  return { listTargets, capture, observe, find, waitFor, install, launch, tap, tapElement, swipe, longPress, keyEvent, inputText };
}

function deadlineError(stage, errorCode) {
  return tagError(Object.assign(new Error('Operation timed out'), { code: 'WAIT_TIMEOUT' }), errorCode, stage);
}

function parseTargets(stdout) {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== '[Empty]');
}

function hdcFailed(result) {
  return result.code !== 0 || /^\s*\[Fail\]/im.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

function validateBundleName(bundleName) {
  if (bundleName !== undefined && (typeof bundleName !== 'string' || bundleName.length > 255 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(bundleName))) {
    throw new Error('bundleName must be a valid application bundle name');
  }
}

export function runCommand(command, args, { timeoutMs = defaultTimeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const child = spawn(command, args, { windowsHide: true, signal });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminating = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      stderr += `command timed out after ${timeoutMs}ms`;
      terminating = true;
      terminateProcessTree(child).finally(() => {
        if (settled) return;
        settled = true;
        resolve({ code: 124, stdout, stderr });
      });
    }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!settled && !terminating) { settled = true; resolve({ code: code ?? 1, stdout, stderr }); }
    });
  });
}

function abortableDelay(timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer;
    const done = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(abortError()); };
    timer = setTimeout(done, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  return Object.assign(new Error('Operation cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(abortError()); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function terminateProcessTree(child) {
  if (process.platform === 'win32' && child.pid) return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', resolve);
    killer.once('close', resolve);
  });
  try { child.kill(); } catch {}
  return Promise.resolve();
}
