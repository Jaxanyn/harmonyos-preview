import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { startMcp } from '../src/mcp.mjs';

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node scripts/preview-benchmark.mjs --device <id> [--actions 3] [--x 1] [--y 1]');
  process.exit(0);
}
if (!options.device) throw new Error('--device is required');

const input = new PassThrough();
const output = new PassThrough();
const responses = createInterface({ input: output })[Symbol.asyncIterator]();
let requestId = 0;

async function request(method, params) {
  const id = ++requestId;
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  while (true) {
    const next = await responses.next();
    if (next.done) throw new Error('MCP output closed');
    const response = JSON.parse(next.value);
    if (response.id === id) return response;
  }
}

const running = startMcp({ input, output, port: 0, projectPath: '' });
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harmonyos-preview-benchmark', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const started = await request('tools/call', { name: 'preview_start', arguments: { deviceId: options.device } });
  if (started.result?.isError) throw new Error(started.result.content?.[0]?.text ?? 'preview_start failed');
  let frame = (await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } })).result.structuredContent;
  const samples = [];
  for (let index = 0; index < options.actions; index += 1) {
    const startedAt = performance.now();
    const action = await request('tools/call', { name: 'preview_action', arguments: {
      action: 'tap', seq: frame.seq, x: options.x, y: options.y
    } });
    if (action.result?.isError) throw new Error(action.result.content?.[0]?.text ?? 'preview_action failed');
    const next = (await request('tools/call', { name: 'preview_frame', arguments: {
      afterSeq: frame.seq, waitMs: 2500
    } })).result.structuredContent;
    if (!next.frame) throw new Error('preview_frame returned no frame after action');
    samples.push({
      index: index + 1,
      actionRoundTripMs: Math.round(performance.now() - startedAt),
      actionMs: action.result.structuredContent?.metrics?.actionMs ?? null,
      captureMs: next.metrics?.captureMs ?? null,
      frameAgeMs: next.frameAgeMs ?? null,
      frameBytes: next.metrics?.frameBytes ?? null,
      width: next.frame.width ?? null,
      height: next.frame.height ?? null,
      frameSource: next.frameSource ?? null,
      seq: next.seq
    });
    frame = next;
  }
  console.log(JSON.stringify({ deviceId: options.device, x: options.x, y: options.y, samples }, null, 2));
} finally {
  input.end();
  await running;
}

function parseArguments(args) {
  const result = { actions: 3, x: 1, y: 1, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    if (!['--device', '--actions', '--x', '--y'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++index];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === '--device') result.device = value;
    else if (arg === '--actions') result.actions = positiveInteger(value, arg);
    else if (arg === '--x') result.x = nonNegativeNumber(value, arg);
    else if (arg === '--y') result.y = nonNegativeNumber(value, arg);
  }
  return result;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error(`${name} must be an integer from 1 to 100`);
  return parsed;
}

function nonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}
