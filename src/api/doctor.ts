import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { BotRegistry } from './bot-registry.js';
import type { ActivityStore } from './activity-store.js';
import type { ManagerService } from './manager-service.js';
import { filePermissionStatus, type FilePermissionStatus } from '../utils/file-permissions.js';

export type DoctorCheckStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  status: DoctorCheckStatus;
  generatedAt: string;
  checks: DoctorCheck[];
  summary: Record<DoctorCheckStatus, number>;
}

export interface DoctorInput {
  registry: BotRegistry;
  botsConfigPath?: string;
  activityStore?: ActivityStore;
  managerService?: ManagerService;
  memoryServerUrl?: string;
  memoryHealth?: DoctorExternalHealth;
  chromaHealth?: DoctorExternalHealth;
  env?: NodeJS.ProcessEnv;
}

export interface DoctorExternalHealth {
  status: DoctorCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const env = input.env ?? process.env;
  const checks = [
    ...permissionChecks(input, env),
    apiSecretCheck(env),
    ...managerWorkerChecks(input.managerService),
    memoryHealthCheck(input, env),
    chromaHealthCheck(input, env),
    ...feishuChecks(input.registry),
  ];
  return finalizeReport(checks);
}

function permissionChecks(input: DoctorInput, env: NodeJS.ProcessEnv): DoctorCheck[] {
  const manager = input.managerService?.diagnostics();
  const activity = input.activityStore?.diagnostics();
  return [
    permissionCheck('manager_db_permissions', filePermissionStatus(manager?.dbPath), 'Manager DB'),
    writableFileCheck('manager_db_writable', manager?.dbPath, 'Manager DB'),
    permissionCheck('activity_db_permissions', filePermissionStatus(activity?.dbPath), 'Activity DB'),
    writableFileCheck('activity_db_writable', activity?.dbPath, 'Activity DB'),
    permissionCheck('env_file_permissions', filePermissionStatus(resolveEnvPath(env)), '.env'),
    permissionCheck('bots_config_permissions', filePermissionStatus(input.botsConfigPath), 'bots.json'),
  ].filter((check): check is DoctorCheck => !!check);
}

function permissionCheck(
  id: string,
  info: FilePermissionStatus | undefined,
  label: string,
): DoctorCheck | undefined {
  if (!info) return undefined;
  if (!info.exists) return { id, status: 'warning', message: `${label} not found`, details: { path: info.path } };
  const details = { ...info };
  if (info.private) return { id, status: 'ok', message: `${label} permissions are private`, details };
  return { id, status: 'warning', message: `${label} permissions should be 0600`, details };
}

function writableFileCheck(id: string, filePath: string | undefined, label: string): DoctorCheck | undefined {
  if (!filePath) return undefined;
  if (!fs.existsSync(filePath)) return { id, status: 'warning', message: `${label} not found`, details: { path: filePath } };
  try {
    fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
    return { id, status: 'ok', message: `${label} is readable and writable`, details: { path: filePath } };
  } catch (err: any) {
    return {
      id,
      status: 'error',
      message: `${label} is not readable/writable`,
      details: { path: filePath, error: err?.message ?? String(err) },
    };
  }
}

function apiSecretCheck(env: NodeJS.ProcessEnv): DoctorCheck {
  const value = env.API_SECRET || env.METABOT_API_SECRET;
  if (value && value !== 'changeme') {
    return { id: 'api_secret_configured', status: 'ok', message: 'API secret is configured' };
  }
  return { id: 'api_secret_configured', status: 'warning', message: 'API_SECRET is missing or default' };
}

function managerWorkerChecks(service: ManagerService | undefined): DoctorCheck[] {
  if (!service) return [{ id: 'manager_service_enabled', status: 'warning', message: 'Manager service is not enabled' }];
  const diagnostics = service.diagnostics();
  return [
    ...diagnostics.managerPolicies.map(managerPolicyCheck),
    ...managerBudgetChecks(diagnostics.managerBudgets ?? []),
    traceSummaryApiCheck(diagnostics.traceSummaryApi),
    workerQueueHealthCheck(diagnostics.workerQueue),
    reminderQueueHealthCheck(diagnostics.reminderQueue),
    recentProblemTaskCheck(diagnostics.recentProblemTasks),
  ];
}

function managerPolicyCheck(policy: ReturnType<ManagerService['diagnostics']>['managerPolicies'][number]): DoctorCheck {
  if (policy.allowAllLocalWorkers) {
    return {
      id: `manager_allowlist_${policy.managerBotName}`,
      status: 'warning',
      message: 'Manager allows all local workers',
      details: { ...policy },
    };
  }
  if (policy.workers.length === 0) {
    return {
      id: `manager_allowlist_${policy.managerBotName}`,
      status: 'warning',
      message: 'Manager worker allowlist is empty',
      details: { ...policy },
    };
  }
  return { id: `manager_allowlist_${policy.managerBotName}`, status: 'ok', message: 'Manager worker allowlist is explicit', details: { ...policy } };
}

