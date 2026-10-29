import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCodex } from '../scripts/check-codex.mjs';

const deviceId = 'test-device';
const tapSelector = { id: 'open' };
const waitSelector = { id: 'result', text: '完成' };
const target = { id: 'open', text: '打开', type: 'Button', clickable: true, enabled: true, visible: true,
  bounds: { left: 10, top: 20, right: 110, bottom: 80 }, center: { x: 60, y: 50 } };
const toolNames = ['list_devices', 'preview_info', 'observe', 'find', 'wait_for', 'tap_element', 'capture', 'preview_start', 'preview_stop', 'build_run'];
const runtime = { serverVersion: '0.1.0', diagnosticsVersion: 1, startedAt: '2026-10-26T01:00:00.000Z', instanceId: 'mock-instance' };

function fixture({ expectedBefore = 0, waitStatus = 'matched', noTree = false, reusedFrame = false, captureMetadata = {}, tapDiagnostic,
  listedTools = toolNames, capabilities = toolNames, runtimeInfo = runtime, deviceCheck = { status: 'connected', deviceId, devices: [deviceId], checkedAt: new Date().toISOString(), elapsedMs: 1 }, protocolErrorAt,
  serviceDiagnostic, stopDiagnostic } = {}) {
  const calls = [];
  let closed = false;
  let frameNumber = 0;
  const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const client = {
    async listTools(_params, options) {
      calls.push({ name: 'tools/list', options });
      return { tools: listedTools.map((name) => ({ name })) };
    },
    async callTool({ name, arguments: args }, _schema, options) {
      calls.push({ name, args, options });
      if (name === protocolErrorAt) throw Object.assign(new Error('MCP protocol connection closed'), { code: 'EPIPE' });
      if (name === 'list_devices') return result({ devices: [deviceId] });
      if (name === 'preview_info') return result({ runtime: runtimeInfo, capabilities, deviceCheck, connected: false, ...(serviceDiagnostic ? { serviceDiagnostic } : {}) });
      if (name === 'preview_stop' && stopDiagnostic) return { ...result(stopDiagnostic), isError: true };
      if (name === 'observe') return result({ nodes: noTree ? [] : [target], totalNodes: noTree ? 0 : 1 });
      if (name === 'find') {
        if (args.selector.id === 'result') return result({ matches: [], totalMatches: expectedBefore, observedAt: Date.now() });
        return result({ matches: [target], totalMatches: 1, observedAt: Date.now() });
      }
      if (name === 'tap_element') {
        if (tapDiagnostic) return { ...result(tapDiagnostic), isError: true,
          content: [...result(tapDiagnostic).content, ...(tapDiagnostic.screenshotError ? [] : [{ type: 'image', mimeType: 'image/jpeg', data: Buffer.alloc(1200, 1).toString('base64') }])] };
        return result({ deviceId, selector: args.selector, observedAt: Date.now(), target, action: 'tap', verified: false });
      }
      if (name === 'preview_start') return result({ sessionId: 'owned-session', previewUrl: `http://127.0.0.1:4100/?deviceId=${deviceId}` });
      if (name === 'capture') return { content: [{ type: 'image', mimeType: 'image/jpeg', data: Buffer.alloc(1200, 1).toString('base64') }],
        structuredContent: { deviceId, live: false, sessionId: null, frameId: reusedFrame ? 'same-frame' : `frame-${++frameNumber}`, capturedAt: new Date().toISOString(), ...captureMetadata } };
      if (name === 'wait_for') {
        const waited = { status: waitStatus, attempts: 2, lastObservation: { observedAt: Date.now() }, ...(waitStatus === 'matched' ? {} : {
          error: 'Timed out waiting', errorCode: 'WAIT_TIMEOUT', stage: 'wait_for', deviceId, elapsedMs: 10000,
          cause: { message: 'Expected control did not appear' }, screenshotError: 'device disconnected' }) };
        return { ...result(waited), ...(waitStatus === 'matched' ? {} : { isError: true }) };
      }
      return result({});
    },
    async close() { closed = true; }
  };
  const options = { projectPath: 'mock-project', deviceId, client, fetchPreview: async (_url, request) => {
    calls.push({ name: 'fetch', signal: request.signal });
    return { status: 200 };
  } };
  return { options, calls, get closed() { return closed; } };
}

