import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.platform !== 'win32') {
  console.log('install: skipped (Windows PowerShell installer)');
} else {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const script = join(root, 'scripts', 'install-codex.ps1');
  const project = join(root, 'test');
  const result = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-ProjectPath', project, '-CheckOnly', '-SkipDeviceCheck'], { windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Check complete/);
  console.log('install: ok');
}
