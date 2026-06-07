export interface ProgressUpdate {
  text: string;
  timestamp?: number;
  source?: 'assistant' | 'agent_activity';
}

const MAX_PROGRESS_TEXT_CHARS = 1200;
const MAX_PROGRESS_LINES = 8;

const PROGRESS_START = [
  /^\s*(?:我会|我将|我先|我继续|继续|接下来|下一步|现在|先|随后)/,
  /^\s*(?:I will|I'll|I am going to|Next,|Now,|First,|I will continue)\b/i,
];

const PROGRESS_HINT = [
  /不会启动\s*train/i,
  /不会\s*(?:push|训练|删除)/i,
  /\bwithout (?:starting|running|launching)\b/i,
  /\bwill (?:continue|first|now|next|check|verify|sync|commit)\b/i,
];

const PROGRESS_ACTION_HINT = [
  /(?:继续|接下来|下一步|现在|随后|确认|查看|检查|同步|更新|登记|运行|重跑|提交|启动|训练|收尾|验证|整理|标记|准备)/,
  /\b(?:continue|next|now|check|verify|sync|commit|start|run|finish|update|inspect)\b/i,
];

export function isProgressUpdateText(text: string | undefined): boolean {
  const normalized = normalizeProgressText(text);
  if (!normalized) return false;
  if (normalized.length > MAX_PROGRESS_TEXT_CHARS) return false;
  if (normalized.includes('```')) return false;
  if (/^#{1,6}\s/m.test(normalized)) return false;
  if (lineCount(normalized) > MAX_PROGRESS_LINES) return false;
  return PROGRESS_HINT.some((pattern) => pattern.test(normalized))
    || (startsLikeProgress(normalized) && hasProgressAction(normalized));
}

export function toProgressUpdate(
  text: string,
  source: ProgressUpdate['source'],
  timestamp = Date.now(),
): ProgressUpdate {
  return { text: normalizeProgressText(text), source, timestamp };
}

export function removeProgressText(currentText: string, incomingText: string): string {
  const incoming = normalizeProgressText(incomingText);
  if (!incoming || !currentText) return currentText;
  if (currentText === incoming) return '';
  if (currentText.endsWith(incoming)) return currentText.slice(0, -incoming.length).trimEnd();
  return currentText;
}

export function partitionProgressText(
  snippets: string[],
  source: ProgressUpdate['source'],
): { content: string[]; progress: ProgressUpdate[] } {
  const content: string[] = [];
  const progress: ProgressUpdate[] = [];
  for (const snippet of snippets) {
    if (isProgressUpdateText(snippet)) {
      progress.push(toProgressUpdate(snippet, source));
    } else {
      content.push(snippet);
    }
  }
  return { content, progress };
}

function startsLikeProgress(text: string): boolean {
  return PROGRESS_START.some((pattern) => pattern.test(text));
}

function hasProgressAction(text: string): boolean {
  return PROGRESS_ACTION_HINT.some((pattern) => pattern.test(text));
}

function normalizeProgressText(text: string | undefined): string {
  return typeof text === 'string' ? text.trim() : '';
}

function lineCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}