const readOnly = fixture({ listedTools: toolNames.filter((name) => name !== 'tap_element'), capabilities: toolNames.filter((name) => name !== 'tap_element') });
const readOnlyResult = await checkCodex(readOnly.options);
assert.equal(readOnlyResult.actionVerified, false);
assert.equal(readOnlyResult.waitStatus, 'matched');
assert.deepEqual(readOnlyResult.toolsVerified, ['observe', 'find', 'wait_for']);
assert.deepEqual(readOnlyResult.connectionCheck, { scope: 'provided_client', hostConnectionVerified: false, runtime, deviceStatus: 'connected' });
assert.equal(readOnlyResult.connectionCheck.runtime.startedAt, runtime.startedAt);
assert.equal(readOnlyResult.connectionCheck.runtime.instanceId, runtime.instanceId);
assert.deepEqual(readOnly.calls.find(({ name }) => name === 'preview_info').args, { deviceId });
assert.ok(!readOnly.calls.some(({ name }) => ['tap', 'tap_element', 'build_run'].includes(name)));
assert.equal(readOnly.closed, true);
assert.equal(readOnly.calls.find(({ name }) => name === 'preview_stop').args.sessionId, 'owned-session');

for (const invalidOptions of [
  { tapSelector }, { waitSelector }, { tapSelector, waitSelector, deviceId: undefined },
  { tapSelector: '{invalid', waitSelector }, { tapSelector: {}, waitSelector }
]) {
  const invalid = fixture();
  await assert.rejects(checkCodex({ ...invalid.options, ...invalidOptions }), (error) => {
    assert.equal(error.errorCode, 'ACCEPTANCE_FAILED');
    assert.equal(error.stage, 'argument_validation');
    assert.equal(error.diagnostics.result.errorCode, 'ACCEPTANCE_FAILED');
    assert.ok(error.elapsedMs >= 0);
    assert.ok(error.cause.message);
    return true;
  });
  assert.deepEqual(invalid.calls, [], 'invalid touch arguments must fail before any MCP call');
}

for (const errorCode of ['ELEMENT_NOT_FOUND', 'ELEMENT_AMBIGUOUS', 'ELEMENT_NOT_ACTIONABLE', 'STALE_OBSERVATION', 'HDC_NOT_FOUND']) {
  const tapDiagnostic = { error: 'Element tap was rejected', errorCode, stage: 'tap_element', deviceId, elapsedMs: 12,
    cause: { message: 'Target unavailable' }, screenshotFallback: true,
    ...(errorCode === 'HDC_NOT_FOUND' ? { screenshotError: 'device disconnected' } : {
      screenshot: { deviceId, live: false, sessionId: null, frameId: 'fallback-frame', capturedAt: new Date().toISOString() } }) };
  const rejected = fixture({ tapDiagnostic });
  await assert.rejects(checkCodex({ ...rejected.options, tapSelector, waitSelector }), (error) => {
    assert.equal(error.errorCode, errorCode);
    assert.equal(error.stage, 'tap_element');
    assert.equal(error.deviceId, deviceId);
    assert.deepEqual(error.diagnostics.result, tapDiagnostic, 'Keep element action diagnostics and screenshot failure details');
    assert.equal(error.diagnostics.tool, 'tap_element');
    assert.ok(!JSON.stringify(error.diagnostics).includes(Buffer.alloc(1200, 1).toString('base64')));
    return true;
  });
  assert.equal(rejected.calls.filter(({ name }) => name === 'tap_element').length, 1, 'Do not retry a failed element action');
  assert.ok(!rejected.calls.some(({ name }) => name === 'tap' || name === 'wait_for'), 'Failed element actions must not continue to verification');
  assert.equal(rejected.calls.filter(({ name }) => name === 'capture').length, 1, 'Fallback screenshots are handled by MCP, not repeated by the acceptance script');
  assert.equal(rejected.closed, true);
  assert.equal(rejected.calls.at(-1).name, 'preview_stop');
}

