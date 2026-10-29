import { readFileSync } from 'node:fs';

export const serverVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const diagnosticsVersion = 1;

export function tagError(error, errorCode, stage) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  tagged.errorCode ??= errorCode;
  tagged.stage ??= stage;
  return tagged;
}

export function toDiagnostic(error, { errorCode = 'TOOL_FAILED', stage = 'tool', deviceId = null, elapsedMs = 0 } = {}) {
  const message = error?.message ?? error?.error ?? String(error);
  const cause = error?.cause instanceof Error ? { message: error.cause.message,
    ...(error.cause.code ? { code: error.cause.code } : {}) } : error?.cause;
  return {
    error: message, errorCode: error?.errorCode ?? errorCode, stage: error?.stage ?? stage, deviceId: deviceId ?? error?.deviceId ?? null,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0,
    cause: cause ?? { message, ...(error?.code ? { code: error.code } : {}),
      ...(Number.isInteger(error?.exitCode) ? { exitCode: error.exitCode } : {}) }
  };
}
