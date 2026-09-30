import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readProjectConfig(projectPath) {
  const appConfig = readFileSync(join(projectPath, 'AppScope', 'app.json5'), 'utf8');
  const moduleConfig = readFileSync(join(projectPath, 'entry', 'src', 'main', 'module.json5'), 'utf8');
  const bundleName = appConfig.match(/"bundleName"\s*:\s*"([^"]+)"/)?.[1];
  const ability = moduleConfig.match(/"mainElement"\s*:\s*"([^"]+)"/)?.[1];
  if (!bundleName || !ability) throw new Error('Unable to read bundleName or mainElement');
  return { projectPath, moduleName: 'entry', bundleName, ability };
}

export function findHap(projectPath, moduleName = 'entry') {
  const buildPath = join(projectPath, moduleName, 'build');
  if (!existsSync(buildPath)) throw new Error(`Build output directory not found: ${buildPath}`);
  const hap = findFile(buildPath);
  if (!hap) throw new Error(`No HAP found under ${buildPath}`);
  return hap;
}

function findFile(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.hap')) return path;
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const found = findFile(path);
      if (found) return found;
    }
  }
  return null;
}
