import { describe, expect, it } from 'vitest';
import { denialHookOutput, evaluateToolUseActionGate } from '../src/utils/action-gate.js';

describe('action gate', () => {
  it('allows calls without a forbidden action policy', () => {
    expect(evaluateToolUseActionGate(undefined, 'Bash', { command: 'npm run train' })).toEqual({ allowed: true });
  });

  it('blocks forbidden train commands on Bash', () => {
    const decision = evaluateToolUseActionGate({ forbiddenActions: ['train'], taskId: 'task-1' }, 'Bash', {
      command: 'python train.py --config cfg.yaml',
    });

    expect(decision).toMatchObject({
      allowed: false,
      action: 'train',
      reason: 'Action blocked by instruction contract: train',
    });
  });

  it('blocks push and recursive delete commands', () => {
    expect(
      evaluateToolUseActionGate({ forbiddenActions: ['push'] }, 'Bash', { command: 'git push origin main' }).allowed,
    ).toBe(false);
    expect(
      evaluateToolUseActionGate({ forbiddenActions: ['delete'] }, 'Bash', { command: 'rm -rf dist' }).allowed,
    ).toBe(false);
  });

  it('blocks broad repository scans and direct deploy commands when forbidden', () => {
    expect(
      evaluateToolUseActionGate({ forbiddenActions: ['scan_all'] }, 'Bash', { command: 'rg TODO .' }).allowed,
    ).toBe(false);
    expect(
      evaluateToolUseActionGate({ forbiddenActions: ['deploy'] }, 'Bash', { command: 'kubectl apply -f deploy.yaml' })
        .allowed,
    ).toBe(false);
  });

  it('allows read-only Bash inspection commands', () => {
    expect(
      evaluateToolUseActionGate({ forbiddenActions: [], sideEffectClass: 'readOnly' }, 'Bash', {
        command: 'rg TODO src',
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateToolUseActionGate({ forbiddenActions: [], sideEffectClass: 'readOnly' }, 'Bash', {
        command: 'timeout 60s npx tsc --noEmit',
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateToolUseActionGate({ forbiddenActions: [], sideEffectClass: 'readOnly' }, 'Bash', {
        command: '/bin/bash -lc "sed -n \'1,220p\' /home/batchcom/.codex/skills/metabot/SKILL.md"',
      }),
    ).toEqual({ allowed: true });
  });

  it('does not treat training log inspection as launching training', () => {
    expect(
      evaluateToolUseActionGate({ forbiddenActions: ['train'], sideEffectClass: 'readOnly' }, 'Bash', {
        command: 'sed -n "1,120p" runs/training.log',
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateToolUseActionGate({ forbiddenActions: ['train'], sideEffectClass: 'readOnly' }, 'Bash', {
        command: '/bin/bash -lc "rg \\"torchrun|training\\" runs/training.log"',
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateToolUseActionGate({ forbiddenActions: ['train'], sideEffectClass: 'readOnly' }, 'Bash', {
        command: 'python train.py --config cfg.yaml',
      }),
    ).toMatchObject({
      allowed: false,
      action: 'readOnly',
    });
  });

  it('blocks mutating Bash commands for read-only worker tasks', () => {
    expect(
      evaluateToolUseActionGate({ forbiddenActions: [], sideEffectClass: 'readOnly' }, 'Bash', {
        command: 'git push origin main',
      }),
    ).toMatchObject({
      allowed: false,
      action: 'readOnly',
      reason: 'Bash command blocked by read-only worker policy',
    });
    expect(
      evaluateToolUseActionGate({ forbiddenActions: [], sideEffectClass: 'readOnly' }, 'Bash', {
        command: '/bin/bash -lc "git push origin main"',
      }),
    ).toMatchObject({
      allowed: false,
      action: 'readOnly',
    });
  });

  it('does not block non-Bash tools', () => {
    expect(evaluateToolUseActionGate({ forbiddenActions: ['delete'] }, 'Write', { file_path: 'x' })).toEqual({
      allowed: true,
    });
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