const alreadySatisfied = fixture({ expectedBefore: 1 });
await assert.rejects(checkCodex({ ...alreadySatisfied.options, tapSelector, waitSelector }), /already matches/);
assert.ok(!alreadySatisfied.calls.some(({ name }) => ['tap', 'tap_element', 'wait_for'].includes(name)));
assert.equal(alreadySatisfied.calls.at(-1).name, 'preview_stop');
assert.equal(alreadySatisfied.closed, true);

const noTree = fixture({ noTree: true });
await assert.rejects(checkCodex(noTree.options), /No locatable UI hierarchy/);
assert.equal(noTree.closed, true);

const failedDiscovery = fixture();
failedDiscovery.options.client.listTools = async () => { throw new Error('MCP connection closed'); };
await assert.rejects(checkCodex(failedDiscovery.options), (error) => {
  assert.match(error.message, /MCP connection closed/);
  assert.equal(error.errorCode, 'MCP_CONNECTION_FAILED');
  assert.equal(error.stage, 'connection_check');
  assert.equal(error.diagnostics.result.errorCode, 'MCP_CONNECTION_FAILED');
  return true;
});
assert.equal(failedDiscovery.closed, true, 'discovery failures must still close this client');

for (const overrides of [
  { listedTools: toolNames.filter((name) => name !== 'preview_info') },
  { listedTools: toolNames.filter((name) => name !== 'wait_for') },
  { listedTools: toolNames.filter((name) => name !== 'tap_element') },
  { runtimeInfo: null },
  { runtimeInfo: { ...runtime, diagnosticsVersion: 99 } },
  { runtimeInfo: { ...runtime, serverVersion: '' } },
  { runtimeInfo: { ...runtime, startedAt: 'invalid timestamp' } },
  { runtimeInfo: { ...runtime, instanceId: '' } },
  { capabilities: undefined },
  { capabilities: 'list_devices preview_info observe find wait_for capture preview_start preview_stop tap_element' },
  { capabilities: toolNames.filter((name) => name !== 'find') },
  { capabilities: toolNames.filter((name) => name !== 'tap_element') },
  { deviceCheck: { status: 'not_checked' } }
]) {
  // Explicit null also exercises a response that omitted the capability list entirely.
  const outdated = fixture({ ...overrides, ...(Object.hasOwn(overrides, 'capabilities') && overrides.capabilities === undefined ? { capabilities: null } : {}) });
  await assert.rejects(checkCodex({ ...outdated.options, tapSelector, waitSelector }), (error) => {
    assert.equal(error.errorCode, 'MCP_OUTDATED');
    assert.equal(error.stage, 'connection_check');
    return true;
  });
  assert.ok(!outdated.calls.some(({ name }) => ['observe', 'preview_start', 'tap', 'tap_element'].includes(name)), 'Do not operate through an outdated connection');
  assert.equal(outdated.closed, true);
}

for (const deviceCheck of [
  { status: 'disconnected', deviceId, devices: [], checkedAt: runtime.startedAt, elapsedMs: 3,
    error: 'Device is not connected', errorCode: 'DEVICE_OFFLINE', stage: 'device_check', cause: { message: 'Target was not listed' } },
  { status: 'error', deviceId, checkedAt: runtime.startedAt, elapsedMs: 7,
    error: 'HDC executable unavailable', errorCode: 'HDC_NOT_FOUND', stage: 'hdc_spawn', cause: { message: 'spawn hdc ENOENT', code: 'ENOENT' } }
]) {
  const unavailable = fixture({ deviceCheck });
  await assert.rejects(checkCodex({ ...unavailable.options, tapSelector, waitSelector }), (error) => {
    assert.equal(error.errorCode, deviceCheck.errorCode);
    assert.equal(error.stage, deviceCheck.stage);
    assert.equal(error.deviceId, deviceId);
    assert.equal(error.elapsedMs, deviceCheck.elapsedMs);
    assert.deepEqual(error.cause, deviceCheck.cause);
    assert.deepEqual(error.diagnostics.result, deviceCheck);
    return true;
  });
  assert.equal(unavailable.calls.filter(({ name }) => name === 'preview_info').length, 1, 'Do not retry device self-check');
  assert.ok(!unavailable.calls.some(({ name }) => ['tap', 'tap_element', 'observe'].includes(name)));
  assert.equal(unavailable.closed, true);
}

