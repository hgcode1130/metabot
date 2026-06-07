import type { ApiContext } from '../claude/executor.js';
import { buildManagerWorkerGuidance } from '../../api/manager-worker-guidance.js';

export function buildCodexPromptWithContext(options: {
  prompt: string;
  outputsDir?: string;
  apiContext?: ApiContext;
}): string {
  const sections = contextSections(options.outputsDir, options.apiContext);
  if (sections.length === 0) return options.prompt;
  return `${options.prompt}\n\n---\n\n${sections.join('\n\n')}`;
}

function contextSections(outputsDir: string | undefined, apiContext: ApiContext | undefined): string[] {
  const sections: string[] = [];
  if (outputsDir) sections.push(outputFilesSection(outputsDir));
  if (!apiContext) return sections;

  sections.push(
    `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`,
  );
  if (apiContext.managerToolsEnabled) sections.push(buildManagerWorkerGuidance());

  const group = groupChatSection(apiContext);
  if (group) sections.push(group);
  return sections;
}

function outputFilesSection(outputsDir: string): string {
  return `## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nThe bridge will automatically send files placed there to the user.`;
}

function groupChatSection(apiContext: ApiContext): string | undefined {
  if (!apiContext.groupMembers || apiContext.groupMembers.length === 0 || !apiContext.groupId) {
    return undefined;
  }
  const others = apiContext.groupMembers.filter((m) => m !== apiContext.botName);
  return `## Group Chat\nYou are in a group chat (group: ${apiContext.groupId}) with these bots: ${others.join(', ')}.\nTo talk to another bot, use: \`mb talk <botName> grouptalk-${apiContext.groupId}-<botName> "message"\``;
}
