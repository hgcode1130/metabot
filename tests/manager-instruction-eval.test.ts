import { describe, expect, it } from 'vitest';
import { buildWorkerTaskPrompt } from '../src/api/manager-worker-template.js';
import { buildTaskWorkLog, buildWorkflowWorkLog } from '../src/api/manager-work-log.js';
import type { ManagerTask } from '../src/api/manager-store.js';
import { resolveDelegationBudget } from '../src/api/manager-delegation-budget.js';

function task(partial: Partial<ManagerTask> = {}): ManagerTask {
  return {
    id: partial.id ?? 'mgrtask-1',
    traceId: partial.traceId ?? 'trace-1',
    managerBotName: 'manager',
    managerChatId: 'chat-a',
    workerBotName: partial.workerBotName ?? 'worker-a',
    workerChatId: 'worker-chat',
    prompt: partial.prompt ?? 'Do work',
    status: partial.status ?? 'completed',
    createdAt: 1,
    updatedAt: 2,
    attemptCount: 0,
    maxAttempts: 5,
    metadata: partial.metadata ?? workerResultMetadata(),
    ...partial,
  };
}

function workerResultMetadata(): Record<string, unknown> {
  return {
    workerResult: {
      summary: 'done',
      files: ['src/api/manager-service.ts'],
      commands: ['npm test'],
      artifacts: [],
      verification: [{ command: 'npm test', status: 'passed', details: 'ok' }],
      risks: [],
      nextAction: 'manager summarize',
    },
  };
}

describe('manager instruction-following eval suite', () => {
  it('preserves read-only constraints in worker prompts', () => {
    const prompt = buildWorkerTaskPrompt({
      prompt: '只读审查，不要改文件。',
      taskId: 'mgrtask-readonly',
      traceId: 'trace-readonly',
      managerBotName: 'manager',
      workerBotName: 'worker-review',
      taskTemplate: 'review',
      instructionContract: {
        version: '2026-06-07',
        objective: 'read-only review',
        forbiddenActions: ['write files'],
        acceptanceCriteria: ['findings include evidence'],
        sideEffectClass: 'readOnly',
      },
    });

    expect(prompt).toContain('Treat this as a read-only independent review');
    expect(prompt).toContain('Side effect class: readOnly');
    expect(prompt).toContain('Forbidden actions: write files');
  });

  it('makes multi-worker delegation transparent in workflow summaries', () => {
    const first = task({ id: 'mgrtask-a', traceId: 'trace-a', workerBotName: 'worker-code' });
    const second = task({ id: 'mgrtask-b', traceId: 'trace-b', workerBotName: 'worker-review' });
    const log = buildWorkflowWorkLog('wf-1', [first, second], new Map());

    expect(log.workerCount).toBe(2);
    expect(log.summaryMarkdown).toContain('worker-code / mgrtask-a / trace-a');
    expect(log.summaryMarkdown).toContain('worker-review / mgrtask-b / trace-b');
  });

  it('surfaces failed invalid worker results without pretending completion', () => {
    const log = buildTaskWorkLog(task({
      status: 'failed',
      error: 'Invalid worker result',
      metadata: { workerResultError: 'METABOT_WORKER_RESULT block not found' },
    }));

    expect(log.substatus).toBe('result_invalid');
    expect(log.summaryMarkdown).toContain('状态：result_invalid');
  });

  it('replays consulted commands and files from trace summaries', () => {
    const log = buildTaskWorkLog(task());

    expect(log.evidence.commands).toEqual(['npm test']);
    expect(log.evidence.files).toEqual(['src/api/manager-service.ts']);
    expect(log.verification.performed).toHaveLength(1);
  });

  it('requires explicit confirmation before broad workflow delegation', () => {
    const scope = { managerBotName: 'manager', managerChatId: 'chat-a' };
    const existingWorkflowTasks = [task({ id: 'mgrtask-1' }), task({ id: 'mgrtask-2' })];

    expect(() => resolveDelegationBudget({
      scope,
      workflowId: 'wf-budget',
      taskTemplate: 'audit',
      existingWorkflowTasks,
      metadata: {},
    })).toThrow('Delegation budget exceeded');
  });
});
