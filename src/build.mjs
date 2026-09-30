import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { findHap, readProjectConfig } from './project.mjs';

const defaultTimeoutMs = Number(process.env.HARMONY_PREVIEW_BUILD_TIMEOUT_MS ?? 300000);

export async function buildProject(projectPath, { timeoutMs = defaultTimeoutMs } = {}) {
  const script = join(projectPath, 'build-local.ps1');
  if (existsSync(script)) return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], projectPath, timeoutMs);
  return run(process.env.DEVECO_CLI ?? 'devecocli', ['build', '--project', projectPath], projectPath, timeoutMs);
}

export const resolveHap = findHap;

export async function buildAndRun(deviceAdapter, { projectPath, deviceId }, onStatus = () => {}) {
  if (!projectPath) throw new Error('HARMONY_PROJECT is not configured');
  if (!deviceId) throw new Error('deviceId is required');
  const config = readProjectConfig(projectPath);
  onStatus('Building');
  const result = await buildProject(projectPath);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'build failed');
  const hapPath = resolveHap(projectPath, config.moduleName);
  onStatus('Installing');
  await deviceAdapter.install({ deviceId, hapPath });
  onStatus('Launching');
  await deviceAdapter.launch({ deviceId, bundleName: config.bundleName, ability: config.ability });
  return { deviceId, hapPath, bundleName: config.bundleName, ability: config.ability };
}

function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      stderr += 'build timed out';
      child.kill();
      settled = true;
      resolve({ code: 124, stdout, stderr });
    }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { if (timer) clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.on('close', (code) => { if (timer) clearTimeout(timer); if (!settled) { settled = true; resolve({ code: code ?? 1, stdout, stderr }); } });
  });
}
