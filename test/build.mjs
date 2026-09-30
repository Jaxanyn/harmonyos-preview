import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProject } from '../src/build.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-build-'));
try {
  await writeFile(join(directory, 'build-local.ps1'), 'Start-Sleep -Seconds 3');
  const result = await buildProject(directory, { timeoutMs: 250 });
  assert.equal(result.code, 124);
  assert.match(result.stderr, /build timed out/);
  console.log('build timeout: ok');
} finally {
  await rm(directory, { recursive: true, force: true });
}
