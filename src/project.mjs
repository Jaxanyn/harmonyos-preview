import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readProjectConfig(projectPath, moduleName = 'entry') {
  const appConfig = readFileSync(join(projectPath, 'AppScope', 'app.json5'), 'utf8');
  assertModuleName(moduleName);
  const moduleConfig = readFileSync(join(projectPath, moduleName, 'src', 'main', 'module.json5'), 'utf8');
  const bundleName = appConfig.match(/"bundleName"\s*:\s*"([^"]+)"/)?.[1];
  const ability = moduleConfig.match(/"mainElement"\s*:\s*"([^"]+)"/)?.[1];
  if (!bundleName || !ability) throw new Error('Unable to read bundleName or mainElement');
  return { projectPath, moduleName, bundleName, ability };
}

export function findHap(projectPath, moduleName = 'entry', artifactName) {
  assertModuleName(moduleName);
  if (artifactName !== undefined) assertArtifactName(artifactName);
  const buildPath = join(projectPath, moduleName, 'build');
  if (!existsSync(buildPath)) throw new Error(`Build output directory not found: ${buildPath}`);
  const artifacts = findFiles(buildPath).filter((path) => artifactName === undefined || path.endsWith(`\\${artifactName}`) || path.endsWith(`/${artifactName}`));
  if (artifacts.length === 0) {
    if (artifactName) throw new Error(`HAP artifact not found under ${buildPath}: ${artifactName}`);
    throw new Error(`No HAP found under ${buildPath}`);
  }
  if (artifacts.length > 1) {
    const signed = artifacts.filter((path) => /-signed\.hap$/i.test(path));
    if (signed.length === 1) return signed[0];
    throw new Error(`Multiple HAP artifacts found under ${buildPath}; specify artifactName`);
  }
  return artifacts[0];
}

function findFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.hap')) files.push(path);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...findFiles(path));
    }
  }
  return files;
}

function assertModuleName(moduleName) {
  if (typeof moduleName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(moduleName)) {
    throw new Error(`Invalid moduleName: ${String(moduleName)}`);
  }
}

function assertArtifactName(artifactName) {
  if (typeof artifactName !== 'string' || !/^[A-Za-z0-9._-]+\.hap$/.test(artifactName)) {
    throw new Error(`Invalid artifactName: ${String(artifactName)}`);
  }
}
