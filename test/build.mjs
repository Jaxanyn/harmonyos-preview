import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAndRun, buildProject, resolveHap } from '../src/build.mjs';
import { readProjectConfig } from '../src/project.mjs';
import { tagError } from '../src/diagnostics.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-build-'));
try {
  await writeFile(join(directory, 'build-local.ps1'), 'Start-Sleep -Seconds 3');
  const result = await buildProject(directory, { timeoutMs: 250 });
  assert.equal(result.code, 124);
  assert.match(result.stderr, /build timed out/);
  await assert.rejects(buildAndRun({}, { deviceId: 'mock-device' }), (error) => {
    assert.equal(error.errorCode, 'BUILD_FAILED');
    assert.equal(error.stage, 'build_config');
    return true;
  });
  await assert.rejects(buildAndRun({}, { projectPath: join(directory, 'missing'), deviceId: 'mock-device' }), (error) => {
    assert.equal(error.errorCode, 'BUILD_FAILED');
    assert.equal(error.stage, 'build_config');
    assert.equal(error.code, 'ENOENT');
    return true;
  });
  await mkdir(join(directory, 'AppScope'));
  await mkdir(join(directory, 'entry', 'src', 'main'), { recursive: true });
  await writeFile(join(directory, 'AppScope', 'app.json5'), '{"app":{"bundleName":"com.example.test"}}');
  await writeFile(join(directory, 'entry', 'src', 'main', 'module.json5'), '{"module":{"mainElement":"EntryAbility"}}');
  await writeFile(join(directory, 'build-local.ps1'), 'exit 7');
  await assert.rejects(buildAndRun({}, { projectPath: directory, deviceId: 'mock-device' }), (error) => {
    assert.equal(error.errorCode, 'BUILD_FAILED');
    assert.equal(error.stage, 'build');
    assert.equal(error.exitCode, 7);
    return true;
  });
  await writeFile(join(directory, 'build-local.ps1'), 'exit 0');
  await assert.rejects(buildAndRun({}, { projectPath: directory, deviceId: 'mock-device' }), (error) => {
    assert.equal(error.errorCode, 'BUILD_FAILED');
    assert.equal(error.stage, 'build_artifact');
    return true;
  });
  await mkdir(join(directory, 'entry', 'build'));
  await writeFile(join(directory, 'entry', 'build', 'test.hap'), 'mock artifact');
  await assert.rejects(buildAndRun({ install: async () => {
    throw tagError(Object.assign(new Error('install HDC timed out'), { exitCode: 124 }), 'HDC_TIMEOUT', 'install');
  } }, { projectPath: directory, deviceId: 'mock-device' }), (error) => {
    assert.equal(error.errorCode, 'HDC_TIMEOUT', 'build wrapper must preserve the HDC source error');
    assert.equal(error.stage, 'install');
    assert.equal(error.exitCode, 124);
    return true;
  });
  await assert.rejects(buildAndRun({ install: async () => {}, launch: async () => { throw new Error('mock launch failed'); } },
    { projectPath: directory, deviceId: 'mock-device' }), (error) => {
    assert.equal(error.errorCode, 'BUILD_FAILED');
    assert.equal(error.stage, 'launch');
    return true;
  });

  await mkdir(join(directory, 'feature', 'src', 'main'), { recursive: true });
  await mkdir(join(directory, 'feature', 'build', 'default', 'outputs'), { recursive: true });
  await writeFile(join(directory, 'feature', 'src', 'main', 'module.json5'), '{"module":{"mainElement":"FeatureAbility"}}');
  await writeFile(join(directory, 'feature', 'build', 'default', 'outputs', 'feature-debug.hap'), 'debug artifact');
  await writeFile(join(directory, 'feature', 'build', 'default', 'outputs', 'feature-signed.hap'), 'signed artifact');
  assert.deepEqual(readProjectConfig(directory, 'feature'), {
    projectPath: directory, moduleName: 'feature', bundleName: 'com.example.test', ability: 'FeatureAbility'
  });
  assert.equal(resolveHap(directory, 'feature'), join(directory, 'feature', 'build', 'default', 'outputs', 'feature-signed.hap'));
  await writeFile(join(directory, 'feature', 'build', 'default', 'outputs', 'feature-other-signed.hap'), 'other signed artifact');
  await assert.rejects(Promise.resolve().then(() => resolveHap(directory, 'feature')), /Multiple HAP artifacts/);
  assert.equal(resolveHap(directory, 'feature', 'feature-signed.hap'), join(directory, 'feature', 'build', 'default', 'outputs', 'feature-signed.hap'));
  await assert.rejects(Promise.resolve().then(() => resolveHap(directory, '../entry')), /Invalid moduleName/);
  const installed = [];
  const launched = [];
  const featureRun = await buildAndRun({
    install: async (args) => installed.push(args),
    launch: async (args) => launched.push(args)
  }, { projectPath: directory, deviceId: 'mock-device', moduleName: 'feature', artifactName: 'feature-signed.hap' });
  assert.equal(featureRun.moduleName, 'feature');
  assert.equal(featureRun.artifactName, 'feature-signed.hap');
  assert.equal(installed[0].hapPath, featureRun.hapPath);
  assert.equal(launched[0].ability, 'FeatureAbility');
  assert.equal(launched[0].moduleName, 'feature');

  const previousCli = process.env.DEVECO_CLI;
  try {
    const missingCliDirectory = join(directory, 'no-cli');
    await mkdir(missingCliDirectory);
    process.env.DEVECO_CLI = join(missingCliDirectory, 'missing-devecocli.exe');
    await assert.rejects(buildProject(missingCliDirectory), (error) => {
      assert.equal(error.errorCode, 'BUILD_FAILED');
      assert.equal(error.stage, 'build');
      assert.equal(error.code, 'ENOENT');
      return true;
    });
  } finally {
    if (previousCli === undefined) delete process.env.DEVECO_CLI;
    else process.env.DEVECO_CLI = previousCli;
  }
  console.log('build timeout: ok');
} finally {
  // Windows taskkill can release the child's working directory just after the timeout result.
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
