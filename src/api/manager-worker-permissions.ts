import type { ActionGatePolicy } from '../utils/action-gate.js';
import type { SideEffectClass } from '../utils/retry-policy.js';
import { normalizeWorkerTaskTemplate, type WorkerTaskTemplate } from './manager-worker-template.js';

export interface ManagerWorkerPermissionInput {
  taskTemplate?: unknown;
  sideEffectClass?: SideEffectClass;
  forbiddenActions?: string[];
  taskId: string;
  traceId: string;
}

export interface ManagerWorkerPermissionPlan {
  mode: 'default' | 'readOnly';
  allowedTools?: string[];
  actionGatePolicy?: ActionGatePolicy;
  reason: string;
}

export function resolveManagerWorkerPermissions(
  input: ManagerWorkerPermissionInput,
): ManagerWorkerPermissionPlan {
  const template = normalizeWorkerTaskTemplate(input.taskTemplate);
  const readOnly = isReadOnlyWorkerTask(template, input.sideEffectClass);
  const actionGatePolicy = buildActionGatePolicy(input);
  if (!readOnly) {
    return {
      mode: 'default',
      actionGatePolicy,
      reason: actionGatePolicy ? 'forbidden-actions' : 'default-worker-tools',
    };
  }
  return {
    mode: 'readOnly',
    actionGatePolicy,
    reason: readOnlyReason(template, input.sideEffectClass),
  };
}

function isReadOnlyWorkerTask(
  template: WorkerTaskTemplate,
  sideEffectClass: SideEffectClass | undefined,
): boolean {
  return template === 'review' || template === 'audit' || sideEffectClass === 'readOnly';
}

function buildActionGatePolicy(input: ManagerWorkerPermissionInput): ActionGatePolicy | undefined {
  const forbiddenActions = input.forbiddenActions ?? [];
  if (forbiddenActions.length === 0) return undefined;
  return {
    forbiddenActions,
    sideEffectClass: input.sideEffectClass,
    taskId: input.taskId,
    traceId: input.traceId,
  };
}

function readOnlyReason(
  template: WorkerTaskTemplate,
  sideEffectClass: SideEffectClass | undefined,
): string {
  if (template === 'review') return 'review-template-read-only';
  if (template === 'audit') return 'audit-template-read-only';
  if (sideEffectClass === 'readOnly') return 'side-effect-class-read-only';
  return 'read-only';
}
