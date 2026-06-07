import { describe, expect, it } from 'vitest';
import {
  buildWorkerTaskPrompt,
  normalizeWorkerTaskTemplate,
  WORKER_TASK_OUTPUT_CONTRACT_VERSION,
} from '../src/api/manager-worker-template.js';

describe('manager worker task templates', () => {
  const base = {
    prompt: 'Run the requested task',
    taskId: 'mgrtask-1',
    traceId: 'trace-1',
    managerBotName: 'manager',
    workerBotName: 'worker-code',
  };

  it('normalizes unknown template values to general', () => {
    expect(normalizeWorkerTaskTemplate('research')).toBe('research');
    expect(normalizeWorkerTaskTemplate('unknown')).toBe('general');
    expect(normalizeWorkerTaskTemplate(undefined)).toBe('general');
  });

  it('wraps the raw prompt exactly once with the standard output contract', () => {
    const wrapped = buildWorkerTaskPrompt(base);

    expect(wrapped).toContain('You are executing a delegated MetaBot worker task.');
    expect(wrapped).toContain('Task ID: mgrtask-1');
    expect(wrapped).toContain('Trace ID: trace-1');
    expect(wrapped).toContain(`Output contract version: ${WORKER_TASK_OUTPUT_CONTRACT_VERSION}`);
    expect(wrapped).toContain('## Required output contract');
    expect(wrapped).toContain('```json METABOT_WORKER_RESULT');
    expect(wrapped).toContain('"verification": [{"command":"exact check","status":"passed|failed|not_run","details":"short result"}]');
    expect(wrapped.match(/Run the requested task/g)).toHaveLength(1);
  });

  it('includes instruction contract fields when provided', () => {
    const wrapped = buildWorkerTaskPrompt({
      ...base,
      instructionContract: {
        version: '2026-06-07',
        objective: 'Complete P0-P1',
        forbiddenActions: ['train', 'push'],
        acceptanceCriteria: ['tests pass'],
        sideEffectClass: 'readOnly',
      },
    });

    expect(wrapped).toContain('## Instruction Contract');
    expect(wrapped).toContain('Forbidden actions: train, push');
    expect(wrapped).toContain('Acceptance criteria: tests pass');
    expect(wrapped).toContain('Side effect class: readOnly');
  });

  it('adds research-specific source requirements', () => {
    const wrapped = buildWorkerTaskPrompt({ ...base, taskTemplate: 'research' });

    expect(wrapped).toContain('Template: research');
    expect(wrapped).toContain('Research-specific requirements');
    expect(wrapped).toContain('source-backed findings');
  });

  it('adds implementation-specific separation requirements', () => {
    const wrapped = buildWorkerTaskPrompt({ ...base, taskTemplate: 'implementation' });

    expect(wrapped).toContain('Template: implementation');
    expect(wrapped).toContain('changed files and exact verification commands');
    expect(wrapped).toContain('implementation and review are separate');
  });

  it('adds review and audit read-only requirements', () => {
    expect(buildWorkerTaskPrompt({ ...base, taskTemplate: 'review' }))
      .toContain('Treat this as a read-only independent review');
    expect(buildWorkerTaskPrompt({ ...base, taskTemplate: 'audit' }))
      .toContain('Treat this as a read-only audit');
  });
});
