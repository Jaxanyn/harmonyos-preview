import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startMcp } from '../src/mcp.mjs';
import { serverVersion, diagnosticsVersion, tagError, toDiagnostic } from '../src/diagnostics.mjs';

const input = new PassThrough();
const output = new PassThrough();
const responses = createInterface({ input: output })[Symbol.asyncIterator]();
let taps = 0;
let offline = false;
let captured = 0;
let frameData = Buffer.from([0xff, 0xd8, 0xff]);
let layoutError = false;
let layoutEmpty = false;
let layoutTruncated = false;
let layoutCalls = 0;
let waitStatus = 'matched';
let waitCalls = 0;
let captureOptions;
let deviceChecks = 0;
let discoveryError;
let tapError;
let tapElementError;
let tapElementCalls = 0;
const node = { id: 'search', text: '搜索', type: 'Button', clickable: true, enabled: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 50 }, center: { x: 50, y: 25 } };
const running = startMcp({ input, output, port: 0, projectPath: '', previewTimeoutMs: 200, deviceAdapter: {
  listTargets: async () => { deviceChecks += 1; if (discoveryError) throw discoveryError; return offline ? [] : ['test-device']; },
  capture: async ({ deviceId }, options) => {
    captured += 1;
    captureOptions = options;
    if (offline || deviceId === 'disconnected') throw tagError(new Error('device disconnected'), 'DEVICE_OFFLINE', 'capture');
    if (deviceId === 'png-device') return { mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
    return { mimeType: 'image/jpeg', data: frameData };
  },
  observe: async (args) => {
    layoutCalls += 1;
    if (layoutError) throw new Error('UITest layout unavailable');
    return { ...args, nodes: layoutEmpty ? [] : [node], totalNodes: layoutEmpty ? 0 : 1, truncated: layoutTruncated };
  },
  find: async (args) => {
    layoutCalls += 1;
    if (layoutError) throw new Error('UITest layout unavailable');
    return { deviceId: args.deviceId, matches: layoutEmpty ? [] : [node], totalMatches: layoutEmpty ? 0 : 1, truncated: false };
  },
  waitFor: async (args) => {
    waitCalls += 1;
    return { ...args, status: waitStatus, attempts: 2, elapsedMs: 100,
      lastObservation: { observedAt: Date.now(), nodes: [node], totalNodes: 1, truncated: false,
        matches: waitStatus === 'matched' ? [node] : [], totalMatches: waitStatus === 'matched' ? 1 : 0, matchesTruncated: false },
      warnings: [], ...(waitStatus === 'matched' ? {} : { error: waitStatus === 'timeout' ? 'Timed out waiting' : 'device disconnected' }) };
  },
  tap: async (args) => { if (tapError) throw tapError; taps += 1; frameData = Buffer.from('after-tap'); return args; },
  tapElement: async (args) => {
    tapElementCalls += 1;
    if (tapElementError) throw tapElementError;
    return { ...args, observedAt: Date.now(), target: node, action: 'tap', verified: false };
  },
  swipe: async (args) => args,
  longPress: async (args) => args,
  keyEvent: async (args) => args,
  inputText: async (args) => args
} });
let id = 0;
async function request(method, params) {
  input.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  const line = await responses.next();
  const reply = JSON.parse(line.value);
  assert.equal(reply.id, id);
  return reply;
}

let previewUrl;
let socket;
try {
  assert.equal((await request('tools/list')).error.code, -32600);
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result.capabilities, { tools: {}, resources: { read: true } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const listed = await request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['list_devices', 'capture', 'observe', 'find', 'wait_for', 'tap', 'tap_element', 'swipe', 'long_press', 'key_event', 'input_text', 'preview_frame', 'preview_action', 'preview_start', 'preview_stop', 'build_run', 'preview_info', 'preview_open', 'preview_panel']);
  const buildTool = listed.result.tools.find((tool) => tool.name === 'build_run');
  assert.equal(buildTool.inputSchema.properties.moduleName.pattern, '^[A-Za-z0-9_-]+$');
  assert.equal(buildTool.inputSchema.properties.artifactName.pattern, '^[A-Za-z0-9._-]+\\.hap$');
  const entrypoint = listed.result.tools.find((tool) => tool.name === 'preview_open');
  assert.deepEqual(entrypoint._meta, {
    ui: { resourceUri: 'ui://harmonyos-preview/app', visibility: ['app'] },
    'openai/ui': { entrypoints: [{ type: 'global' }] }
  });
  const resource = await request('resources/read', { uri: 'ui://harmonyos-preview/app' });
  assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(resource.result.contents[0].text.length < 128 * 1024, 'MCP App resource should stay small enough for host loading');
  assert.match(resource.result.contents[0].text, /HarmonyOS Preview/);
  assert.match(resource.result.contents[0].text, /ui\/initialize/);
  assert.deepEqual(resource.result.contents[0]._meta, { 'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen', 'inline'] } });
  assert.deepEqual((await request('tools/call', { name: 'preview_open', arguments: {} })).result.structuredContent, { app: 'harmonyos-preview' });
  const panel = listed.result.tools.find((tool) => tool.name === 'preview_panel');
  assert.equal(panel.title, '鸿蒙真机预览');
  assert.deepEqual(panel._meta, {
    ui: { resourceUri: 'ui://harmonyos-preview/app', visibility: ['model', 'app'] },
    'openai/ui': { entrypoints: [{ type: 'thread' }] }
  });
  assert.deepEqual((await request('tools/call', { name: 'preview_panel', arguments: {} })).result.structuredContent, { app: 'harmonyos-preview' });
  const previewFrameTool = listed.result.tools.find((tool) => tool.name === 'preview_frame');
  assert.deepEqual(previewFrameTool._meta, { ui: { visibility: ['app'] } });
  assert.equal(previewFrameTool.inputSchema.properties.waitMs.maximum, 5000);
  const previewActionTool = listed.result.tools.find((tool) => tool.name === 'preview_action');
  assert.deepEqual(previewActionTool._meta, { ui: { visibility: ['app'] } });
  assert.deepEqual((await request('ping')).result, {});
  const noProbe = (await request('tools/call', { name: 'preview_info' })).result.structuredContent;
  assert.equal(noProbe.deviceCheck.status, 'not_checked');
  assert.equal(deviceChecks, 0, 'session status must not silently probe HDC');
  assert.equal(noProbe.runtime.serverVersion, serverVersion);
  assert.equal(noProbe.runtime.diagnosticsVersion, diagnosticsVersion);
  assert.ok(Number.isFinite(Date.parse(noProbe.runtime.startedAt)));
  assert.match(noProbe.runtime.instanceId, /^[\da-f-]{36}$/);
  const connectedInfo = (await request('tools/call', { name: 'preview_info', arguments: { deviceId: 'test-device' } })).result.structuredContent;
  assert.equal(connectedInfo.connected, false, 'an online device does not imply a live preview frame');
  assert.equal(connectedInfo.deviceCheck.status, 'connected');
  assert.deepEqual(connectedInfo.runtime, noProbe.runtime, 'runtime identity must remain stable within the MCP instance');
  const missingInfo = (await request('tools/call', { name: 'preview_info', arguments: { deviceId: 'missing-device' } })).result;
  assert.equal(missingInfo.isError, undefined, 'device checks are embedded in the status report');
  assert.equal(missingInfo.structuredContent.deviceCheck.status, 'disconnected');
  assert.equal(missingInfo.structuredContent.deviceCheck.errorCode, 'DEVICE_OFFLINE');
  assert.equal(missingInfo.structuredContent.deviceCheck.deviceId, 'missing-device');
  discoveryError = tagError(Object.assign(new Error('hdc executable unavailable'), { code: 'ENOENT' }), 'HDC_UNAVAILABLE', 'device_list');
  const brokenHdc = (await request('tools/call', { name: 'preview_info', arguments: { deviceId: 'test-device' } })).result.structuredContent;
  assert.equal(brokenHdc.deviceCheck.status, 'error');
  assert.equal(brokenHdc.deviceCheck.errorCode, 'HDC_UNAVAILABLE');
  assert.equal(brokenHdc.deviceCheck.cause.code, 'ENOENT');
  const failedDiscovery = (await request('tools/call', { name: 'list_devices' })).result;
  assert.equal(failedDiscovery.isError, true);
  assert.equal(failedDiscovery.structuredContent.errorCode, 'HDC_UNAVAILABLE');
  assert.equal(failedDiscovery.structuredContent.deviceId, null);
  discoveryError = null;
  const devices = await request('tools/call', { name: 'list_devices' });
  assert.deepEqual(JSON.parse(devices.result.content[0].text), { devices: ['test-device'] });
  const image = await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(image.result.content[0], { type: 'image', mimeType: 'image/jpeg', data: '/9j/' });
  assertFreshImage(image.result, 'test-device');
  const observed = await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device', maxNodes: 20 } });
  assert.deepEqual(observed.result.structuredContent.nodes, [node]);
  const found = await request('tools/call', { name: 'find', arguments: { deviceId: 'test-device', selector: { text: '搜索', clickable: true }, limit: 3 } });
  assert.deepEqual(found.result.structuredContent.matches, [node]);
  for (const arguments_ of [
    { deviceId: 'test-device', selector: {} },
    { deviceId: 'test-device', selector: { unknown: 'value' } },
    { deviceId: 'test-device', selector: { id: 'search' }, x: 12, y: 24 },
    { deviceId: 'test-device', selector: { id: 'search' }, limit: 1 },
    { deviceId: 'test-device', selector: { id: 'search' }, bundleName: 'bad;bundle' }
  ]) {
    assert.equal((await request('tools/call', { name: 'tap_element', arguments: arguments_ })).error.code, -32602);
  }
  assert.equal(tapElementCalls, 0, 'invalid element arguments must never reach the adapter');
  const elementTap = (await request('tools/call', { name: 'tap_element', arguments: { deviceId: 'test-device', selector: { id: 'search' } } })).result;
  assert.equal(elementTap.isError, undefined);
  assert.equal(elementTap.structuredContent.action, 'tap');
  assert.equal(elementTap.structuredContent.verified, false);
  assert.deepEqual(elementTap.structuredContent.target, node);
  assert.equal(tapElementCalls, 1);
  for (const errorCode of ['ELEMENT_NOT_FOUND', 'ELEMENT_AMBIGUOUS', 'ELEMENT_NOT_ACTIONABLE', 'STALE_OBSERVATION']) {
    tapElementError = tagError(new Error('element precondition rejected'), errorCode, 'tap_element');
    const before = tapElementCalls;
    const refused = (await request('tools/call', { name: 'tap_element', arguments: { deviceId: 'test-device', selector: { id: 'search' } } })).result;
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.errorCode, errorCode);
    assert.equal(refused.structuredContent.stage, 'tap_element');
    assert.equal(refused.structuredContent.deviceId, 'test-device');
    assert.equal(refused.content[1].type, 'image');
    assert.equal(refused.structuredContent.screenshot.live, false);
    assert.equal(tapElementCalls, before + 1, 'rejected element taps must not be retried');
  }
  tapElementError = null;
  const capturesBeforeWait = captured;
  const waited = await request('tools/call', { name: 'wait_for', arguments: { deviceId: 'test-device', selector: { id: 'search', text: '搜索' } } });
  assert.equal(waited.result.structuredContent.status, 'matched');
  assert.equal(waited.result.isError, undefined);
  assert.equal(captured, capturesBeforeWait, 'a successful wait needs no fallback screenshot');
  for (const arguments_ of [
    { deviceId: 'test-device', selector: {} },
    { deviceId: 'test-device', selector: { path: 'outside' } },
    { deviceId: 'test-device', selector: { id: 'search' }, state: 'gone' },
    { deviceId: 'test-device', selector: { id: 'search' }, timeoutMs: 0 },
    { deviceId: 'test-device', selector: { id: 'search' }, timeoutMs: 30001 },
    { deviceId: 'test-device', selector: { id: 'search' }, timeoutMs: 1.5 },
    { deviceId: 'test-device', selector: { id: 'search' }, intervalMs: 99 },
    { deviceId: 'test-device', selector: { id: 'search' }, intervalMs: 5001 },
    { deviceId: 'test-device', selector: { id: 'search' }, bundleName: 'com..bad' },
    { deviceId: 'test-device', selector: { id: 'search' }, directory: 'outside' }
  ]) {
    assert.equal((await request('tools/call', { name: 'wait_for', arguments: arguments_ })).error.code, -32602);
  }
  assert.equal(waitCalls, 1, 'invalid wait arguments must not reach the adapter');
  waitStatus = 'timeout';
  const waitTimeout = await request('tools/call', { name: 'wait_for', arguments: { deviceId: 'test-device', selector: { id: 'missing' }, state: 'present', timeoutMs: 50 } });
  assert.equal(waitTimeout.result.isError, true);
  assert.equal(waitTimeout.result.structuredContent.status, 'timeout');
  assert.equal(waitTimeout.result.structuredContent.errorCode, 'WAIT_TIMEOUT');
  assert.equal(waitTimeout.result.structuredContent.stage, 'wait_for');
  assert.equal(waitTimeout.result.structuredContent.attempts, 2);
  assert.equal(waitTimeout.result.structuredContent.lastObservation.totalNodes, 1);
  assert.equal(waitTimeout.result.content[1].type, 'image');
  assert.equal(waitTimeout.result.structuredContent.screenshot.live, false);
  assert.deepEqual(captureOptions, { timeoutMs: 3000 }, 'failure evidence must have a bounded capture budget');
  waitStatus = 'observation_failed';
  offline = true;
  const waitOffline = await request('tools/call', { name: 'wait_for', arguments: { deviceId: 'test-device', selector: { id: 'search' }, state: 'absent' } });
  assert.equal(waitOffline.result.isError, true);
  assert.equal(waitOffline.result.structuredContent.status, 'observation_failed');
  assert.match(waitOffline.result.structuredContent.error, /disconnected/);
  assert.match(waitOffline.result.structuredContent.screenshotError, /disconnected/);
  assert.equal(waitOffline.result.structuredContent.errorCode, 'LAYOUT_UNAVAILABLE', 'an untagged layout error must not be guessed to be device offline');
  assert.equal(waitOffline.result.structuredContent.screenshotDiagnostic.errorCode, 'DEVICE_OFFLINE');
  assert.equal(waitOffline.result.structuredContent.screenshotDiagnostic.stage, 'capture');
  assert.deepEqual((await request('ping')).result, {}, 'a failed wait must leave the MCP responsive');
  offline = false;
  waitStatus = 'matched';
  const callsBeforeInvalid = layoutCalls;
  for (const arguments_ of [
    { deviceId: 'test-device', selector: {} },
    { deviceId: 'test-device', selector: { text: '搜索', directory: 'outside' } },
    { deviceId: 'test-device', selector: { clickable: 'true' } },
    { deviceId: 'test-device', selector: { text: '搜索' }, limit: 1.5 }
  ]) {
    assert.equal((await request('tools/call', { name: 'find', arguments: arguments_ })).error.code, -32602);
  }
  assert.equal((await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device', maxNodes: 0 } })).error.code, -32602);
  for (const bundleName of ['com.example; invalid', '123', 'com..x', 'com.' + 'x'.repeat(252)]) {
    assert.equal((await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device', bundleName } })).error.code, -32602);
  }
  assert.equal(layoutCalls, callsBeforeInvalid, 'invalid selectors must not reach the adapter');
  layoutEmpty = true;
  for (const name of ['observe', 'find']) {
    const fallback = await request('tools/call', { name, arguments: { deviceId: 'test-device', ...(name === 'find' ? { selector: { text: 'missing' } } : {}) } });
    assert.equal(fallback.result.structuredContent.screenshotFallback, true);
    assert.equal(fallback.result.content[1].type, 'image');
    assert.equal(fallback.result.isError, undefined, 'empty matches are an observation, not a tool failure');
  }
  layoutEmpty = false;
  layoutTruncated = true;
  const truncatedLayout = await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device', maxNodes: 1 } });
  assert.equal(truncatedLayout.result.structuredContent.truncated, true);
  assert.equal(truncatedLayout.result.content[1].type, 'image', 'truncated layouts should retain visual context');
  layoutTruncated = false;
  layoutError = true;
  const failedLayout = await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device' } });
  assert.equal(failedLayout.result.isError, true);
  assert.equal(failedLayout.result.structuredContent.errorCode, 'LAYOUT_UNAVAILABLE');
  assert.equal(failedLayout.result.structuredContent.stage, 'observe');
  assert.equal(failedLayout.result.structuredContent.cause.message, 'UITest layout unavailable');
  assert.ok(failedLayout.result.structuredContent.elapsedMs >= 0);
  assert.equal(failedLayout.result.content[1].type, 'image', 'layout failures must still supply screenshot evidence');
  offline = true;
  const failedBoth = await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device' } });
  assert.equal(failedBoth.result.isError, true);
  assert.match(failedBoth.result.structuredContent.screenshotError, /disconnected/);
  offline = false;
  layoutError = false;
  tapError = tagError(Object.assign(new Error('uiInput failed'), { exitCode: 1 }), 'ACTION_FAILED', 'tap');
  const failedTap = (await request('tools/call', { name: 'tap', arguments: { deviceId: 'test-device', x: 12, y: 24 } })).result;
  assert.equal(failedTap.isError, true);
  assert.equal(failedTap.structuredContent.errorCode, 'ACTION_FAILED');
  assert.equal(failedTap.structuredContent.stage, 'tap');
  assert.equal(failedTap.structuredContent.cause.exitCode, 1);
  assert.equal(failedTap.content[1].type, 'image');
  assert.equal(taps, 0, 'failed actions must not be retried');
  tapError = null;
  const previewStarted = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  const session = JSON.parse(previewStarted.result.content[0].text);
  assert.equal(session.deviceId, 'test-device');
  assert.equal(session.running, true);
  assert.equal(session.connected, true);
  assert.equal(session.pollMs, 500);
  assert.match(session.sessionId, /^[\da-f-]{36}$/);
  assert.equal(session.wsUrl, session.serverUrl.replace('http:', 'ws:') + 'preview');
  assert.equal(new URL(session.previewUrl).searchParams.get('deviceId'), 'test-device');
  const previewFrame = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } });
  assert.deepEqual(previewFrame.result.content, [], 'App-only frames must not enter model content');
  assert.equal(previewFrame.result.structuredContent.deviceId, 'test-device');
  assert.equal(previewFrame.result.structuredContent.connected, true);
  assert.ok(previewFrame.result.structuredContent.seq >= 1);
  assert.equal(previewFrame.result.structuredContent.frame.mimeType, 'image/jpeg');
  const sameFrame = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: previewFrame.result.structuredContent.seq } });
  assert.equal(sameFrame.result.content.length, 0);
  assert.equal(sameFrame.result.structuredContent.frame, null, 'afterSeq must suppress duplicate frames');
  const previewAction = await request('tools/call', { name: 'preview_action', arguments: { action: 'tap', seq: previewFrame.result.structuredContent.seq, x: 10, y: 20 } });
  assert.deepEqual(previewAction.result.content, [], 'App-only actions must not enter model content');
  assert.equal(previewAction.result.structuredContent.x, 10);
  assert.equal(previewAction.result.structuredContent.metrics.action, 'tap');
  assert.ok(Number.isFinite(previewAction.result.structuredContent.metrics.actionMs));
  assert.ok(Number.isInteger(previewAction.result.structuredContent.metrics.nextFrameAfterSeq));
  assert.equal(taps, 1);
  frameData = Buffer.from([0xff, 0xd8, 0xff]);
  const previewPage = await (await fetch(session.previewUrl)).text();
  assert.match(previewPage, /requestedDeviceId/);
  assert.ok(session.capabilities.includes('tap'));
  const repeated = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(JSON.parse(repeated.result.content[0].text), session, 'repeated start must reuse the same session');
  assert.equal((await request('tools/call', { name: 'preview_stop', arguments: { sessionId: 'stale-session' } })).result.isError, true);
  assert.equal(JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text).sessionId, session.sessionId);
  const liveImage = await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(liveImage.result.content[0], { type: 'image', mimeType: 'image/jpeg', data: '/9j/' });
  assertFreshImage(liveImage.result, 'test-device');
  offline = true;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text).connected, false);
  assert.equal((await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } })).result.isError, true, 'offline capture must not return a stale cached image');
  offline = false;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text).connected, true);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'swipe', arguments: { deviceId: 'test-device', fromX: 1, fromY: 2, toX: 3, toY: 4 } })).result.content[0].text).toX, 3);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'long_press', arguments: { deviceId: 'test-device', x: 1, y: 2 } })).result.content[0].text).x, 1);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'key_event', arguments: { deviceId: 'test-device', key: 'Back' } })).result.content[0].text).key, 'Back');
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'input_text', arguments: { deviceId: 'test-device', text: 'hello' } })).result.content[0].text).text, 'hello');
  await request('tools/call', { name: 'tap', arguments: { deviceId: 'test-device', x: 12, y: 24 } });
  assert.equal(taps, 2);
  const capturesBefore = captured;
  const afterTap = await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } });
  assert.ok(captured > capturesBefore, 'capture must sample the device even when a live preview exists');
  assert.equal(Buffer.from(afterTap.result.content[0].data, 'base64').toString(), 'after-tap', 'capture after tap must return the updated device frame');
  assert.notEqual(afterTap.result.structuredContent.frameId, liveImage.result.structuredContent.frameId);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'preview_stop', arguments: { sessionId: session.sessionId } })).result.content[0].text), { running: false, deviceId: 'test-device', sessionId: session.sessionId });
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'preview_stop' })).result.content[0].text), { running: false });
  const pngStarted = JSON.parse((await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'png-device' } })).result.content[0].text);
  assert.notEqual(pngStarted.sessionId, session.sessionId);
  const pngCapture = await request('tools/call', { name: 'capture', arguments: { deviceId: 'png-device' } });
  assert.deepEqual(pngCapture.result.content[0], { type: 'image', mimeType: 'image/png', data: 'iVBORw==' });
  assertFreshImage(pngCapture.result, 'png-device');
  const replaced = JSON.parse((await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } })).result.content[0].text);
  assert.notEqual(replaced.sessionId, pngStarted.sessionId, 'switching device must replace the session');
  const timedOut = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'disconnected' } });
  assert.equal(timedOut.result.isError, true);
  assert.match(timedOut.result.content[0].text, /Timed out/);
  const stoppedInfo = JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text);
  assert.equal(stoppedInfo.running, false);
  assert.equal(stoppedInfo.sessionId, null);
  for (const args of [{ deviceId: 'test-device', x: -1, y: 24 }, { deviceId: 'test-device', x: '12', y: 24 }, null]) {
    assert.equal((await request('tools/call', { name: 'tap', arguments: args })).error.code, -32602);
  }
  assert.equal(taps, 2, 'invalid arguments must not reach the device');
  assert.equal((await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device', directory: 'outside' } })).error.code, -32602);
  assert.equal((await request('tools/call', { name: 'unknown' })).error.code, -32602);
  assert.equal((await request('unknown')).error.code, -32601);
  const disconnected = await request('tools/call', { name: 'capture', arguments: { deviceId: 'disconnected' } });
  assert.equal(disconnected.result.isError, true);
  assert.match(disconnected.result.content[0].text, /disconnected/);
  const build = await request('tools/call', { name: 'build_run', arguments: { deviceId: 'test-device' } });
  assert.equal(build.result.isError, true);
  assert.match(build.result.content[0].text, /HARMONY_PROJECT/);
  input.write('invalid json\n');
  assert.equal(JSON.parse((await responses.next()).value).error.code, -32700);
  const info = await request('tools/call', { name: 'preview_info' });
  previewUrl = JSON.parse(info.result.content[0].text).previewUrl;
  assert.equal((await fetch(previewUrl + 'health')).status, 200);
  socket = new WebSocket(previewUrl.replace('http:', 'ws:') + 'preview');
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  assert.equal((await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } })).result.isError, undefined, 'leave a live session for EOF cleanup');
} finally {
  input.end();
  await running;
  socket?.terminate();
  output.end();
}
await assert.rejects(fetch(previewUrl + 'health'), /fetch failed/);

// Exercise the actual CLI over stdio, including a working directory outside the repository.
const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/harmonyos-preview.mjs', import.meta.url)), '--mcp'], {
  cwd: process.env.TEMP, env: { ...process.env, HARMONY_PREVIEW_PORT: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
const cliReplies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' }
} }) + '\n');
assert.equal(JSON.parse((await cliReplies.next()).value).result.serverInfo.name, 'harmonyos-preview');
child.stdin.end();
assert.equal(await exited, 0, stderr);
assert.equal((await cliReplies.next()).done, true, 'stdout must contain only MCP responses');
console.log('mcp: ok');

const nestedCause = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
const nestedDiagnostic = toDiagnostic(new Error('state save failed', { cause: nestedCause }), { elapsedMs: NaN });
assert.deepEqual(nestedDiagnostic.cause, { message: 'disk full', code: 'ENOSPC' });
assert.equal(nestedDiagnostic.elapsedMs, 0);

function assertFreshImage(result, deviceId) {
  assert.equal(result.structuredContent.deviceId, deviceId);
  assert.equal(result.structuredContent.live, false);
  assert.equal(result.structuredContent.sessionId, null);
  assert.match(result.structuredContent.frameId, /^[\da-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(result.structuredContent.capturedAt)));
}
