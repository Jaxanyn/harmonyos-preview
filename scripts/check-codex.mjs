#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateSelector } from '../src/layout.mjs';
import { diagnosticsVersion, serverVersion, tagError, toDiagnostic } from '../src/diagnostics.mjs';

export async function checkCodex({ projectPath, deviceId: requestedDevice, build = false, moduleName, artifactName, tapSelector, waitSelector, client, fetchPreview = fetch } = {}) {
  const startedAt = Date.now();
  let stage = 'argument_validation';
  let deviceId = requestedDevice ?? null;
  const action = tapSelector !== undefined || waitSelector !== undefined;
  try {
    if (!projectPath) throw new Error('--project or HARMONY_PROJECT is required');
    if (action && (tapSelector === undefined || waitSelector === undefined)) throw new Error('--tap-selector and --wait-selector must be provided together');
    if (action && !requestedDevice) throw new Error('--device is required for touch acceptance');
    if (action) {
      tapSelector = parseSelector(tapSelector, '--tap-selector');
      waitSelector = parseSelector(waitSelector, '--wait-selector');
    }
  } catch (error) {
    throw diagnosticError(error, { stage, deviceId, elapsedMs: Date.now() - startedAt });
  }
  let mcp = client;
  let session;
  let failure;
  const tool = async (name, arguments_, timeout = 45000) => {
    let result;
    try { result = await mcp.callTool({ name, arguments: arguments_ }, undefined, { timeout, maxTotalTimeout: timeout }); }
    catch (error) { throw tagError(error, 'MCP_CONNECTION_FAILED', stage); }
    if (result.isError) throw toolError(name, result);
    return result;
  };
  try {
    stage = 'connection_check';
    if (!mcp) {
      mcp = new Client({ name: 'harmonyos-preview-check', version: serverVersion }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../bin/harmonyos-preview.mjs', import.meta.url)), '--mcp'],
        cwd: process.cwd(), stderr: 'pipe',
        env: { ...process.env, HARMONY_PROJECT: projectPath, HARMONY_PREVIEW_URL: '', HARMONY_PREVIEW_AUTOSTART: '0', HARMONY_PREVIEW_PORT: '0' }
      });
      transport.stderr?.resume();
      await mcp.connect(transport, { timeout: 45000, maxTotalTimeout: 45000 });
    }
    const listedTools = await mcp.listTools(undefined, { timeout: 45000, maxTotalTimeout: 45000 });
    const available = listedTools.tools.map(({ name }) => name);
    const requiredTools = ['list_devices', 'preview_info', 'observe', 'find', 'wait_for', 'capture', 'preview_start', 'preview_stop', ...(action ? ['tap_element'] : []), ...(build ? ['build_run'] : [])];
    for (const name of requiredTools) {
      if (!available.includes(name)) throw tagError(new Error('MCP did not expose ' + name), 'MCP_OUTDATED', stage);
    }
    const devices = data(await tool('list_devices', {})).devices;
    assert.ok(Array.isArray(devices), 'MCP device list is invalid');
    deviceId = requestedDevice ?? devices[0];
    if (!deviceId) throw tagError(new Error('No HarmonyOS device or emulator is connected'), 'DEVICE_OFFLINE', stage);
    const info = data(await tool('preview_info', { deviceId }));
    if (info.serviceDiagnostic) throw toolError('preview_info', { structuredContent: info.serviceDiagnostic });
    const runtime = info.runtime;
    if (!runtime || runtime.diagnosticsVersion !== diagnosticsVersion || typeof runtime.serverVersion !== 'string' || !runtime.serverVersion
      || !Number.isFinite(Date.parse(runtime.startedAt)) || typeof runtime.instanceId !== 'string' || !runtime.instanceId) {
      throw tagError(new Error('MCP runtime diagnostics are missing or unsupported; refresh this connection'), 'MCP_OUTDATED', stage);
    }
    for (const name of requiredTools) {
      if (!Array.isArray(info.capabilities) || !info.capabilities.includes(name)) throw tagError(new Error('MCP runtime did not expose ' + name), 'MCP_OUTDATED', stage);
    }
    const deviceCheck = info.deviceCheck;
    if (!deviceCheck || !['connected', 'disconnected', 'error'].includes(deviceCheck.status)) {
      throw tagError(new Error('MCP device self-check is missing or unsupported'), 'MCP_OUTDATED', stage);
    }
    if (deviceCheck.status !== 'connected') throw toolError('preview_info', { structuredContent: deviceCheck });
    assert.equal(deviceCheck.deviceId, deviceId, 'MCP checked a different device');
    const connectionCheck = { scope: client ? 'provided_client' : 'isolated_process', hostConnectionVerified: false,
      runtime, deviceStatus: deviceCheck.status };
    if (build) {
      stage = 'build_run';
      const buildArgs = { deviceId, ...(moduleName !== undefined ? { moduleName } : {}), ...(artifactName !== undefined ? { artifactName } : {}) };
      await tool('build_run', buildArgs, 360000);
    }

    stage = 'observe';
    const observed = data(await tool('observe', { deviceId, maxNodes: 200 }));
    const anchor = observed.nodes?.find((node) => node.id) ?? observed.nodes?.find((node) => node.type);
    assert.ok(anchor, 'No locatable UI hierarchy is exposed; read-only acceptance cannot verify find/wait_for');
    if (!action) {
      stage = 'find';
      waitSelector = anchor.id ? { id: anchor.id } : { type: anchor.type };
      assert.ok(data(await tool('find', { deviceId, selector: waitSelector })).totalMatches > 0, 'The observed anchor is no longer present');
    }
    stage = 'preview_start';
    session = data(await tool('preview_start', { deviceId }));
    assert.equal(new URL(session.previewUrl).searchParams.get('deviceId'), deviceId);
    stage = 'preview_url';
    assert.equal((await fetchPreview(session.previewUrl, { signal: AbortSignal.timeout(5000) })).status, 200);
    stage = 'capture';
    const before = action ? screenshot(await tool('capture', { deviceId }), deviceId) : null;
    if (action) {
      stage = 'action_precondition';
      const expectedBefore = data(await tool('find', { deviceId, selector: waitSelector }));
      assert.equal(expectedBefore.totalMatches, 0, 'The wait selector already matches before tapping; choose a post-action condition');
      stage = 'tap_element';
      await tool('tap_element', { deviceId, selector: tapSelector });
    }
    stage = 'wait_for';
    const waitResult = await tool('wait_for', { deviceId, selector: waitSelector, state: 'present', timeoutMs: 10000 });
    const waited = data(waitResult);
    if (waited.status !== 'matched') throw toolError('wait_for', waitResult);
    stage = 'capture';
    const final = screenshot(await tool('capture', { deviceId }), deviceId);
    if (before) assert.notEqual(final.frameId, before.frameId, 'Post-action screenshot reused the earlier frame');
    if (waited.lastObservation?.observedAt) assert.ok(Date.parse(final.capturedAt) >= waited.lastObservation.observedAt, 'Post-action screenshot predates the matched observation');
    return { check: 'codex: ok', deviceId, sessionId: session.sessionId, imageBytes: final.imageBytes, built: build,
      toolsVerified: ['observe', 'find', ...(action ? ['tap_element'] : []), 'wait_for'], actionVerified: action, waitStatus: waited.status, waitAttempts: waited.attempts,
      frameId: final.frameId, capturedAt: final.capturedAt, connectionCheck };
  } catch (error) {
    failure = diagnosticError(error, { errorCode: stage === 'connection_check' ? 'MCP_CONNECTION_FAILED' : 'ACCEPTANCE_FAILED',
      stage, deviceId, elapsedMs: Date.now() - startedAt });
    throw failure;
  } finally {
    stage = 'cleanup';
    let cleanupFailure;
    try {
      if (session?.sessionId) await tool('preview_stop', { sessionId: session.sessionId }, 5000);
    } catch (error) {
      cleanupFailure = diagnosticError(error, { errorCode: 'MCP_CONNECTION_FAILED', stage, deviceId, elapsedMs: Date.now() - startedAt });
    }
    try { await mcp?.close(); }
    catch (error) { cleanupFailure ??= diagnosticError(error, { errorCode: 'MCP_CONNECTION_FAILED', stage, deviceId, elapsedMs: Date.now() - startedAt }); }
    if (!failure && cleanupFailure) throw cleanupFailure;
  }
}

