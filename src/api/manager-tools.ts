import { z } from 'zod';
import type { Logger } from '../utils/logger.js';
import type { ManagerScope, ManagerService } from './manager-service.js';
import { WORKER_TASK_TEMPLATES } from './manager-worker-template.js';

const MAX_WAIT_TIMEOUT_SECONDS = 60;
const MAX_LIST_TASKS_LIMIT = 100;

export const MANAGER_MCP_SERVER_NAME = 'metabot-manager';
export const MANAGER_TOOL_NAMES = [
  'list_workers',
  'dispatch_worker_task',
  'send_worker_prompt',
  'stop_worker',
  'get_worker_task',
  'list_worker_tasks',
  'cancel_worker_task',
  'resume_worker_task',
  'schedule_reminder',
  'list_reminders',
  'cancel_reminder',
] as const;

export type ManagerToolName = (typeof MANAGER_TOOL_NAMES)[number];

export const MANAGER_MCP_ALLOWED_TOOLS = MANAGER_TOOL_NAMES.map((name) => `mcp__${MANAGER_MCP_SERVER_NAME}__${name}`);

export interface ManagerToolSpec {
  name: ManagerToolName;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  run(options: ManagerToolRunOptions): unknown | Promise<unknown>;
}

export interface ManagerToolRunOptions {
  service: ManagerService;
  scope: ManagerScope;
  args: Record<string, unknown>;
}

export interface SafeManagerToolOptions extends ManagerToolRunOptions {
  name: string;
  logger: Logger;
}

export interface ManagerToolResult {
  payload: Record<string, unknown>;
  isError: boolean;
}

const taskTemplate = z.enum(WORKER_TASK_TEMPLATES);
const sideEffectClass = z.enum(['none', 'readOnly', 'externalWrite']);
const metadata = z.record(z.string(), z.unknown());

const dispatchInput = {
  workerBotName: z.string().min(1).describe('Allowed worker bot name'),
  prompt: z.string().min(1).describe('Task prompt for the worker'),
  label: z.string().optional(),
  sessionKey: z.string().optional().describe('Stable worker session key; same key preserves worker session context'),
  taskTemplate: taskTemplate
    .optional()
    .describe('Optional standardized output template: research, implementation, review, audit, or general'),
  relatedTaskId: z
    .string()
    .optional()
    .describe('Optional related manager task ID for implementation/review or research/analysis workflows'),
  workflowId: z.string().optional().describe('Optional stable workflow identifier shared by related worker tasks'),
  sideEffectClass: sideEffectClass.optional(),
  idempotencyKey: z.string().optional(),
  forbiddenActions: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  waitTimeoutSeconds: z.number().int().min(0).max(MAX_WAIT_TIMEOUT_SECONDS).optional(),
  metadata: metadata.optional(),
};

