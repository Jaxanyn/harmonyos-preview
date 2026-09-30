import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
assert.deepEqual(packageJson.files, ['README.md', 'bin', 'src']);
assert.equal(packageJson.bin['harmonyos-preview'], 'bin/harmonyos-preview.mjs');

const files = [
  'README.md',
  'bin/harmonyos-preview.mjs',
  'package.json',
  'src/build.mjs',
  'src/device.mjs',
  'src/mcp.mjs',
  'src/project.mjs',
  'src/server.mjs'
];
for (const file of files) assert.ok(existsSync(new URL('../' + file, import.meta.url)), file);
assert.ok(!files.some((file) => file.startsWith('test/') || file.startsWith('.runtime/')));
console.log('package: ok');
