import { describe, expect, it } from 'vitest';
import {
  analyzeCardResponse,
  buildInlineResponsePreview,
  MAX_NATIVE_TABLE_ELEMENTS,
  MAX_RESPONSE_ELEMENTS,
  responseToElements,
} from '../src/feishu/card-response-elements.js';

function table(index: number): string {
  return [
    `| H${index} | V${index} |`,
    '|---|---|',
    `| a${index} | b${index} |`,
  ].join('\n');
}

describe('card response limit handling', () => {
  it('marks long responses as attachment-worthy and builds a preview', () => {
    const text = 'x'.repeat(13_000);
    const analysis = analyzeCardResponse(text);
    const preview = buildInlineResponsePreview(text, 'full.md');

    expect(analysis.needsAttachment).toBe(true);
    expect(analysis.reason).toBe('length');
    expect(preview).toContain('Full response attached');
    expect(preview).toContain('full.md');
    expect(preview.length).toBeLessThan(text.length);
  });

  it('limits native table elements and keeps remaining tables as markdown blocks', () => {
    const text = Array.from({ length: MAX_NATIVE_TABLE_ELEMENTS + 4 }, (_, i) => table(i)).join('\n\n');
    const elements = responseToElements(text) as Array<{ tag?: string; content?: string }>;
    const nativeTables = elements.filter((element) => element.tag === 'table');
    const markdownTables = elements.filter(
      (element) => element.tag === 'markdown' && element.content?.includes('| H'),
    );

    expect(analyzeCardResponse(text).reason).toBe('table_count');
    expect(nativeTables).toHaveLength(MAX_NATIVE_TABLE_ELEMENTS);
    expect(markdownTables.length).toBeGreaterThan(0);
  });

  it('caps response element count and emits an explicit omission marker', () => {
    const blocks = Array.from({ length: MAX_RESPONSE_ELEMENTS + 10 }, (_, i) => `## Heading ${i}`);
    const elements = responseToElements(blocks.join('\n\n')) as Array<{ tag?: string; content?: string }>;

    expect(elements.length).toBeLessThanOrEqual(MAX_RESPONSE_ELEMENTS);
    expect(JSON.stringify(elements)).toContain('More content omitted');
  });
});
