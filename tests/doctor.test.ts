import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDoctorReport } from '../src/api/doctor.js';
import type { BotRegistry } from '../src/api/bot-registry.js';
import type { ManagerService } from '../src/api/manager-service.js';
import type { ActivityStore } from '../src/api/activity-store.js';

let tmpDir: string | undefined;

function tempFile(name: string, mode: number): string {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-doctor-test-'));
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, 'x', { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

function registry(bots: any[]): BotRegistry {
  return {
    listRegistered: () => bots,
  } as unknown as BotRegistry;
}

function managerService(dbPath: string, overrides: Partial<ReturnType<ManagerService['diagnostics']>> = {}): ManagerService {
  return {
    diagnostics: () => ({
      dbPath,
      managerPolicies: [{ managerBotName: 'manager', workers: ['worker-a'], allowAllLocalWorkers: false }],
      recentProblemTasks: [],
      ...overrides,
    }),
  } as unknown as ManagerService;
}

function activityStore(dbPath: string): ActivityStore {
  return { diagnostics: () => ({ dbPath }) } as unknown as ActivityStore;
}

describe('doctor report', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('reports ok for private DB/config files and explicit manager workers', () => {
    const managerDb = tempFile('manager.db', 0o600);
    const activityDb = tempFile('activity.db', 0o600);
    const envPath = tempFile('.env', 0o600);
    const botsPath = tempFile('bots.json', 0o600);

    const report = buildDoctorReport({
      registry: registry([{ name: 'manager', platform: 'feishu', config: { manager: { enabled: true, workers: ['worker-a'] }, feishu: {} } }]),
      botsConfigPath: botsPath,
      activityStore: activityStore(activityDb),
      managerService: managerService(managerDb),
      env: { API_SECRET: 'secret', METABOT_ENV: envPath },
    });

    expect(report.status).toBe('ok');
    expect(report.summary.ok).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === 'manager_allowlist_manager')?.status).toBe('ok');
  });

  it('warns on broad worker policy, weak permissions, problem tasks, and group no mention', () => {
    const managerDb = tempFile('manager.db', 0o644);
    const activityDb = tempFile('activity.db', 0o600);
    const envPath = tempFile('.env', 0o600);

    const report = buildDoctorReport({
      registry: registry([{
        name: 'manager',
        platform: 'feishu',
        config: { manager: { enabled: true, allowAllLocalWorkers: true }, feishu: { groupNoMention: true } },
      }]),
      activityStore: activityStore(activityDb),
      managerService: managerService(managerDb, {
        managerPolicies: [{ managerBotName: 'manager', workers: [], allowAllLocalWorkers: true }],
        recentProblemTasks: [{ id: 'mgrtask-failed', status: 'failed', workerBotName: 'worker-a', updatedAt: 1 }],
      }),
      env: { API_SECRET: 'secret', METABOT_ENV: envPath },
    });

    expect(report.status).toBe('warning');
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'manager_db_permissions',
      'manager_allowlist_manager',
      'recent_manager_problem_tasks',
      'feishu_group_no_mention_manager',
    ]));
  });
});
