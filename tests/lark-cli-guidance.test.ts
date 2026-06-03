import { describe, expect, it } from 'vitest';
import { buildLarkCliGuidance } from '../src/engines/claude/lark-cli-guidance.js';

describe('buildLarkCliGuidance', () => {
  it('names the Feishu domains the agent should operate through lark-cli', () => {
    const guidance = buildLarkCliGuidance();

    expect(guidance).toContain('lark-cli');
    expect(guidance).toContain('docs');
    expect(guidance).toContain('calendar');
    expect(guidance).toContain('tasks');
    expect(guidance).toContain('Do not simulate Feishu success');
  });
});
