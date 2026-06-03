import { parseMarkdownToBlocks, type Block } from './markdown-parser.js';

export const MAX_INLINE_RESPONSE_CHARS = 12_000;
export const MAX_NATIVE_TABLE_ELEMENTS = 3;
export const MAX_RESPONSE_ELEMENTS = 60;

const PREVIEW_HEAD_CHARS = 8_000;
const PREVIEW_TAIL_CHARS = 2_500;
const TABLE_PAGE_SIZE = 10;

export type CardResponseLimitReason = 'length' | 'table_count' | 'element_count';

export interface CardResponseAnalysis {
  readonly needsAttachment: boolean;
  readonly reason?: CardResponseLimitReason;
  readonly charCount: number;
  readonly blockCount: number;
  readonly tableCount: number;
}

function limitReason(text: string, blocks: readonly Block[]): CardResponseLimitReason | undefined {
  if (text.length > MAX_INLINE_RESPONSE_CHARS) return 'length';
  if (blocks.filter((block) => block.type === 'table').length > MAX_NATIVE_TABLE_ELEMENTS) {
    return 'table_count';
  }
  if (blocks.length > MAX_RESPONSE_ELEMENTS) return 'element_count';
  return undefined;
}

export function analyzeCardResponse(text: string): CardResponseAnalysis {
  const blocks = parseMarkdownToBlocks(text);
  const reason = limitReason(text, blocks);
  return {
    needsAttachment: reason !== undefined,
    ...(reason ? { reason } : {}),
    charCount: text.length,
    blockCount: blocks.length,
    tableCount: blocks.filter((block) => block.type === 'table').length,
  };
}

function previewBody(text: string): string {
  if (text.length <= MAX_INLINE_RESPONSE_CHARS) return text;
  return [
    text.slice(0, PREVIEW_HEAD_CHARS),
    '',
    '... (middle omitted from Feishu card preview) ...',
    '',
    text.slice(-PREVIEW_TAIL_CHARS),
  ].join('\n');
}

export function buildInlineResponsePreview(
  text: string,
  attachmentFileName?: string,
  attachmentFailed: boolean = false,
): string {
  const analysis = analyzeCardResponse(text);
  if (!analysis.needsAttachment) return text;
  const notice = attachmentNotice(attachmentFileName, attachmentFailed);
  return [notice, '', previewBody(text)].join('\n');
}

function attachmentNotice(fileName: string | undefined, failed: boolean): string {
  if (failed) {
    return '**Full response attachment upload failed.** Showing a Feishu-safe preview below.';
  }
  if (fileName) {
    return `**Full response attached:** \`${fileName}\`. Showing a Feishu-safe preview below.`;
  }
  return '**Response shortened for Feishu card limits.** Showing a Feishu-safe preview below.';
}

function tableBlockToElement(block: Extract<Block, { type: 'table' }>): unknown {
  const columns = block.headers.map((h, i) => ({
    name:             `col${i}`,
    display_name:     h,
    data_type:        'lark_md',
    horizontal_align: block.align[i] ?? 'left',
    vertical_align:   'center',
    width:            'auto',
  }));
  const rows = block.rows.map((row) => {
    const obj: Record<string, string> = {};
    row.forEach((cell, i) => { obj[`col${i}`] = cell; });
    return obj;
  });
  return {
    tag:       'table',
    page_size: TABLE_PAGE_SIZE,
    row_height: 'low',
    header_style: {
      text_align:       'center',
      background_style: 'grey',
      bold:             true,
      lines:            1,
    },
    columns,
    rows,
  };
}

function tableBlockToMarkdown(block: Extract<Block, { type: 'table' }>): string {
  const divider = block.headers.map(() => '---');
  const rows = [block.headers, divider, ...block.rows];
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function blockToElement(block: Block, nativeTable: boolean): unknown {
  if (block.type === 'table') {
    return nativeTable
      ? tableBlockToElement(block)
      : { tag: 'markdown', content: '```\n' + tableBlockToMarkdown(block) + '\n```' };
  }
  if (block.type === 'heading') {
    return { tag: 'div', text: { tag: 'lark_md', content: '#'.repeat(block.level) + ' ' + block.text } };
  }
  if (block.type === 'codeblock') {
    return { tag: 'markdown', content: '```\n' + block.code + '\n```' };
  }
  if (block.type === 'hr') return { tag: 'hr' };
  return { tag: 'markdown', content: block.text, text_align: 'left' };
}

export function responseToElements(text: string): unknown[] {
  const previewText = buildInlineResponsePreview(text);
  const blocks = parseMarkdownToBlocks(previewText);
  const elements: unknown[] = [];
  let nativeTables = 0;
  for (const block of blocks) {
    if (elements.length >= MAX_RESPONSE_ELEMENTS - 1) {
      elements.push({ tag: 'markdown', content: '_More content omitted from the card preview._' });
      break;
    }
    const useNativeTable = block.type === 'table' && nativeTables < MAX_NATIVE_TABLE_ELEMENTS;
    if (useNativeTable) nativeTables++;
    elements.push(blockToElement(block, useNativeTable));
  }
  return elements;
}
