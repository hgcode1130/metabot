import type { SideEffectClass } from './retry-policy.js';

export interface ActionGatePolicy {
  forbiddenActions: string[];
  sideEffectClass?: SideEffectClass;
  taskId?: string;
  traceId?: string;
}

export interface ActionGateDecision {
  allowed: boolean;
  action?: string;
  reason?: string;
  command?: string;
}

const TRAIN_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?train\b/i,
  /\b(?:python|python3)\b[^\n;&|]*\btrain(?:\.py|\b|_)/i,
  /\b(?:torchrun|deepspeed|accelerate\s+launch)\b/i,
  /\b(?:train|training|fine[-_ ]?tune)\b/i,
];

const PUSH_PATTERNS = [/\bgit\s+push\b/i];
const DELETE_PATTERNS = [/\brm\s+-[^\n;&|]*r/i, /\bgit\s+clean\s+-/i];
const SCAN_ALL_PATTERNS = [
  /^find\s+\./i,
  /^git\s+grep\b/i,
  /^ls\s+-[^\n]*R\b/i,
];
const DEPLOY_PATTERNS = [
  /\bkubectl\s+(?:apply|rollout|scale|delete|patch)\b/i,
  /\bhelm\s+(?:install|upgrade|rollback|uninstall)\b/i,
  /\b(?:vercel|fly|netlify|wrangler)\s+(?:deploy|--prod)\b/i,
  /\bserverless\s+deploy\b/i,
];
const SHELL_CONTROL_OPERATOR_PATTERN = /[;&|<>`$]/;
const SAFE_READ_ONLY_COMMAND_PATTERNS = [
  /^(?:pwd|ls|cat|nl|wc)\b/,
  /^rg\b/,
  /^grep\b/,
  /^sed\s+-n\b/,
  /^git\s+(?:status|diff|show|log|grep|ls-files|branch|rev-parse|describe)\b/,
  /^timeout\s+\d+s?\s+(?:npx\s+)?(?:vitest\b|tsc\s+--noEmit\b)/,
  /^(?:npx\s+)?(?:vitest\b|tsc\s+--noEmit\b)/,
  /^timeout\s+\d+s?\s+(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
];

export function evaluateToolUseActionGate(
  policy: ActionGatePolicy | undefined,
  toolName: string,
  toolInput: unknown,
): ActionGateDecision {
  const actions = normalizeActions(policy?.forbiddenActions);
  if (toolName !== 'Bash') return { allowed: true };

  const command = readCommand(toolInput);
  if (!command) return { allowed: true };

  if (policy?.sideEffectClass === 'readOnly' && !isReadOnlyBashCommand(command)) {
    return {
      allowed: false,
      action: 'readOnly',
      command,
      reason: 'Bash command blocked by read-only worker policy',
    };
  }

  if (actions.length === 0) return { allowed: true };

  for (const action of actions) {
    if (matchesForbiddenAction(action, command)) {
      return {
        allowed: false,
        action,
        command,
        reason: `Action blocked by instruction contract: ${action}`,
      };
    }
  }
  return { allowed: true };
}

function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL_OPERATOR_PATTERN.test(trimmed)) return false;
  return SAFE_READ_ONLY_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function denialHookOutput(decision: ActionGateDecision): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason ?? 'Action blocked by instruction contract',
    },
  };
}

function matchesForbiddenAction(action: string, command: string): boolean {
  if (action === 'train') return TRAIN_PATTERNS.some((pattern) => pattern.test(command));
  if (action === 'push') return PUSH_PATTERNS.some((pattern) => pattern.test(command));
  if (action === 'delete') return DELETE_PATTERNS.some((pattern) => pattern.test(command));
  if (action === 'scan_all') return matchesRepoWideScan(command);
  if (action === 'deploy') return DEPLOY_PATTERNS.some((pattern) => pattern.test(command));
  return command.toLowerCase().includes(action.toLowerCase());
}

function matchesRepoWideScan(command: string): boolean {
  const trimmed = command.trim();
  if (SCAN_ALL_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (!/^rg\b/i.test(trimmed)) return false;
  const args = trimmed.split(/\s+/).slice(1);
  if (args.includes('.')) return true;
  return args.filter((arg) => !arg.startsWith('-')).length <= 1;
}

function readCommand(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

function normalizeActions(actions: string[] | undefined): string[] {
  if (!actions) return [];
  return Array.from(new Set(actions.map((action) => action.trim()).filter(Boolean)));
}
