export const WORKER_TASK_TEMPLATES = ['general', 'research', 'implementation', 'review', 'audit'] as const;

export type WorkerTaskTemplate = typeof WORKER_TASK_TEMPLATES[number];

export const WORKER_TASK_OUTPUT_CONTRACT_VERSION = '2026-06-05';

export interface BuildWorkerTaskPromptInput {
  prompt: string;
  taskTemplate?: unknown;
  taskId: string;
  traceId: string;
  managerBotName: string;
  workerBotName: string;
  label?: string;
  relatedTaskId?: unknown;
  workflowId?: unknown;
}

export function normalizeWorkerTaskTemplate(value: unknown): WorkerTaskTemplate {
  return typeof value === 'string' && (WORKER_TASK_TEMPLATES as readonly string[]).includes(value)
    ? value as WorkerTaskTemplate
    : 'general';
}

export function buildWorkerTaskPrompt(input: BuildWorkerTaskPromptInput): string {
  const template = normalizeWorkerTaskTemplate(input.taskTemplate);
  return [
    'You are executing a delegated MetaBot worker task.',
    '',
    '## Traceability',
    `Task ID: ${input.taskId}`,
    `Trace ID: ${input.traceId}`,
    `Manager bot: ${input.managerBotName}`,
    `Worker bot: ${input.workerBotName}`,
    input.label ? `Label: ${input.label}` : undefined,
    stringValue(input.workflowId) ? `Workflow ID: ${stringValue(input.workflowId)}` : undefined,
    stringValue(input.relatedTaskId) ? `Related task ID: ${stringValue(input.relatedTaskId)}` : undefined,
    `Template: ${template}`,
    `Output contract version: ${WORKER_TASK_OUTPUT_CONTRACT_VERSION}`,
    '',
    '## Task',
    input.prompt.trim(),
    '',
    '## Required output contract',
    '- Start with a concise conclusion.',
    '- List sources, files, commands, logs, or other inputs you consulted. If none, say so.',
    '- Describe actions taken and concrete findings/results.',
    '- List files/artifacts changed, inspected, or produced. If none, say so.',
    '- State verification performed and whether it passed, failed, or was not run.',
    '- State risks, gaps, uncertainty, or known limitations.',
    '- Recommend the next action for the manager.',
    ...templateSpecificContract(template),
  ].filter((line): line is string => line !== undefined).join('\n');
}

function templateSpecificContract(template: WorkerTaskTemplate): string[] {
  switch (template) {
    case 'research':
      return [
        '',
        '## Research-specific requirements',
        '- Prioritize source-backed findings over speculation.',
        '- Include URLs, paper titles, repository paths, or citation handles when available.',
        '- Separate established facts, plausible hypotheses, and unresolved questions.',
      ];
    case 'implementation':
      return [
        '',
        '## Implementation-specific requirements',
        '- Report changed files and exact verification commands.',
        '- Do not claim independent review is complete; implementation and review are separate manager workflow steps.',
        '- If tests fail, include the exact failure and likely cause.',
      ];
    case 'review':
      return [
        '',
        '## Review-specific requirements',
        '- Treat this as a read-only independent review unless the manager explicitly asks for fixes.',
        '- Report findings with severity, evidence, reproduction/verification notes, and pass/fail/needs-follow-up status.',
        '- Look for correctness, regression, test coverage, maintainability, and simplification opportunities.',
      ];
    case 'audit':
      return [
        '',
        '## Audit-specific requirements',
        '- Treat this as a read-only audit unless the manager explicitly asks for fixes.',
        '- Check operational risk, configuration risk, secret exposure, security, reliability, and rollback concerns.',
        '- Distinguish confirmed issues from potential risks.',
      ];
    case 'general':
      return [];
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
