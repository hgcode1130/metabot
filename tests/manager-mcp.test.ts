import { describe, expect, it, vi } from 'vitest';
import { buildManagerMcpServer, getManagerMcpAllowedTools, MANAGER_MCP_SERVER_NAME } from '../src/engines/claude/manager-mcp.js';
import type { ManagerService } from '../src/api/manager-service.js';
import type { Logger } from '../src/utils/logger.js';

function logger(): Logger {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger;
  (log.child as any).mockReturnValue(log);
  return log;
}

function service(): ManagerService {
  return {
    listWorkers: vi.fn(() => [{ name: 'worker-a', platform: 'feishu', workingDirectory: '/tmp', status: 'idle', busy: false, queuedTaskCount: 0 }]),
    dispatchTask: vi.fn(async () => ({ id: 'mgrtask-1', traceId: 'trace-1', status: 'queued' })),
    getTask: vi.fn(() => ({ id: 'mgrtask-1', traceId: 'trace-1', status: 'completed' })),
    getTaskSummary: vi.fn(() => ({ taskId: 'mgrtask-1', summaryMarkdown: '## 完成情况' })),
    getWorkflowSummary: vi.fn(() => ({ workflowId: 'wf-1', summaryMarkdown: '## Worker trace' })),
    listTasks: vi.fn(() => []),
    cancelTask: vi.fn(() => true),
    cancelTaskDetailed: vi.fn(() => ({ taskId: 'mgrtask-1', cancelled: true, status: 'cancelled' })),
    resumeTask: vi.fn(() => ({ id: 'mgrtask-1', traceId: 'trace-1', status: 'queued' })),
    scheduleReminder: vi.fn(() => ({ id: 'sched-1', type: 'one-time', executeAt: Date.now() })),
    listReminders: vi.fn(() => []),
    cancelReminder: vi.fn(() => true),
  } as unknown as ManagerService;
}

describe('manager MCP adapter', () => {
  it('uses stable server and allowed tool names', () => {
    expect(MANAGER_MCP_SERVER_NAME).toBe('metabot-manager');
    expect(getManagerMcpAllowedTools()).toEqual(expect.arrayContaining([
      'mcp__metabot-manager__list_workers',
      'mcp__metabot-manager__dispatch_worker_task',
      'mcp__metabot-manager__send_worker_prompt',
      'mcp__metabot-manager__stop_worker',
      'mcp__metabot-manager__get_worker_task',
      'mcp__metabot-manager__get_worker_task_summary',
      'mcp__metabot-manager__get_workflow_summary',
      'mcp__metabot-manager__list_worker_tasks',
      'mcp__metabot-manager__cancel_worker_task',
      'mcp__metabot-manager__resume_worker_task',
      'mcp__metabot-manager__schedule_reminder',
      'mcp__metabot-manager__list_reminders',
      'mcp__metabot-manager__cancel_reminder',
    ]));
  });

  it('builds an in-process MCP server object', () => {
    const server = buildManagerMcpServer({
      service: service(),
      scope: { managerBotName: 'manager', managerChatId: 'chat-a' },
      logger: logger(),
    });
    expect(server).toBeTruthy();
    expect(server.type).toBe('sdk');
  });
});