const protocolFailure = fixture({ protocolErrorAt: 'preview_info' });
await assert.rejects(checkCodex(protocolFailure.options), (error) => {
  assert.equal(error.errorCode, 'MCP_CONNECTION_FAILED');
  assert.equal(error.stage, 'connection_check');
  assert.equal(error.cause.code, 'EPIPE');
  return true;
});
assert.equal(protocolFailure.closed, true);

const cleanupFailure = fixture({ deviceCheck: { status: 'disconnected', deviceId, error: 'Device lost', errorCode: 'DEVICE_OFFLINE', stage: 'device_check' } });
cleanupFailure.options.client.close = async () => { throw new Error('Client close failed'); };
await assert.rejects(checkCodex(cleanupFailure.options), (error) => {
  assert.equal(error.errorCode, 'DEVICE_OFFLINE', 'Cleanup errors must not replace the actionable diagnostic');
  assert.equal(error.diagnostics.result.error, 'Device lost');
  return true;
});

const serviceDiagnostic = { error: 'External preview service is unavailable', errorCode: 'PREVIEW_UNAVAILABLE', stage: 'preview_service',
  deviceId: null, elapsedMs: 500, cause: { message: 'Connection refused', code: 'ECONNREFUSED' } };
const unavailableService = fixture({ serviceDiagnostic });
await assert.rejects(checkCodex(unavailableService.options), (error) => {
  assert.equal(error.errorCode, 'PREVIEW_UNAVAILABLE');
  assert.equal(error.stage, 'preview_service');
  assert.equal(error.diagnostics.tool, 'preview_info');
  assert.deepEqual(error.diagnostics.result, serviceDiagnostic);
  assert.deepEqual(error.cause, serviceDiagnostic.cause);
  return true;
});
assert.ok(!unavailableService.calls.some(({ name }) => name === 'observe' || name === 'preview_start'));
assert.equal(unavailableService.closed, true);

const stopDiagnostic = { error: 'Preview session could not be stopped', errorCode: 'PREVIEW_STOP_FAILED', stage: 'preview_stop',
  deviceId, elapsedMs: 20, cause: { message: 'Connection closed during stop' } };
const failedStop = fixture({ stopDiagnostic });
await assert.rejects(checkCodex(failedStop.options), (error) => {
  assert.equal(error.errorCode, stopDiagnostic.errorCode, 'A failed cleanup must not report successful acceptance');
  assert.equal(error.diagnostics.tool, 'preview_stop');
  assert.deepEqual(error.diagnostics.result, stopDiagnostic);
  return true;
});
assert.equal(failedStop.calls.filter(({ name }) => name === 'preview_stop').length, 1, 'Do not repeat stop');
assert.equal(failedStop.closed, true, 'Stop failure must still close the client');

const failedWaitAndStop = fixture({ waitStatus: 'timeout', stopDiagnostic });
await assert.rejects(checkCodex({ ...failedWaitAndStop.options, tapSelector, waitSelector }), (error) => {
  assert.equal(error.errorCode, 'WAIT_TIMEOUT', 'Stop failure must not replace the main wait failure');
  assert.equal(error.diagnostics.tool, 'wait_for');
  assert.equal(error.diagnostics.result.status, 'timeout');
  assert.equal(error.diagnostics.result.screenshotError, 'device disconnected');
  return true;
});
assert.equal(failedWaitAndStop.calls.filter(({ name }) => name === 'tap_element').length, 1);
assert.equal(failedWaitAndStop.calls.filter(({ name }) => name === 'preview_stop').length, 1);
assert.equal(failedWaitAndStop.closed, true);

