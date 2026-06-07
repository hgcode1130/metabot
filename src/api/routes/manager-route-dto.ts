import type { ManagerTask, ManagerTaskEvent } from '../manager-store.js';
import type { ManagerTaskDetails, ManagerReminder } from '../manager-service.js';

export function taskDto(task: ManagerTask) {
  return {
    id: task.id,
    traceId: task.traceId,
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
    lastRetryReason: task.lastRetryReason,
    metadata: task.metadata,
  };
}

export function taskSummaryDto(task: ManagerTask) {
  return {
    id: task.id,
    traceId: task.traceId,
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
    error: task.error ? truncateText(task.error, 300) : undefined,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    lastCheckpointAt: task.lastCheckpointAt ? new Date(task.lastCheckpointAt).toISOString() : undefined,
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
