import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { findHap } from './project.mjs';

export async function buildProject(projectPath) {
  const script = join(projectPath, 'build-local.ps1');
  if (existsSync(script)) return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], projectPath);
  return run(process.env.DEVECO_CLI ?? 'devecocli', ['build', '--project', projectPath], projectPath);
}

export const resolveHap = findHap;

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
