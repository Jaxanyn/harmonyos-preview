#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: harmonyos-preview [--project <HarmonyOS project>]');
  process.exit(0);
}

const projectIndex = args.indexOf('--project');
if (projectIndex >= 0) {
  const projectPath = args[projectIndex + 1];
  if (!projectPath || projectPath.startsWith('-')) throw new Error('--project requires a path');
  process.env.HARMONY_PROJECT = projectPath;
}

const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const child = spawn(process.execPath, [server], { env: process.env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
