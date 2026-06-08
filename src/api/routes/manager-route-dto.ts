import type { ManagerTask, ManagerTaskEvent } from '../manager-store.js';
import type { ManagerTaskDetails, ManagerReminder } from '../manager-service.js';

export function taskDto(task: ManagerTask) {
  return {
    id: task.id,
    traceId: task.traceId,
    workflowId: metadataString(task.metadata, 'workflowId'),
    substatus: taskSubstatus(task),
    availableActions: taskAvailableActions(task),
    managerBotName: task.managerBotName,
    managerChatId: task.managerChatId,
    workerBotName: task.workerBotName,
    workerChatId: task.workerChatId,
    label: task.label,
    prompt: task.prompt,
    status: task.status,
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
    startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
    completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
    costUsd: task.costUsd,
    durationMs: task.durationMs,
    resultText: task.resultText,
    error: task.error,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    nextAttemptAt: task.nextAttemptAt ? new Date(task.nextAttemptAt).toISOString() : undefined,
    lastCheckpointAt: task.lastCheckpointAt ? new Date(task.lastCheckpointAt).toISOString() : undefined,
    lastCheckpointPreview: metadataString(task.metadata, 'lastCheckpointPreview'),
    lastRetryReason: task.lastRetryReason,
    metadata: task.metadata,
  };
}

export function taskSummaryDto(task: ManagerTask) {
  return {
    id: task.id,
    traceId: task.traceId,
    workflowId: metadataString(task.metadata, 'workflowId'),
    relatedTaskId: metadataString(task.metadata, 'relatedTaskId'),
    sideEffectClass: metadataString(task.metadata, 'sideEffectClass'),
    substatus: taskSubstatus(task),
    availableActions: taskAvailableActions(task),
    managerBotName: task.managerBotName,
    managerChatId: task.managerChatId,
    workerBotName: task.workerBotName,
    workerChatId: task.workerChatId,
    label: task.label,
    prompt: truncateText(task.prompt, 240),
    status: task.status,
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
    startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
    completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
    costUsd: task.costUsd,
    durationMs: task.durationMs,
    nextAttemptAt: task.nextAttemptAt ? new Date(task.nextAttemptAt).toISOString() : undefined,
    error: task.error ? truncateText(task.error, 300) : undefined,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    lastCheckpointAt: task.lastCheckpointAt ? new Date(task.lastCheckpointAt).toISOString() : undefined,
    lastCheckpointPreview: metadataString(task.metadata, 'lastCheckpointPreview'),
    lastRetryReason: task.lastRetryReason ? truncateText(task.lastRetryReason, 200) : undefined,
  };
}

export function eventDto(event: ManagerTaskEvent) {
  return {
    id: event.id,
    taskId: event.taskId,
    type: event.type,
    payload: event.payload,
    createdAt: new Date(event.createdAt).toISOString(),
  };
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function taskSubstatus(task: ManagerTask): string {
  if (task.status === 'queued' && task.nextAttemptAt && task.nextAttemptAt > Date.now()) return 'retrying';
  if (task.status === 'queued' && task.lastRetryReason) return 'retry_queued';
  if (task.status === 'queued' && task.metadata?.resumeRequestedAt) return 'resuming';
  if (task.status === 'failed' && task.metadata?.workerResultError) return 'result_invalid';
  return task.status;
}

function taskAvailableActions(task: ManagerTask): Array<'cancel' | 'resume'> {
  if (task.status === 'queued' || task.status === 'running') return ['cancel'];
  if (task.status === 'failed') return ['resume'];
  return [];
}

export function detailsDto(details: ManagerTaskDetails) {
  return {
    task: taskDto(details),
    ...(details.events ? { events: details.events.map(eventDto) } : {}),
  };
}

export function reminderDto(reminder: ManagerReminder) {
  if (reminder.type === 'one-time') {
    return {
      ...reminder,
      executeAt: new Date(reminder.executeAt).toISOString(),
      createdAt: new Date(reminder.createdAt).toISOString(),
    };
  }
  return {
    ...reminder,
    nextExecuteAt: new Date(reminder.nextExecuteAt).toISOString(),
    lastExecutedAt: reminder.lastExecutedAt ? new Date(reminder.lastExecutedAt).toISOString() : undefined,
    lastFailureAt: reminder.lastFailureAt ? new Date(reminder.lastFailureAt).toISOString() : undefined,
    createdAt: new Date(reminder.createdAt).toISOString(),
  };
}
