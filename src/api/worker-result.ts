export const WORKER_RESULT_BLOCK_NAME = 'METABOT_WORKER_RESULT';

export interface WorkerArtifact {
  id?: string;
  path?: string;
  url?: string;
  type?: string;
  description?: string;
  sha256?: string;
}

export interface WorkerVerification {
  command?: string;
  status: 'passed' | 'failed' | 'not_run';
  details?: string;
}

export interface WorkerResult {
  summary: string;
  actionsTaken: string[];
  commands: string[];
  files: string[];
  artifacts: WorkerArtifact[];
  verification: WorkerVerification[];
  risks: string[];
  nextAction?: string;
}

export type WorkerResultParseResult =
  | { ok: true; result: WorkerResult }
  | { ok: false; error: string };

const FENCED_RESULT_RE = /```(?:json)?[^\n`]*METABOT_WORKER_RESULT[^\n`]*\n([\s\S]*?)```/i;
const MARKER_RESULT_RE = /METABOT_WORKER_RESULT\s*({[\s\S]*})/i;

export function parseWorkerResult(text: string | undefined): WorkerResultParseResult {
  const jsonText = extractWorkerResultJson(text);
  if (!jsonText) return { ok: false, error: 'METABOT_WORKER_RESULT block not found' };
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return { ok: true, result: normalizeWorkerResult(parsed) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON';
    return { ok: false, error: `Invalid METABOT_WORKER_RESULT JSON: ${message}` };
  }
}

export function workerResultSummary(result: WorkerResult): Record<string, unknown> {
  return {
    summary: result.summary,
    actionsTaken: result.actionsTaken,
    commands: result.commands,
    files: result.files,
    artifacts: result.artifacts,
    verification: result.verification,
    risks: result.risks,
    nextAction: result.nextAction,
  };
}

export function buildAcceptanceReport(
  criteria: string[],
  parseResult: WorkerResultParseResult,
): Record<string, unknown> {
  return {
    status: parseResult.ok ? 'worker_reported' : 'unstructured_worker_output',
    criteria: criteria.map((criterion) => ({
      criterion,
      status: 'not_deterministically_verified',
    })),
    workerSummary: parseResult.ok ? parseResult.result.summary : undefined,
    verification: parseResult.ok ? parseResult.result.verification : undefined,
  };
}

function extractWorkerResultJson(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const fenced = text.match(FENCED_RESULT_RE)?.[1];
  if (fenced) return fenced.trim();
  return text.match(MARKER_RESULT_RE)?.[1]?.trim();
}

function normalizeWorkerResult(value: Record<string, unknown>): WorkerResult {
  return {
    summary: readString(value.summary) ?? '',
    actionsTaken: readStringArray(value.actionsTaken),
    commands: readCommandArray(value.commands),
    files: readStringArray(value.files),
    artifacts: readArtifacts(value.artifacts),
    verification: readVerification(value.verification),
    risks: readStringArray(value.risks),
    nextAction: readString(value.nextAction),
  };
}

function readArtifacts(value: unknown): WorkerArtifact[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      id: readString(item.id),
      path: readString(item.path),
      url: readString(item.url),
      type: readString(item.type),
      description: readString(item.description),
      sha256: readString(item.sha256),
    }));
}

function readVerification(value: unknown): WorkerVerification[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      command: readString(item.command),
      status: readVerificationStatus(item.status),
      details: readString(item.details),
    }));
}

function readCommandArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item : readString((item as Record<string, unknown> | undefined)?.command))
    .filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readVerificationStatus(value: unknown): WorkerVerification['status'] {
  return value === 'passed' || value === 'failed' || value === 'not_run' ? value : 'not_run';
}
