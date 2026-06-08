import * as path from 'node:path';
import * as os from 'node:os';
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
  env?: NodeJS.ProcessEnv;
}

export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const env = input.env ?? process.env;
  const checks = [
    ...permissionChecks(input, env),
    apiSecretCheck(env),
    ...managerWorkerChecks(input.managerService),
    ...feishuChecks(input.registry),
  ];
  return finalizeReport(checks);
}

function permissionChecks(input: DoctorInput, env: NodeJS.ProcessEnv): DoctorCheck[] {
  const manager = input.managerService?.diagnostics();
  const activity = input.activityStore?.diagnostics();
  return [
    permissionCheck('manager_db_permissions', filePermissionStatus(manager?.dbPath), 'Manager DB'),
    permissionCheck('activity_db_permissions', filePermissionStatus(activity?.dbPath), 'Activity DB'),
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

function recentProblemTaskCheck(tasks: ReturnType<ManagerService['diagnostics']>['recentProblemTasks']): DoctorCheck {
  if (tasks.length === 0) return { id: 'recent_manager_problem_tasks', status: 'ok', message: 'No recent failed or cancelled manager tasks' };
  return {
    id: 'recent_manager_problem_tasks',
    status: 'warning',
    message: `${tasks.length} recent failed or cancelled manager task(s)`,
    details: { tasks },
  };
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