const success = fixture();
const successResult = await checkCodex({ ...success.options, tapSelector: JSON.stringify(tapSelector), waitSelector: JSON.stringify(waitSelector) });
assert.equal(successResult.actionVerified, true);
assert.deepEqual(successResult.toolsVerified, ['observe', 'find', 'tap_element', 'wait_for']);
assert.equal(successResult.waitStatus, 'matched');
assert.equal(successResult.waitAttempts, 2);
assert.equal(successResult.frameId, 'frame-2');
assert.deepEqual(success.calls.map(({ name }) => name), ['tools/list', 'list_devices', 'preview_info', 'observe', 'preview_start', 'fetch', 'capture', 'find', 'tap_element', 'wait_for', 'capture', 'preview_stop']);
assert.deepEqual(success.calls.filter(({ name }) => name === 'find').map(({ args }) => args.selector), [waitSelector]);
assert.deepEqual(success.calls.find(({ name }) => name === 'tap_element').args, { deviceId, selector: tapSelector });
assert.ok(!success.calls.some(({ name }) => name === 'tap'), 'The action flow must use the shared element action');
assert.ok(success.calls.filter(({ options }) => options).every(({ options }) => options.timeout > 0 && options.timeout <= 45000));
assert.equal(success.closed, true);

const failedWait = fixture({ waitStatus: 'timeout' });
await assert.rejects(checkCodex({ ...failedWait.options, tapSelector, waitSelector }), (error) => {
  assert.equal(error.diagnostics.tool, 'wait_for');
  assert.equal(error.diagnostics.result.status, 'timeout');
  assert.equal(error.diagnostics.result.screenshotError, 'device disconnected');
  assert.equal(error.errorCode, 'WAIT_TIMEOUT');
  assert.equal(error.stage, 'wait_for');
  assert.equal(error.deviceId, deviceId);
  assert.equal(error.elapsedMs, 10000);
  assert.ok(!JSON.stringify(error.diagnostics).includes(Buffer.alloc(1200, 1).toString('base64')));
  return true;
});
assert.equal(failedWait.calls.filter(({ name }) => name === 'tap_element').length, 1, 'failed waits must never retry the element action');
assert.equal(failedWait.calls.at(-1).name, 'preview_stop');
assert.equal(failedWait.closed, true);

const oldFrame = fixture({ reusedFrame: true });
await assert.rejects(checkCodex({ ...oldFrame.options, tapSelector, waitSelector }), /reused the earlier frame/);
assert.equal(oldFrame.closed, true);

for (const captureMetadata of [{ live: true }, { sessionId: 'cached-session' }]) {
  const cached = fixture({ captureMetadata });
  await assert.rejects(checkCodex(cached.options), /fresh|preview session frame/);
  assert.equal(cached.closed, true);
  assert.equal(cached.calls.at(-1).name, 'preview_stop');
}

const built = fixture();
await checkCodex({ ...built.options, build: true });
assert.equal(built.calls.find(({ name }) => name === 'build_run').options.timeout, 360000);
assert.equal(built.closed, true);

const multiBuilt = fixture();
await checkCodex({ ...multiBuilt.options, build: true, moduleName: 'feature', artifactName: 'feature-signed.hap' });
assert.deepEqual(multiBuilt.calls.find(({ name }) => name === 'build_run').args,
  { deviceId, moduleName: 'feature', artifactName: 'feature-signed.hap' });
assert.equal(multiBuilt.closed, true);

const invalidCli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-codex.mjs', import.meta.url)),
  '--project', 'mock-project', '--device', deviceId, '--tap-selector', '{invalid'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
assert.equal(invalidCli.status, 1);
const cliDiagnostic = JSON.parse(invalidCli.stderr.trim());
assert.equal(cliDiagnostic.check, 'codex: failed');
assert.equal(cliDiagnostic.errorCode, 'ACCEPTANCE_FAILED');
assert.equal(cliDiagnostic.stage, 'argument_validation');
assert.equal(cliDiagnostic.deviceId, deviceId);
assert.ok(cliDiagnostic.elapsedMs >= 0);
assert.ok(cliDiagnostic.cause.message);
assert.equal(cliDiagnostic.diagnostics.result.errorCode, 'ACCEPTANCE_FAILED');

console.log('acceptance: ok');
