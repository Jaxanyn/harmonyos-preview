#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: harmonyos-preview [--mcp] [--project <HarmonyOS project>]');
  process.exit(0);
}

const projectIndex = args.indexOf('--project');
if (projectIndex >= 0) {
  const projectPath = args[projectIndex + 1];
  if (!projectPath || projectPath.startsWith('-')) throw new Error('--project requires a path');
  process.env.HARMONY_PROJECT = projectPath;
}

if (args.includes('--mcp')) {
  const { startMcp } = await import('../src/mcp.mjs');
  await startMcp();
} else {
  const { createPreviewServer } = await import('../src/server.mjs');
  const host = process.env.HARMONY_PREVIEW_HOST ?? '127.0.0.1';
  const port = Number(process.env.HARMONY_PREVIEW_PORT ?? 4100);
  createPreviewServer().listen(port, host, () => console.log(`HarmonyOS Preview listening at http://${host}:${port}`));
}
