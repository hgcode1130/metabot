import { describe, expect, it } from 'vitest';
import { buildManagerWorkerGuidance } from '../src/engines/claude/manager-worker-guidance.js';

describe('buildManagerWorkerGuidance', () => {
  it('describes manager-worker orchestration and research workflow expectations', () => {
    const guidance = buildManagerWorkerGuidance();

    expect(guidance).toContain('Manager / Worker Tools');
    expect(guidance).toContain('single user-facing orchestrator');
    expect(guidance).toContain('metabot-manager MCP tools');
    expect(guidance).toContain('list_workers');
    expect(guidance).toContain('Research Manager');
    expect(guidance).toContain('literature/novelty');
    expect(guidance).toContain('separate implementation from review');
    expect(guidance).toContain('taskTemplate');
    expect(guidance).toContain('sessionKey');
    expect(guidance).toContain('Do not create complex swarms');
    expect(guidance).toContain('Default delegation budget');
    expect(guidance).toContain('get_worker_task_summary');
    expect(guidance).toContain('Claude Agent Team/Subagent');
  });
});
