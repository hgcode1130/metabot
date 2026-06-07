import { describe, expect, it } from 'vitest';
import { denialHookOutput, evaluateToolUseActionGate } from '../src/utils/action-gate.js';

describe('action gate', () => {
  it('allows calls without a forbidden action policy', () => {
    expect(evaluateToolUseActionGate(undefined, 'Bash', { command: 'npm run train' }))
      .toEqual({ allowed: true });
  });

  it('blocks forbidden train commands on Bash', () => {
    const decision = evaluateToolUseActionGate(
      { forbiddenActions: ['train'], taskId: 'task-1' },
      'Bash',
      { command: 'python train.py --config cfg.yaml' },
    );

    expect(decision).toMatchObject({
      allowed: false,
      action: 'train',
      reason: 'Action blocked by instruction contract: train',
    });
  });

  it('blocks push and recursive delete commands', () => {
    expect(evaluateToolUseActionGate(
      { forbiddenActions: ['push'] },
      'Bash',
      { command: 'git push origin main' },
    ).allowed).toBe(false);
    expect(evaluateToolUseActionGate(
      { forbiddenActions: ['delete'] },
      'Bash',
      { command: 'rm -rf dist' },
    ).allowed).toBe(false);
  });

  it('does not block non-Bash tools', () => {
    expect(evaluateToolUseActionGate(
      { forbiddenActions: ['delete'] },
      'Write',
      { file_path: 'x' },
    )).toEqual({ allowed: true });
  });

  it('returns an explicit SDK deny hook output', () => {
    const output = denialHookOutput({
      allowed: false,
      action: 'push',
      reason: 'blocked',
    });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'blocked',
      },
    });
  });
});