function managerBudgetChecks(
  budgets: ReturnType<ManagerService['diagnostics']>['managerBudgets'],
): DoctorCheck[] {
  if (!budgets || budgets.length === 0) {
    return [{ id: 'manager_worker_budget', status: 'warning', message: 'No manager worker budget diagnostics available' }];
  }
  return budgets.map((budget) => {
    const details = { ...budget };
    if (budget.configured) {
      return {
        id: `manager_worker_budget_${budget.managerBotName}`,
        status: 'ok' as const,
        message: 'Manager worker concurrency budget is explicit',
        details,
      };
    }
    return {
      id: `manager_worker_budget_${budget.managerBotName}`,
      status: 'warning' as const,
      message: 'Manager worker concurrency budget uses process default',
      details,
    };
  });
}

function traceSummaryApiCheck(
  api: ReturnType<ManagerService['diagnostics']>['traceSummaryApi'] | undefined,
): DoctorCheck {
  if (api?.taskSummary === true && api.workflowSummary === true) {
    return { id: 'manager_trace_summary_api', status: 'ok', message: 'Manager trace summary APIs are queryable', details: { ...api } };
  }
  return { id: 'manager_trace_summary_api', status: 'error', message: 'Manager trace summary APIs are not fully available', details: { ...api } };
}

function workerQueueHealthCheck(
  queue: ReturnType<ManagerService['diagnostics']>['workerQueue'] | undefined,
): DoctorCheck {
  if (!queue) return { id: 'manager_worker_queue_health', status: 'warning', message: 'Worker queue diagnostics unavailable' };
  return { id: 'manager_worker_queue_health', status: 'ok', message: 'Worker queue diagnostics are queryable', details: { ...queue } };
}

function reminderQueueHealthCheck(
  queue: ReturnType<ManagerService['diagnostics']>['reminderQueue'] | undefined,
): DoctorCheck {
  if (!queue) return { id: 'manager_reminder_queue_health', status: 'warning', message: 'Reminder queue diagnostics unavailable' };
  return { id: 'manager_reminder_queue_health', status: 'ok', message: 'Reminder queue diagnostics are queryable', details: { ...queue } };
}

function recentProblemTaskCheck(tasks: ReturnType<ManagerService['diagnostics']>['recentProblemTasks']): DoctorCheck {
  if (tasks.length === 0) return { id: 'recent_manager_problem_tasks', status: 'ok', message: 'No recent failed or cancelled manager tasks' };
  return {
    id: 'recent_manager_problem_tasks',
    status: 'warning',
    message: `${tasks.length} recent failed or cancelled manager task(s)`,
    details: { tasks },
  };
}

function memoryHealthCheck(input: DoctorInput, env: NodeJS.ProcessEnv): DoctorCheck {
  if (input.memoryHealth) return externalHealthCheck('memory_health', input.memoryHealth);
  if (env.MEMORY_ENABLED === 'false') {
    return { id: 'memory_health', status: 'ok', message: 'MetaMemory is disabled by configuration' };
  }
  const url = input.memoryServerUrl || env.META_MEMORY_URL || env.MEMORY_SERVER_URL;
  if (!url) return { id: 'memory_health', status: 'warning', message: 'MetaMemory URL is not configured' };
  return {
    id: 'memory_health',
    status: 'warning',
    message: 'MetaMemory URL is configured but runtime health was not sampled by this doctor report',
    details: { url },
  };
}

function chromaHealthCheck(input: DoctorInput, env: NodeJS.ProcessEnv): DoctorCheck {
  if (input.chromaHealth) return externalHealthCheck('chroma_health', input.chromaHealth);
  const url = env.CHROMA_URL || env.CHROMA_HOST;
  if (!url) return { id: 'chroma_health', status: 'ok', message: 'Chroma is not configured for this deployment' };
  return {
    id: 'chroma_health',
    status: 'warning',
    message: 'Chroma is configured but runtime health was not sampled by this doctor report',
    details: { url },
  };
}

function externalHealthCheck(id: string, health: DoctorExternalHealth): DoctorCheck {
  return { id, status: health.status, message: health.message, details: health.details };
}

function feishuChecks(registry: BotRegistry): DoctorCheck[] {
  return registry.listRegistered()
    .filter((bot) => bot.platform === 'feishu' && readGroupNoMention(bot.config) === true)
    .map((bot) => ({
      id: `feishu_group_no_mention_${bot.name}`,
      status: 'warning' as const,
      message: 'Feishu groupNoMention requires group message permissions and published app configuration',
      details: { botName: bot.name },
    }));
}

function readGroupNoMention(config: unknown): boolean {
  const record = config && typeof config === 'object' ? config as Record<string, unknown> : undefined;
  const feishu = record?.feishu;
  if (feishu && typeof feishu === 'object' && (feishu as Record<string, unknown>).groupNoMention === true) {
    return true;
  }
  return record?.groupNoMention === true;
}

function finalizeReport(checks: DoctorCheck[]): DoctorReport {
  const summary = statusSummary(checks);
  const status = summary.error > 0 ? 'error' : summary.warning > 0 ? 'warning' : 'ok';
  return { status, generatedAt: new Date().toISOString(), checks, summary };
}

function statusSummary(checks: DoctorCheck[]): Record<DoctorCheckStatus, number> {
  return checks.reduce((acc, check) => ({ ...acc, [check.status]: acc[check.status] + 1 }), {
    ok: 0,
    warning: 0,
    error: 0,
  });
}

function resolveEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [
    env.METABOT_ENV,
    env.METABOT_HOME ? path.join(env.METABOT_HOME, '.env') : undefined,
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), 'metabot', '.env'),
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);
  return candidates[0];
}
