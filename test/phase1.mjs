import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeviceAdapter, runCommand } from '../src/device.mjs';

const timeout = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 50 });
assert.equal(timeout.code, 124);
assert.match(timeout.stderr, /command timed out after 50ms/);

const directory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-capture-'));
const calls = [];
const adapter = createDeviceAdapter({
  timeoutMs: 1000,
  runtime: async (_command, args, options) => {
    calls.push({ args, options });
    if (args.includes('snapshot_display')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('file') && args.includes('recv')) {
      await writeFile(args.at(-1), Buffer.from('frame'));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
});

try {
  const frame = await adapter.capture({ deviceId: 'test-device', directory });
  assert.deepEqual(frame, { mimeType: 'image/jpeg', data: Buffer.from('frame') });
  assert.ok(calls.some(({ args }) => args.includes('rm') && args.includes('-f')), 'remote screenshot must be cleaned up');
  assert.ok(calls.every(({ options }) => Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0), 'HDC calls must receive a timeout');
  assert.deepEqual(await readdir(directory), [], 'local screenshot must be cleaned up');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('phase1: ok');
