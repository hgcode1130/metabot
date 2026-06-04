import { describe, expect, it } from 'vitest';
import { buildAppendedPromptCardState } from '../src/bridge/appended-prompt-state.js';
import type { CardState, TeamState } from '../src/types.js';

function runningState(responseText: string): CardState {
  return {
    status: 'running',
    userPrompt: 'fix bug',
    responseText,
    toolCalls: [{ name: 'Bash', detail: '`npm test`', status: 'running' }],
  };
}

describe('buildAppendedPromptCardState', () => {
  it('adds a visible continuation note to the running card', () => {
    const prepared = buildAppendedPromptCardState({
      state: runningState('Still checking logs.'),
      prompt: 'also inspect the failed migration',
    });

    expect(prepared.status).toBe('running');
    expect(prepared.responseText).toContain('Still checking logs.');
    expect(prepared.responseText).toContain('Added your latest message');
    expect(prepared.responseText).toContain('also inspect the failed migration');
  });

  it('preserves team state and truncates long appended prompts', () => {
    const teamState: TeamState = {
      teammates: [{ name: 'reviewer', status: 'working' }],
      tasks: [{ taskId: 't1', subject: 'review', status: 'in_progress' }],
    };
    const longPrompt = 'x'.repeat(200);
    const prepared = buildAppendedPromptCardState({
      state: runningState(''),
      teamState,
      prompt: longPrompt,
    });

    expect(prepared.teamState).toBe(teamState);
    expect(prepared.responseText).toContain('x'.repeat(120));
    expect(prepared.responseText).toContain('...');
    expect(prepared.responseText.length).toBeLessThan(190);
  });
});
