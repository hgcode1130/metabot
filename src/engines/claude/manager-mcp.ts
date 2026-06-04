import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Logger } from '../../utils/logger.js';
import type { ManagerScope, ManagerService } from '../../api/manager-service.js';
import { WORKER_TASK_TEMPLATES } from '../../api/manager-worker-template.js';

export const MANAGER_MCP_SERVER_NAME = 'metabot-manager';
export const MANAGER_MCP_ALLOWED_TOOLS = [
  `mcp__${MANAGER_MCP_SERVER_NAME}__list_workers`,
  `mcp__${MANAGER_MCP_SERVER_NAME}__dispatch_worker_task`,
  `mcp__${MANAGER_MCP_SERVER_NAME}__send_worker_prompt`,
  `mcp__${MANAGER_MCP_SERVER_NAME}__stop_worker`,
  `mcp__${MANAGER_MCP_SERVER_NAME}__get_worker_task`,
  `mcp__${MANAGER_MCP_SERVER_NAME}__list_worker_tasks`,
  `mcp__${MANAGER_MCP_SERVER_NAME}__cancel_worker_task`,
  `mcp__${MANAGER_MCP_SERVER_NAME}__schedule_reminder`,
  `mcp__${MANAGER_MCP_SERVER_NAME}__list_reminders`,
  `mcp__${MANAGER_MCP_SERVER_NAME}__cancel_reminder`,
];

export interface ManagerMcpOptions {
  service: ManagerService;
  scope: ManagerScope;
  logger: Logger;
}

export function buildManagerMcpServer(options: ManagerMcpOptions): McpSdkServerConfigWithInstance {
  const { service, scope, logger } = options;
  return createSdkMcpServer({
    name: MANAGER_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        'list_workers',
        'List worker bots this manager may delegate tasks to. Use before delegating if you are unsure which worker to use.',
        { includeBusy: z.boolean().optional() },
        async () => safeTool(logger, 'list_workers', () => ({ workers: service.listWorkers(scope) })),
      ),
      tool(
        'dispatch_worker_task',
        'Delegate a task to a worker bot asynchronously. Returns a task ID; use get_worker_task or list_worker_tasks to inspect progress and results.',
        {
          workerBotName: z.string().min(1).describe('Allowed worker bot name'),
          prompt: z.string().min(1).describe('Task prompt for the worker'),
          label: z.string().optional(),
          sessionKey: z.string().optional().describe('Stable worker session key; same key preserves worker session context'),
          taskTemplate: z.enum(WORKER_TASK_TEMPLATES).optional().describe('Optional standardized output template: research, implementation, review, audit, or general'),
          relatedTaskId: z.string().optional().describe('Optional related manager task ID for implementation/review or research/analysis workflows'),
          workflowId: z.string().optional().describe('Optional stable workflow identifier shared by related worker tasks'),
          sendCards: z.boolean().optional().describe('Normally false so hidden worker sessions do not spam the user chat'),
          waitTimeoutSeconds: z.number().int().min(0).max(60).optional().describe('Optional short wait for quick tasks; long tasks should stay async'),
          metadata: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => safeTool(logger, 'dispatch_worker_task', async () => ({
          task: await service.dispatchTask(scope, args),
        })),
      ),
      tool(
        'send_worker_prompt',
        'Send an additional prompt to a worker session. This creates a new traceable delegated task in the same worker sessionKey.',
        {
          workerBotName: z.string().min(1),
          prompt: z.string().min(1),
          label: z.string().optional(),
          sessionKey: z.string().optional(),
          taskTemplate: z.enum(WORKER_TASK_TEMPLATES).optional(),
          relatedTaskId: z.string().optional(),
          workflowId: z.string().optional(),
          waitTimeoutSeconds: z.number().int().min(0).max(60).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => safeTool(logger, 'send_worker_prompt', async () => ({
          result: await service.sendWorkerPrompt(scope, { ...args, sendCards: false }),
        })),
      ),
      tool(
        'stop_worker',
        'Stop a running/queued worker task by task ID. Alias for cancel_worker_task, named for manager-worker workflows.',
        {
          taskId: z.string().min(1),
          reason: z.string().optional(),
        },
        async (args) => safeTool(logger, 'stop_worker', () => ({
          stopped: service.cancelTask(scope, args.taskId, args.reason ?? 'Stopped by manager'),
        })),
      ),
      tool(
        'get_worker_task',
        'Get one delegated worker task, optionally including the event timeline for traceability.',
        {
          taskId: z.string().min(1),
          includeEvents: z.boolean().optional(),
        },
        async (args) => safeTool(logger, 'get_worker_task', () => {
          const result = service.getTask(scope, args.taskId, { includeEvents: args.includeEvents });
          return result ?? { error: `Manager task not found: ${args.taskId}` };
        }),
      ),
      tool(
        'list_worker_tasks',
        'List delegated worker tasks for this manager chat, filtered by worker or status.',
        {
          workerBotName: z.string().optional(),
          status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        async (args) => safeTool(logger, 'list_worker_tasks', () => ({
          tasks: service.listTasks(scope, args),
        })),
      ),
      tool(
        'cancel_worker_task',
        'Cancel a queued or running delegated worker task. Running tasks are interrupted via the worker bridge when possible.',
        {
          taskId: z.string().min(1),
          reason: z.string().optional(),
        },
        async (args) => safeTool(logger, 'cancel_worker_task', () => ({
          cancelled: service.cancelTask(scope, args.taskId, args.reason),
        })),
      ),
      tool(
        'schedule_reminder',
        'Schedule a reminder or recurring manager-chat task. Provide exactly one of delaySeconds or cronExpr.',
        {
          prompt: z.string().min(1),
          delaySeconds: z.number().int().positive().optional(),
          cronExpr: z.string().optional(),
          timezone: z.string().optional(),
          label: z.string().optional(),
          sendCards: z.boolean().optional(),
          traceId: z.string().optional(),
        },
        async (args) => safeTool(logger, 'schedule_reminder', () => ({
          reminder: service.scheduleReminder(scope, args),
        })),
      ),
      tool(
        'list_reminders',
        'List reminders created by this manager chat.',
        {},
        async () => safeTool(logger, 'list_reminders', () => ({ reminders: service.listReminders(scope) })),
      ),
      tool(
        'cancel_reminder',
        'Cancel a manager-created one-time or recurring reminder by ID.',
        { reminderId: z.string().min(1) },
        async (args) => safeTool(logger, 'cancel_reminder', () => ({
          cancelled: service.cancelReminder(scope, args.reminderId),
        })),
      ),
    ],
  });
}

export function getManagerMcpAllowedTools(): string[] {
  return [...MANAGER_MCP_ALLOWED_TOOLS];
}

async function safeTool(logger: Logger, name: string, fn: () => unknown | Promise<unknown>) {
  try {
    const result = await fn();
    return jsonContent({ ok: true, ...wrapResult(result) });
  } catch (err: any) {
    logger.warn({ err, tool: name }, 'Manager MCP tool failed');
    return jsonContent({ ok: false, error: err?.message || 'Manager MCP tool failed' }, true);
  }
}

function wrapResult(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { result };
}

function jsonContent(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}
