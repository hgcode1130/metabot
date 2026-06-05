const MIN_AUDIT_LABEL_MATCHES = 2;

const TASKMASTER_DONE_LINE = /^TASKMASTER_DONE::\S+[^\S\r\n]*$/;
const GOAL_CONFRONTATION_LINE =
  /^[^\S\r\n]*(?:#{1,6}[^\S\r\n]*)?(?:(?:\d+|[IVXLCDM]+)[.)][^\S\r\n]*)?(?:\*\*)?GOAL CONFRONTATION\b/i;

const AUDIT_LABEL_PATTERNS = [
  /\boriginal requests?\b/i,
  /\bacceptance criteria\b/i,
  /\btask list\b/i,
  /\bverification\b/i,
  /\bimplementation summary\b/i,
  /\bfinal status\b/i,
];

export function selectUserFacingResponseText(currentText: string, incomingText: string | undefined): string {
  if (!incomingText) return currentText;

  const stripped = stripTaskmasterCompletionAudit(incomingText);
  if (stripped) return mergeResponseText(currentText, stripped);
  if (!isTaskmasterCompletionAudit(incomingText)) return stripped;
  return currentText === incomingText ? '' : currentText;
}

export function selectFinalResponseText(currentText: string, incomingText: string | undefined): string {
  if (!incomingText) return currentText;

  const stripped = stripTaskmasterCompletionAudit(incomingText);
  if (stripped) return stripped;
  if (!isTaskmasterCompletionAudit(incomingText)) return stripped;
  return currentText === incomingText ? '' : currentText;
}

export function stripTaskmasterCompletionAudit(text: string): string {
  if (!text) return text;

  const hasDoneSignal = hasTaskmasterDoneSignal(text);
  const withoutDoneSignal = hasDoneSignal ? removeTaskmasterDoneLines(text) : text;
  const auditStart = findGoalConfrontationStart(withoutDoneSignal);
  if (auditStart === -1) return hasDoneSignal ? withoutDoneSignal.trimEnd() : text;
  if (!hasDoneSignal && !hasTaskmasterAuditLabels(withoutDoneSignal.slice(auditStart))) return text;
  return withoutDoneSignal.slice(0, auditStart).trimEnd();
}

export function isTaskmasterCompletionAudit(text: string): boolean {
  if (!text.trim()) return false;
  if (hasTaskmasterDoneSignal(text)) return true;

  const auditStart = findGoalConfrontationStart(text);
  if (auditStart === -1) return false;
  return hasTaskmasterAuditLabels(text.slice(auditStart));
}

function hasTaskmasterDoneSignal(text: string): boolean {
  return splitLines(text).some((line) => TASKMASTER_DONE_LINE.test(line));
}

function removeTaskmasterDoneLines(text: string): string {
  return splitLines(text)
    .filter((line) => !TASKMASTER_DONE_LINE.test(line))
    .join('\n');
}

function findGoalConfrontationStart(text: string): number {
  let offset = 0;
  for (const line of splitLines(text)) {
    if (GOAL_CONFRONTATION_LINE.test(line)) return offset;
    offset += line.length + lineBreakLengthAt(text, offset + line.length);
  }
  return -1;
}

function hasTaskmasterAuditLabels(text: string): boolean {
  const matchCount = AUDIT_LABEL_PATTERNS.filter((pattern) => pattern.test(text)).length;
  return matchCount >= MIN_AUDIT_LABEL_MATCHES;
}

function mergeResponseText(currentText: string, incomingText: string): string {
  if (!currentText) return incomingText;
  if (currentText === incomingText) return incomingText;
  if (incomingText.startsWith(currentText)) return incomingText;
  if (currentText.endsWith(incomingText)) return currentText;
  return currentText + responseJoiner(currentText, incomingText) + incomingText;
}

function responseJoiner(currentText: string, incomingText: string): string {
  if (/\s$/.test(currentText) || /^\s/.test(incomingText)) return '';
  if (/[.!?。！？:：)`\]]$/.test(currentText)) return '\n\n';
  if (/^(?:#{1,6}\s|\d+[.)]\s|- |\* )/.test(incomingText)) return '\n\n';
  return '';
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function lineBreakLengthAt(text: string, index: number): number {
  if (text.slice(index, index + 2) === '\r\n') return 2;
  if (text[index] === '\n') return 1;
  return 0;
}
