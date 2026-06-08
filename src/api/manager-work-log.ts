import type { ManagerTask, ManagerTaskEvent, ManagerTaskStatus } from './manager-store.js';
import {
  taskTraceCoverage,
  workflowTraceCoverage,
  type ManagerTraceCoverage,
} from './manager-trace-coverage.js';

export interface ManagerTaskWorkLog {
  taskId: string;
  traceId: string;
  workflowId?: string;
  status: ManagerTaskStatus;
  substatus: string;
  managerBotName: string;
  managerChatId: string;
  workerBotName: string;
  taskTemplate?: string;
  sideEffectClass?: string;
  promptPreview: string;
  costUsd?: number;
  durationMs?: number;
  attempts: { current: number; max: number };
  roles: ManagerWorkLogRoles;
  delegation: Record<string, unknown>;
  evidence: ManagerEvidence;
  verification: ManagerVerificationSummary;
  risks: string[];
  nextAction?: string;
  traceCoverage: ManagerTraceCoverage;
  events: ManagerEventSummary[];
  summaryMarkdown: string;
}

export interface ManagerWorkflowWorkLog {
  workflowId: string;
  managerBotName: string;
  managerChatId?: string;
  workerCount: number;
  cancelledWorkers: number;
  actualCostUsd: number;
  statusCounts: Record<ManagerTaskStatus, number>;
  traceCoverage: ManagerTraceCoverage;
  tasks: ManagerTaskWorkLog[];
  summaryMarkdown: string;
}

export interface ManagerWorkLogRoles {
  manager: string;
  worker: string;
  subagent: string;
}

export interface ManagerEvidence {
  files: string[];
  commands: string[];
  artifacts: unknown[];
  eventTypes: string[];
}

export interface ManagerVerificationSummary {
  performed: unknown[];
  notRun: unknown[];
}

export interface ManagerEventSummary {
  type: string;
  createdAt: number;
}

export function buildTaskWorkLog(task: ManagerTask, events: ManagerTaskEvent[] = []): ManagerTaskWorkLog {
  const result = readRecord(task.metadata?.workerResult);
  const evidence = taskEvidence(result, events);
  const traceCoverage = taskTraceCoverage({
    taskId: task.id,
    traceId: task.traceId,
    workerBotName: task.workerBotName,
    status: task.status,
    result,
    evidence,
    events,
  });
  const log = baseTaskWorkLog(task, events, evidence, traceCoverage);
  return { ...log, summaryMarkdown: taskSummaryMarkdown(log) };
}

export function buildWorkflowWorkLog(
  workflowId: string,
  tasks: ManagerTask[],
  eventsByTaskId: Map<string, ManagerTaskEvent[]>,
): ManagerWorkflowWorkLog {
  const logs = tasks.map((task) => buildTaskWorkLog(task, eventsByTaskId.get(task.id) ?? []));
  const traceCoverage = workflowTraceCoverage(logs);
  const log = {
    workflowId,
    managerBotName: tasks[0]?.managerBotName ?? '',
    managerChatId: commonManagerChatId(tasks),
    workerCount: logs.length,
    cancelledWorkers: logs.filter((task) => task.status === 'cancelled').length,
    actualCostUsd: sumCosts(logs),
    statusCounts: statusCounts(logs),
    traceCoverage,
    tasks: logs,
    summaryMarkdown: '',
  };
  return { ...log, summaryMarkdown: workflowSummaryMarkdown(log) };
}

function baseTaskWorkLog(
  task: ManagerTask,
  events: ManagerTaskEvent[],
  evidence: ManagerEvidence,
  traceCoverage: ManagerTraceCoverage,
): Omit<ManagerTaskWorkLog, 'summaryMarkdown'> {
  const result = readRecord(task.metadata?.workerResult);
  const verification = readArray(result?.verification);
  return {
    taskId: task.id,
    traceId: task.traceId,
    workflowId: metadataString(task.metadata, 'workflowId'),
    status: task.status,
    substatus: taskSubstatus(task),
    managerBotName: task.managerBotName,
    managerChatId: task.managerChatId,
    workerBotName: task.workerBotName,
    taskTemplate: metadataString(task.metadata, 'taskTemplate'),
    sideEffectClass: metadataString(task.metadata, 'sideEffectClass'),
    promptPreview: truncate(task.prompt, 240),
    costUsd: task.costUsd,
    durationMs: task.durationMs,
    attempts: { current: task.attemptCount, max: task.maxAttempts },
    roles: managerWorkLogRoles(),
    delegation: taskDelegation(task),
    evidence,
    verification: {
      performed: verification.filter((item) => readStatus(item) !== 'not_run'),
      notRun: verification.filter((item) => readStatus(item) === 'not_run'),
    },
    risks: readStringArray(result?.risks),
    nextAction: metadataString(result, 'nextAction'),
    traceCoverage,
    events: events.map((event) => ({ type: event.type, createdAt: event.createdAt })),
  };
}

