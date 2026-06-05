import { describe, expect, it } from 'vitest';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
import type { SDKMessage } from '../src/engines/claude/executor.js';
import {
  selectFinalResponseText,
  selectUserFacingResponseText,
  stripTaskmasterCompletionAudit,
} from '../src/engines/claude/taskmaster-response.js';

function msg(overrides: Partial<SDKMessage>): SDKMessage {
  return { type: 'system', session_id: 'sess-taskmaster', ...overrides } as SDKMessage;
}

function taskmasterAudit(): string {
  return [
    '1. GOAL CONFRONTATION',
    'Original requests / acceptance criteria',
    '- Fix final card replacement.',
    '',
    '2. TASK LIST',
    '- Tests passed.',
    '',
    'TASKMASTER_DONE::sess-taskmaster',
  ].join('\n');
}

describe('taskmaster response sanitization', () => {
  it('removes a taskmaster completion audit appended after user-facing text', () => {
    const text = ['重要总结', '', taskmasterAudit()].join('\n');

    expect(stripTaskmasterCompletionAudit(text)).toBe('重要总结');
  });

  it('keeps the previous user-facing text when the final result is only audit', () => {
    const selected = selectUserFacingResponseText('前面的重要总结', taskmasterAudit());
    expect(selected).toBe('前面的重要总结');
  });

  it('does not strip normal content that mentions GOAL CONFRONTATION', () => {
    const text = '请解释 GOAL CONFRONTATION 这个短语，不要改写。';
    expect(stripTaskmasterCompletionAudit(text)).toBe(text);
  });

  it('replaces a streamed prefix with the complete assistant text', () => {
    const selected = selectUserFacingResponseText('Hello', 'Hello world');
    expect(selected).toBe('Hello world');
  });

  it('joins continuation assistant text after a max-token split', () => {
    const selected = selectUserFacingResponseText(
      'v2 保留多尺度 caption，但 bucket 不再只是长度控制，而是和',
      '样本目的绑定。',
    );
    expect(selected).toBe('v2 保留多尺度 caption，但 bucket 不再只是长度控制，而是和样本目的绑定。');
  });

  it('uses the final result instead of merging intermediate assistant text', () => {
    const selected = selectFinalResponseText('I’ll run `pwd` once.', 'DONE');
    expect(selected).toBe('DONE');
  });

  it('removes a standalone taskmaster done signal from an otherwise normal result', () => {
    const text = '处理完成。\nTASKMASTER_DONE::sess-taskmaster';
    expect(stripTaskmasterCompletionAudit(text)).toBe('处理完成。');
  });
});

describe('StreamProcessor taskmaster response integration', () => {
  it('strips audit text from result messages without changing complete status', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(
      msg({
        type: 'result',
        subtype: 'success',
        result: ['重要总结', '', taskmasterAudit()].join('\n'),
      }),
    );

    expect(state.status).toBe('complete');
    expect(state.responseText).toBe('重要总结');
  });

  it('preserves accumulated response text when result is only taskmaster audit', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(
      msg({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '前面的重要总结' } },
      }),
    );

    const state = p.processMessage(
      msg({
        type: 'result',
        subtype: 'success',
        result: taskmasterAudit(),
      }),
    );

    expect(state.status).toBe('complete');
    expect(state.responseText).toBe('前面的重要总结');
  });

  it('does not let a top-level assistant audit message replace prior text', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '前面的重要总结' }] },
      }),
    );

    const state = p.processMessage(
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: taskmasterAudit() }] },
      }),
    );

    expect(state.responseText).toBe('前面的重要总结');
  });
});
