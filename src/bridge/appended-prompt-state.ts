import type { CardState, TeamState } from '../types.js';

const APPENDED_PROMPT_PREVIEW_CHARS = 120;

export function buildAppendedPromptCardState(options: {
  readonly state: CardState;
  readonly teamState?: TeamState;
  readonly prompt: string;
}): CardState {
  const note = `_Added your latest message to this running task: ${truncateForCardNote(
    options.prompt,
    APPENDED_PROMPT_PREVIEW_CHARS,
  )}_`;
  return {
    ...options.state,
    status: 'running',
    teamState: options.teamState ?? options.state.teamState,
    responseText: options.state.responseText
      ? `${options.state.responseText}\n\n${note}`
      : note,
  };
}

function truncateForCardNote(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars) + '...';
}