function parseSelector(value, label) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error(label + ' must be valid JSON'); }
  }
  validateSelector(value);
  return value;
}

function data(result) {
  return result.structuredContent ?? JSON.parse(result.content?.find((item) => item.type === 'text')?.text ?? '{}');
}

function toolError(name, result) {
  const diagnostic = result.structuredContent;
  const error = Object.assign(new Error(name + ': ' + (diagnostic?.error ?? result.content?.find((item) => item.type === 'text')?.text ?? 'tool failed')),
    { ...(diagnostic?.errorCode ? { errorCode: diagnostic.errorCode } : {}), stage: diagnostic?.stage ?? name,
      ...(diagnostic?.cause ? { cause: diagnostic.cause } : {}) });
  return diagnosticError(error, { deviceId: diagnostic?.deviceId ?? null, elapsedMs: diagnostic?.elapsedMs ?? 0,
    tool: name, result: diagnostic });
}

function diagnosticError(error, { errorCode = 'ACCEPTANCE_FAILED', stage = 'acceptance', deviceId = null, elapsedMs = 0, tool, result } = {}) {
  const diagnostic = toDiagnostic(error, { errorCode, stage, deviceId: error?.deviceId ?? deviceId, elapsedMs: error?.elapsedMs ?? elapsedMs });
  return Object.assign(tagError(error, diagnostic.errorCode, diagnostic.stage), diagnostic,
    { diagnostics: error?.diagnostics ?? { ...(tool ? { tool } : {}), result: result ?? diagnostic } });
}

