import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
assert.deepEqual(packageJson.files, ['README.md', 'bin', 'src', 'docs', 'skills', 'scripts']);
assert.equal(packageJson.bin['harmonyos-preview'], 'bin/harmonyos-preview.mjs');

const files = [
  'README.md',
  'bin/harmonyos-preview.mjs',
  'package.json',
  'src/build.mjs',
  'src/device.mjs',
  'src/mcp.mjs',
  'src/project.mjs',
  'src/server.mjs',
  'docs/codex-usage.md',
  'skills/harmonyos-preview-codex/SKILL.md',
  'scripts/install-codex.ps1',
  'scripts/check-codex.mjs'
];
for (const file of files) assert.ok(existsSync(new URL('../' + file, import.meta.url)), file);
assert.ok(!files.some((file) => file.startsWith('test/') || file.startsWith('.runtime/')));
const workflow = readFileSync(new URL('../skills/harmonyos-preview-codex/SKILL.md', import.meta.url), 'utf8');
for (const tool of ['list_devices', 'build_run', 'preview_start', 'preview_info', 'capture', 'tap', 'preview_stop', 'open_in_codex', 'right']) {
  assert.match(workflow, new RegExp(`\\b${tool}\\b`));
}
console.log('package: ok');
