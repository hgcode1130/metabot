import { describe, expect, it } from 'vitest';
import {
  isProgressUpdateText,
  partitionProgressText,
  removeProgressText,
} from '../src/utils/progress-updates.js';

describe('progress update classification', () => {
  it('detects routine agent progress updates', () => {
    expect(isProgressUpdateText('我会继续完成收尾，但不会启动 train。')).toBe(true);
    expect(isProgressUpdateText('Next, I will verify the changed files.')).toBe(true);
  });

  it('does not classify ordinary conclusions as progress', () => {
    expect(isProgressUpdateText('先说结论：这个方案可以实现，但需要补测试。')).toBe(false);
    expect(isProgressUpdateText('完成项：已登记 registry，并通过测试。')).toBe(false);
  });

  it('partitions snippets into body content and progress updates', () => {
    const out = partitionProgressText([
      '我会先检查当前 git 状态。',
      '最终结果：已完成。',
    ], 'agent_activity');

    expect(out.content).toEqual(['最终结果：已完成。']);
    expect(out.progress).toHaveLength(1);
    expect(out.progress[0]).toMatchObject({ source: 'agent_activity' });
  });

  it('removes a progress suffix from accumulated text', () => {
    expect(removeProgressText('结果\n我会先检查当前 git 状态。', '我会先检查当前 git 状态。'))
      .toBe('结果');
  });
});
