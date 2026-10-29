import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceAdapter } from '../src/device.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-tap-element-'));
const control = { attributes: { id: 'open', text: '打开', type: 'Button', clickable: true, enabled: true,
  visible: true, bounds: '[10,20][110,80]' } };
let controls = [control];
let tapFailure = false;
let stale = false;
const calls = [];
const adapter = createDeviceAdapter({ directory, runtime: async (_command, args) => {
  calls.push(args);
  if (args.includes('recv')) await writeFile(args.at(-1), JSON.stringify({ children: controls }));
  if (args.includes('uiInput') && tapFailure) return { code: 1, stdout: '', stderr: 'tap execution failed' };
  if (args[0] === 'list') return { code: 0, stdout: 'test-device\n', stderr: '' };
  if (args.includes('rm') && stale) await new Promise((resolve) => setTimeout(resolve, 1100));
  return { code: 0, stdout: '', stderr: '' };
} });
const args = { deviceId: 'test-device', selector: { id: 'open' } };
const taps = () => calls.filter((call) => call.includes('uiInput'));

try {
  const result = await adapter.tapElement({ ...args, bundleName: 'com.example.app' });
  assert.equal(result.action, 'tap');
  assert.equal(result.verified, false, 'a tap acknowledgement is not outcome verification');
  assert.equal(result.target.id, 'open');
  assert.deepEqual(result.target.center, { x: 60, y: 50 });
  assert.deepEqual(taps(), [['-t', 'test-device', 'shell', 'uitest', 'uiInput', 'click', '60', '50']]);
  assert.ok(calls.find((call) => call.includes('dumpLayout')).includes('com.example.app'));

  for (const [nextControls, expectedCode] of [
    [[], 'ELEMENT_NOT_FOUND'],
    [[control, control, control], 'ELEMENT_AMBIGUOUS'],
    [[{ attributes: { ...control.attributes, enabled: false } }], 'ELEMENT_NOT_ACTIONABLE'],
    [[{ attributes: { ...control.attributes, visible: false } }], 'ELEMENT_NOT_ACTIONABLE'],
    [[{ attributes: { ...control.attributes, clickable: false } }], 'ELEMENT_NOT_ACTIONABLE'],
    [[{ attributes: { ...control.attributes, bounds: '[0,0][0,0]' } }], 'ELEMENT_NOT_ACTIONABLE']
  ]) {
    controls = nextControls;
    const before = taps().length;
    await assert.rejects(adapter.tapElement(args), (error) => {
      assert.equal(error.errorCode, expectedCode);
      assert.equal(error.stage, 'tap_element');
      return true;
    });
    assert.equal(taps().length, before, 'rejected targets must not reach uiInput');
  }

  controls = [control];
  stale = true;
  const beforeStale = taps().length;
  await assert.rejects(adapter.tapElement(args), (error) => error.errorCode === 'STALE_OBSERVATION');
  assert.equal(taps().length, beforeStale, 'slow layout cleanup must not leave actionable stale coordinates');
  stale = false;

  tapFailure = true;
  const beforeFailure = taps().length;
  await assert.rejects(adapter.tapElement(args), (error) => {
    assert.equal(error.errorCode, 'ACTION_FAILED');
    assert.equal(error.stage, 'tap');
    return true;
  });
  assert.equal(taps().length, beforeFailure + 1, 'an uncertain tap failure must not be retried');

  const beforeInvalid = calls.length;
  for (const options of [{ selector: {} }, { bundleName: 'bad;bundle' }, { deviceId: '' }]) {
    await assert.rejects(adapter.tapElement({ ...args, ...options }));
  }
  assert.equal(calls.length, beforeInvalid, 'invalid arguments must fail before HDC');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('tap element: ok');