function screenshot(result, deviceId) {
  const image = result.content?.find((item) => item.type === 'image');
  assert.ok(image, 'Capture did not return an MCP image');
  const imageBytes = Buffer.from(image.data, 'base64').length;
  assert.ok(imageBytes > 1000, 'Screenshot is too small: ' + imageBytes + ' bytes');
  const metadata = result.structuredContent;
  assert.equal(metadata?.deviceId, deviceId);
  assert.equal(metadata.live, false, 'Capture must be fresh rather than a live preview frame');
  assert.equal(metadata.sessionId, null, 'Capture must not reuse a preview session frame');
  assert.ok(typeof metadata.frameId === 'string' && metadata.frameId, 'Capture is missing frameId');
  assert.ok(Number.isFinite(Date.parse(metadata.capturedAt)), 'Capture is missing capturedAt');
  return { imageBytes, frameId: metadata.frameId, capturedAt: metadata.capturedAt };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/check-codex.mjs [--project <HarmonyOS project>] [--device <device ID>] [--build [--module <module>] [--artifact <file.hap>]] [--tap-selector <JSON> --wait-selector <JSON>]');
    return;
  }
  const value = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('-')) throw new Error(flag + ' requires a value');
    return args[index + 1];
  };
  const result = await checkCodex({ projectPath: value('--project') ?? process.env.HARMONY_PROJECT, deviceId: value('--device'),
    build: args.includes('--build'), moduleName: value('--module'), artifactName: value('--artifact'),
    tapSelector: value('--tap-selector'), waitSelector: value('--wait-selector') });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const diagnostic = toDiagnostic(error, { errorCode: 'ACCEPTANCE_FAILED', stage: 'argument_validation', deviceId: error.deviceId ?? null, elapsedMs: error.elapsedMs ?? 0 });
    console.error(JSON.stringify({ check: 'codex: failed', ...diagnostic, diagnostics: error.diagnostics ?? { result: diagnostic } }));
    process.exitCode = 1;
  });
}