function taskEvidence(result: Record<string, unknown> | undefined, events: ManagerTaskEvent[]): ManagerEvidence {
  return {
    files: readStringArray(result?.files),
    commands: readStringArray(result?.commands),
    artifacts: readArray(result?.artifacts),
    eventTypes: Array.from(new Set(events.map((event) => event.type))),
  };
}

function taskDelegation(task: ManagerTask): Record<string, unknown> {
  return {
    reason: metadataString(task.metadata, 'delegationReason'),
    relatedTaskId: metadataString(task.metadata, 'relatedTaskId'),
    budget: readRecord(task.metadata?.delegationBudget),
  };
}

function taskSummaryMarkdown(log: Omit<ManagerTaskWorkLog, 'summaryMarkdown'>): string {
  return [
    '## 完成情况',
    `- 状态：${log.substatus}`,
    `- Worker：${log.workerBotName}`,
    `- 文件改动/证据：${log.evidence.files.length} file(s), ${log.evidence.commands.length} command(s)`,
    `- 验证：${log.verification.performed.length} performed, ${log.verification.notRun.length} not_run`,
    '',
    '## Worker trace',
    `- ${log.workerBotName} / ${log.taskId} / ${log.traceId}`,
    '',
    '## 证据与风险',
    `- Trace coverage：${Math.round(log.traceCoverage.traceCoverageRate * 100)}%`,
    `- Unsupported claim：${String(log.traceCoverage.unsupportedClaim)}`,
    `- Risks：${log.risks.length > 0 ? log.risks.join('; ') : 'none reported'}`,
  ].join('\n');
}

function workflowSummaryMarkdown(log: ManagerWorkflowWorkLog): string {
  return [
    '## 完成情况',
    `- Workflow：${log.workflowId}`,
    `- Worker tasks：${log.workerCount}`,
    `- Cancelled workers：${log.cancelledWorkers}`,
    `- Actual cost：$${log.actualCostUsd.toFixed(4)}`,
    '',
    '## Worker trace',
    ...log.tasks.map((task) => `- ${task.workerBotName} / ${task.taskId} / ${task.traceId}：${task.substatus}`),
    '',
    '## 证据与风险',
    `- Trace coverage：${Math.round(log.traceCoverage.traceCoverageRate * 100)}%`,
    `- Unsupported claims：${log.traceCoverage.unsupportedClaims}`,
  ].join('\n');
}

function statusCounts(logs: ManagerTaskWorkLog[]): Record<ManagerTaskStatus, number> {
  return logs.reduce((acc, log) => ({ ...acc, [log.status]: acc[log.status] + 1 }), {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  });
}

function managerWorkLogRoles(): ManagerWorkLogRoles {
  return {
    manager: 'MetaBot Manager: single user-facing orchestrator and final owner',
    worker: 'MetaBot Worker Bot: delegated bounded task executor',
    subagent: 'Claude Agent Team/Subagent: internal execution unit inside a manager or worker session',
  };
}

function commonManagerChatId(tasks: ManagerTask[]): string | undefined {
  const ids = new Set(tasks.map((task) => task.managerChatId));
  return ids.size === 1 ? tasks[0]?.managerChatId : undefined;
}

function sumCosts(logs: ManagerTaskWorkLog[]): number {
  return logs.reduce((sum, log) => sum + (log.costUsd ?? 0), 0);
}

function taskSubstatus(task: ManagerTask): string {
  if (task.status === 'failed' && task.metadata?.recoveryStatus === 'needs_resume_review') return 'needs_resume_review';
  if (task.status === 'failed' && task.metadata?.workerResultError) return 'result_invalid';
  if (task.status === 'queued' && task.metadata?.resumeRequestedAt) return 'resuming';
  if (task.status === 'queued' && task.nextAttemptAt && task.nextAttemptAt > Date.now()) return 'retrying';
  return task.status;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readStatus(value: unknown): string | undefined {
  const record = readRecord(value);
  return metadataString(record, 'status');
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
