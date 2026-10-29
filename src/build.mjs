import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { findHap, readProjectConfig } from './project.mjs';
import { tagError } from './diagnostics.mjs';

const defaultTimeoutMs = Number(process.env.HARMONY_PREVIEW_BUILD_TIMEOUT_MS ?? 300000);

export async function buildProject(projectPath, { timeoutMs = defaultTimeoutMs, moduleName, signal } = {}) {
  const script = join(projectPath, 'build-local.ps1');
  try {
    const env = moduleName ? { HARMONY_PREVIEW_MODULE: moduleName } : undefined;
    if (existsSync(script)) return await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], projectPath, timeoutMs, env, signal);
    const args = ['build', '--project', projectPath];
    if (moduleName) args.push('--modules', moduleName);
    return await run(process.env.DEVECO_CLI ?? 'devecocli', args, projectPath, timeoutMs, env, signal);
  } catch (error) { throw tagError(error, 'BUILD_FAILED', 'build'); }
}

export const resolveHap = findHap;

export async function buildAndRun(deviceAdapter, { projectPath, deviceId, moduleName = 'entry', artifactName, signal }, onStatus = () => {}) {
  if (!projectPath) throw tagError(new Error('HARMONY_PROJECT is not configured'), 'BUILD_FAILED', 'build_config');
  if (!deviceId) throw tagError(new Error('deviceId is required'), 'BUILD_FAILED', 'build_config');
  let config;
  try { config = readProjectConfig(projectPath, moduleName); } catch (error) { throw tagError(error, 'BUILD_FAILED', 'build_config'); }
  onStatus('Building');
  const result = await buildProject(projectPath, { moduleName, signal });
  if (result.code !== 0) throw tagError(Object.assign(new Error(result.stderr.trim() || result.stdout.trim() || 'build failed'), { exitCode: result.code }), result.code === 124 ? 'BUILD_TIMEOUT' : 'BUILD_FAILED', 'build');
  let hapPath;
  try { hapPath = resolveHap(projectPath, config.moduleName, artifactName); } catch (error) { throw tagError(error, 'BUILD_FAILED', 'build_artifact'); }
  onStatus('Installing');
  try { await deviceAdapter.install({ deviceId, hapPath }, { signal }); } catch (error) { throw tagError(error, 'BUILD_FAILED', 'install'); }
  onStatus('Launching');
  try { await deviceAdapter.launch({ deviceId, bundleName: config.bundleName, ability: config.ability, moduleName: config.moduleName }, { signal }); } catch (error) { throw tagError(error, 'BUILD_FAILED', 'launch'); }
  return { deviceId, moduleName: config.moduleName, artifactName: hapPath.split(/[\\/]/).pop(), hapPath, bundleName: config.bundleName, ability: config.ability };
}

function run(command, args, cwd, timeoutMs, extraEnv, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('Operation cancelled'), { name: 'AbortError', code: 'ABORT_ERR' })); return; }
    const child = spawn(command, args, { cwd, windowsHide: true, env: extraEnv ? { ...process.env, ...extraEnv } : undefined, signal });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminating = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      stderr += 'build timed out';
      terminating = true;
      terminateProcessTree(child).finally(() => {
        if (settled) return;
        settled = true;
        resolve({ code: 124, stdout, stderr });
      });
    }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { if (timer) clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!settled && !terminating) { settled = true; resolve({ code: code ?? 1, stdout, stderr }); }
    });
  });
}

function terminateProcessTree(child) {
  if (process.platform === 'win32' && child.pid) return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', resolve);
    killer.once('close', resolve);
  });
  try { child.kill(); } catch {}
  return Promise.resolve();
}