export const MANAGER_TOOL_SPECS: ManagerToolSpec[] = [
  {
    name: 'list_workers',
    description:
      'List worker bots this manager may delegate tasks to. Use before delegating if you are unsure which worker to use.',
    inputSchema: { includeBusy: z.boolean().optional() },
    run: ({ service, scope }) => ({ workers: service.listWorkers(scope) }),
  },
  {
    name: 'dispatch_worker_task',
    description:
      'Delegate a task to a worker bot asynchronously. Returns a task ID; use get_worker_task or list_worker_tasks to inspect progress and results.',
    inputSchema: {
      ...dispatchInput,
      sendCards: z.boolean().optional().describe('Normally false so hidden worker sessions do not spam the user chat'),
    },
    run: async ({ service, scope, args }) => ({
      task: await service.dispatchTask(scope, args as never),
    }),
  },
  {
    name: 'send_worker_prompt',
    description:
      'Send an additional prompt to a worker session. This creates a new traceable delegated task in the same worker sessionKey.',
    inputSchema: dispatchInput,
    run: async ({ service, scope, args }) => ({
      result: await service.sendWorkerPrompt(scope, { ...args, sendCards: false } as never),
    }),
  },
  {
    name: 'stop_worker',
    description:
      'Stop a running/queued worker task by task ID. Alias for cancel_worker_task, named for manager-worker workflows.',
    inputSchema: { taskId: z.string().min(1), reason: z.string().optional() },
    run: ({ service, scope, args }) => ({
      stopped: service.cancelTask(scope, String(args.taskId), stringArg(args.reason) ?? 'Stopped by manager'),
    }),
  },
  {
    name: 'get_worker_task',
    description: 'Get one delegated worker task, optionally including the event timeline for traceability.',
    inputSchema: { taskId: z.string().min(1), includeEvents: z.boolean().optional() },
    run: ({ service, scope, args }) =>
      service.getTask(scope, String(args.taskId), { includeEvents: args.includeEvents === true }) ?? {
        error: `Manager task not found: ${String(args.taskId)}`,
      },
  },
  {
    name: 'list_worker_tasks',
    description: 'List delegated worker tasks for this manager chat, filtered by worker or status.',
    inputSchema: {
      workerBotName: z.string().optional(),
      status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(MAX_LIST_TASKS_LIMIT).optional(),
    },
    run: ({ service, scope, args }) => ({ tasks: service.listTasks(scope, args as never) }),
  },
  {
    name: 'cancel_worker_task',
    description:
      'Cancel a queued or running delegated worker task. Running tasks are interrupted via the worker bridge when possible.',
    inputSchema: { taskId: z.string().min(1), reason: z.string().optional() },
    run: ({ service, scope, args }) => ({
      cancelled: service.cancelTask(scope, String(args.taskId), stringArg(args.reason)),
    }),
  },
  {
    name: 'resume_worker_task',
    description: 'Resume a failed or queued delegated worker task using its latest checkpoint summary.',
    inputSchema: { taskId: z.string().min(1) },
    run: ({ service, scope, args }) => ({
      task: service.resumeTask(scope, String(args.taskId)),
    }),
  },
  {
    name: 'schedule_reminder',
    description: 'Schedule a reminder or recurring manager-chat task. Provide exactly one of delaySeconds or cronExpr.',
    inputSchema: {
      prompt: z.string().min(1),
      delaySeconds: z.number().int().positive().optional(),
      cronExpr: z.string().optional(),
      timezone: z.string().optional(),
      label: z.string().optional(),
      sendCards: z.boolean().optional(),
      traceId: z.string().optional(),
      sideEffectClass: sideEffectClass.optional(),
      idempotencyKey: z.string().optional(),
    },
    run: ({ service, scope, args }) => ({ reminder: service.scheduleReminder(scope, args as never) }),
  },
  {
    name: 'list_reminders',
    description: 'List reminders created by this manager chat.',
    inputSchema: {},
    run: ({ service, scope }) => ({ reminders: service.listReminders(scope) }),
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a manager-created one-time or recurring reminder by ID.',
    inputSchema: { reminderId: z.string().min(1) },
    run: ({ service, scope, args }) => ({
      cancelled: service.cancelReminder(scope, String(args.reminderId)),
    }),
  },
];

export async function runManagerToolSafely(options: SafeManagerToolOptions): Promise<ManagerToolResult> {
  const spec = managerToolSpec(options.name);
  try {
    const result = await spec.run(options);
    return { payload: { ok: true, ...wrapResult(result) }, isError: false };
  } catch (err: any) {
    options.logger.warn({ err, tool: options.name }, 'Manager MCP tool failed');
    return {
      payload: { ok: false, error: err?.message || 'Manager MCP tool failed' },
      isError: true,
    };
  }
}

export function managerToolContent(result: ManagerToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result.payload, null, 2) }],
    ...(result.isError ? { isError: true } : {}),
  };
}

export function managerToolSpec(name: string): ManagerToolSpec {
  const spec = MANAGER_TOOL_SPECS.find((item) => item.name === name);
  if (!spec) throw new Error(`Unknown manager tool: ${name}`);
  return spec;
}

function wrapResult(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
