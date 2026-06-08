import type { ManagerTaskEvent, ManagerTaskStatus } from './manager-store.js';
import type { ManagerEvidence } from './manager-work-log.js';

export interface ManagerTraceCoverage {
  supportedClaims: number;
  unsupportedClaims: number;
  traceCoverageRate: number;
  unsupportedClaim: boolean;
  claimTraces: ManagerClaimTrace[];
}

export interface ManagerClaimTrace {
  claim: string;
  supported: boolean;
  taskId: string;
  traceId: string;
  workerBotName: string;
  evidence: ManagerClaimEvidence;
  timestamp?: number;
}

export interface ManagerClaimEvidence {
  files: string[];
  commands: string[];
  artifacts: unknown[];
  eventTypes: string[];
}

export interface TaskTraceCoverageInput {
  taskId: string;
  traceId: string;
  workerBotName: string;
  status: ManagerTaskStatus;
  result?: Record<string, unknown>;
  evidence: ManagerEvidence;
  events: ManagerTaskEvent[];
}

export function taskTraceCoverage(input: TaskTraceCoverageInput): ManagerTraceCoverage {
  const claims = taskClaims(input.result);
  if (input.status !== 'completed') return coverageFromClaims([]);
  if (claims.length === 0) return coverageFromClaims([unsupportedTaskClaim(input)]);
  return coverageFromClaims(claims.map((claim) => claimTrace(input, claim)));
}

export function workflowTraceCoverage(
  logs: Array<{ traceCoverage: ManagerTraceCoverage }>,
): ManagerTraceCoverage {
  const claimTraces = logs.flatMap((log) => log.traceCoverage.claimTraces);
  return coverageFromClaims(claimTraces);
}

function taskClaims(result: Record<string, unknown> | undefined): string[] {
  if (!result) return [];
  return [
    stringClaim(result.summary),
    ...arrayClaims(result.actionsTaken),
    ...verificationClaims(result.verification),
  ].filter((claim): claim is string => !!claim);
}

function claimTrace(input: TaskTraceCoverageInput, claim: string): ManagerClaimTrace {
  const supported = hasEvidence(input.evidence);
  return {
    claim,
    supported,
    taskId: input.taskId,
    traceId: input.traceId,
    workerBotName: input.workerBotName,
    evidence: {
      files: input.evidence.files,
      commands: input.evidence.commands,
      artifacts: input.evidence.artifacts,
      eventTypes: input.evidence.eventTypes,
    },
    timestamp: evidenceTimestamp(input.events),
  };
}

function unsupportedTaskClaim(input: TaskTraceCoverageInput): ManagerClaimTrace {
  return {
    claim: 'completed task without structured worker claims',
    supported: false,
    taskId: input.taskId,
    traceId: input.traceId,
    workerBotName: input.workerBotName,
    evidence: {
      files: input.evidence.files,
      commands: input.evidence.commands,
      artifacts: input.evidence.artifacts,
      eventTypes: input.evidence.eventTypes,
    },
    timestamp: evidenceTimestamp(input.events),
  };
}

function coverageFromClaims(claims: ManagerClaimTrace[]): ManagerTraceCoverage {
  const supported = claims.filter((claim) => claim.supported).length;
  const unsupported = claims.length - supported;
  return {
    supportedClaims: supported,
    unsupportedClaims: unsupported,
    traceCoverageRate: claims.length === 0 ? 1 : supported / claims.length,
    unsupportedClaim: unsupported > 0,
    claimTraces: claims,
  };
}

function verificationClaims(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== 'object') return undefined;
    const record = item as Record<string, unknown>;
    const command = stringClaim(record.command) ?? 'verification';
    const status = stringClaim(record.status) ?? 'unknown';
    return `${command}: ${status}`;
  }).filter((claim): claim is string => !!claim);
}

function arrayClaims(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function hasEvidence(evidence: ManagerEvidence): boolean {
  return evidence.files.length + evidence.commands.length + evidence.artifacts.length > 0;
}

function evidenceTimestamp(events: ManagerTaskEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (isEvidenceEvent(event)) return event.createdAt;
  }
  return undefined;
}

function isEvidenceEvent(event: ManagerTaskEvent): boolean {
  return event.type === 'worker_result'
    || event.type === 'artifact_registered'
    || event.type === 'completed'
    || event.type === 'worker_update';
}
