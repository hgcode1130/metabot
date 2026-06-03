import type * as http from 'node:http';
import type { ManagerScope, ManagerTaskDetails, ManagerReminder } from '../manager-service.js';
import type { ManagerTask, ManagerTaskEvent, ManagerTaskStatus } from '../manager-store.js';
import type { RouteContext } from './types.js';
import { jsonResponse, parseJsonBody } from './helpers.js';

const VALID_TASK_STATUSES = new Set<ManagerTaskStatus>(['queued', 'running', 'completed', 'failed', 'cancelled']);

export async function handleManagerRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (!url.startsWith('/api/manager/')) return false;

  const service = ctx.managerService;
  if (!service) {
    jsonResponse(res, 503, { error: 'Manager service is not enabled' });
    return true;
  }

  const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
  const path = parsedUrl.pathname;

  try {
    if (method === 'GET' && path === '/api/manager/workers') {
      const scope = scopeFromSearch(parsedUrl);
      jsonResponse(res, 200, { workers: service.listWorkers(scope) });
      return true;
    }

    if (method === 'POST' && path === '/api/manager/tasks') {
      const body = await parseJsonBody(req);
      const scope = scopeFromBody(body);
      const workerBotName = requireString(body.workerBotName, 'workerBotName');
      const prompt = requireString(body.prompt, 'prompt');
      const task = await service.dispatchTask(scope, {
        workerBotName,
        prompt,
        label: optionalString(body.label),
        sessionKey: optionalString(body.sessionKey),
        sendCards: optionalBoolean(body.sendCards),
        waitTimeoutSeconds: optionalNumber(body.waitTimeoutSeconds),
        metadata: optionalObject(body.metadata),
      });
      jsonResponse(res, 201, { task: taskDto(task) });
      return true;
    }

    if (method === 'GET' && path === '/api/manager/tasks') {
      const scope = scopeFromSearch(parsedUrl);
      const status = optionalStatus(parsedUrl.searchParams.get('status'));
      const tasks = service.listTasks(scope, {
        workerBotName: optionalSearchString(parsedUrl, 'workerBotName'),
        status,
        limit: optionalSearchNumber(parsedUrl, 'limit'),
      });
      jsonResponse(res, 200, { tasks: tasks.map(taskDto) });
      return true;
    }

    const eventsMatch = path.match(/^\/api\/manager\/tasks\/([^/]+)\/events$/);
    if (method === 'GET' && eventsMatch) {
      const scope = scopeFromSearch(parsedUrl);
      const taskId = decodeURIComponent(eventsMatch[1]);
      const details = service.getTask(scope, taskId, { includeEvents: true });
      if (!details) {
        jsonResponse(res, 404, { error: `Manager task not found: ${taskId}` });
        return true;
      }
      jsonResponse(res, 200, { events: (details.events ?? []).map(eventDto) });
      return true;
    }

    const taskMatch = path.match(/^\/api\/manager\/tasks\/([^/]+)$/);
    if (method === 'GET' && taskMatch) {
      const scope = scopeFromSearch(parsedUrl);
      const taskId = decodeURIComponent(taskMatch[1]);
      const includeEvents = parsedUrl.searchParams.get('includeEvents') === 'true';
      const details = service.getTask(scope, taskId, { includeEvents });
      if (!details) {
        jsonResponse(res, 404, { error: `Manager task not found: ${taskId}` });
        return true;
      }
      jsonResponse(res, 200, detailsDto(details));
      return true;
    }

    const cancelTaskMatch = path.match(/^\/api\/manager\/tasks\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelTaskMatch) {
      const body = await parseJsonBody(req);
      const scope = scopeFromBody(body);
      const taskId = decodeURIComponent(cancelTaskMatch[1]);
      const cancelled = service.cancelTask(scope, taskId, optionalString(body.reason) ?? 'Cancelled via manager API');
      jsonResponse(res, cancelled ? 200 : 404, cancelled ? { id: taskId, status: 'cancelled' } : { error: `Manager task not cancellable: ${taskId}` });
      return true;
    }

    if (method === 'POST' && path === '/api/manager/reminders') {
      const body = await parseJsonBody(req);
      const scope = scopeFromBody(body);
      const reminder = service.scheduleReminder(scope, {
        prompt: requireString(body.prompt, 'prompt'),
        delaySeconds: optionalNumber(body.delaySeconds),
        cronExpr: optionalString(body.cronExpr),
        timezone: optionalString(body.timezone),
        label: optionalString(body.label),
        sendCards: optionalBoolean(body.sendCards),
        traceId: optionalString(body.traceId),
      });
      jsonResponse(res, 201, { reminder: reminderDto(reminder) });
      return true;
    }

    if (method === 'GET' && path === '/api/manager/reminders') {
      const scope = scopeFromSearch(parsedUrl);
      jsonResponse(res, 200, { reminders: service.listReminders(scope).map(reminderDto) });
      return true;
    }

    const reminderMatch = path.match(/^\/api\/manager\/reminders\/([^/]+)$/);
    if (method === 'DELETE' && reminderMatch) {
      const scope = scopeFromSearch(parsedUrl);
      const reminderId = decodeURIComponent(reminderMatch[1]);
      const cancelled = service.cancelReminder(scope, reminderId);
      jsonResponse(res, cancelled ? 200 : 404, cancelled ? { id: reminderId, status: 'cancelled' } : { error: `Manager reminder not found or not cancellable: ${reminderId}` });
      return true;
    }
  } catch (err: any) {
    const statusCode = err.statusCode || (err.message?.includes('not found') ? 404 : 400);
    jsonResponse(res, statusCode, { error: err.message || 'Manager API error' });
    return true;
  }

  return false;
}

function scopeFromBody(body: Record<string, unknown>): ManagerScope {
  return {
    managerBotName: requireString(body.managerBotName, 'managerBotName'),
    managerChatId: requireString(body.managerChatId, 'managerChatId'),
  };
}

function scopeFromSearch(url: URL): ManagerScope {
  return {
    managerBotName: requireSearchString(url, 'managerBotName'),
    managerChatId: requireSearchString(url, 'managerChatId'),
  };
}

function requireSearchString(url: URL, key: string): string {
  const value = url.searchParams.get(key)?.trim();
  if (!value) throw Object.assign(new Error(`Missing required query parameter: ${key}`), { statusCode: 400 });
  return value;
}

function optionalSearchString(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value || undefined;
}

function optionalSearchNumber(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value == null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw Object.assign(new Error(`${key} must be a number`), { statusCode: 400 });
  return parsed;
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`Missing required field: ${key}`), { statusCode: 400 });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw Object.assign(new Error('Expected a number'), { statusCode: 400 });
  return parsed;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalStatus(value: string | null): ManagerTaskStatus | undefined {
  if (!value) return undefined;
  if (!VALID_TASK_STATUSES.has(value as ManagerTaskStatus)) {
    throw Object.assign(new Error(`Invalid task status: ${value}`), { statusCode: 400 });
  }
  return value as ManagerTaskStatus;
}

function taskDto(task: ManagerTask) {
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
    metadata: task.metadata,
  };
}

function eventDto(event: ManagerTaskEvent) {
  return {
    id: event.id,
    taskId: event.taskId,
    type: event.type,
    payload: event.payload,
    createdAt: new Date(event.createdAt).toISOString(),
  };
}

function detailsDto(details: ManagerTaskDetails) {
  return {
    task: taskDto(details),
    ...(details.events ? { events: details.events.map(eventDto) } : {}),
  };
}

function reminderDto(reminder: ManagerReminder) {
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
    createdAt: new Date(reminder.createdAt).toISOString(),
  };
}
