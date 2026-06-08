import type { ManagerScope } from './manager-service.js';
import type { ManagerTask } from './manager-store.js';
import type { WorkerTaskTemplate } from './manager-worker-template.js';

export const MANAGER_DELEGATION_BUDGET_VERSION = '2026-06-09';

export interface DelegationBudgetInput {
  scope: ManagerScope;
  workflowId?: string;
  taskTemplate: WorkerTaskTemplate;
  metadata?: Record<string, unknown>;
  existingWorkflowTasks: ManagerTask[];
}

export interface DelegationBudgetMetadata {
  policyVersion: string;
  maxWorkers: number;
  workerCount: number;
  taskTemplate: WorkerTaskTemplate;
  estimatedCostUsd?: number;
  confirmed: boolean;
}

const DEFAULT_WORKFLOW_WORKER_LIMIT = 2;

export function resolveDelegationBudget(input: DelegationBudgetInput): DelegationBudgetMetadata {
  const maxWorkers = readPositiveInteger(input.metadata?.delegationMaxWorkers) ?? DEFAULT_WORKFLOW_WORKER_LIMIT;
  const workerCount = input.workflowId ? input.existingWorkflowTasks.length + 1 : 1;
  const estimatedCostUsd = readNonNegativeNumber(input.metadata?.estimatedCostUsd);
  const confirmed = input.metadata?.delegationBudgetConfirmed === true;
  if (workerCount > maxWorkers && !confirmed) {
    throw Object.assign(
      new Error(`Delegation budget exceeded for workflow ${input.workflowId}: ${workerCount}/${maxWorkers} workers; set metadata.delegationBudgetConfirmed=true after user confirmation`),
      { statusCode: 409 },
    );
  }
  return {
    policyVersion: MANAGER_DELEGATION_BUDGET_VERSION,
    maxWorkers,
    workerCount,
    taskTemplate: input.taskTemplate,
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    confirmed,
  };
}

export function workflowTasks(
  tasks: ManagerTask[],
  scope: ManagerScope,
  workflowId: string | undefined,
): ManagerTask[] {
  if (!workflowId) return [];
  return tasks.filter((task) => (
    task.managerBotName === scope.managerBotName
    && task.managerChatId === scope.managerChatId
    && task.metadata?.workflowId === workflowId
    && task.status !== 'cancelled'
  ));
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}
