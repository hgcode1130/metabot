export interface ActionGatePolicy {
  forbiddenActions: string[];
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

export function evaluateToolUseActionGate(
  policy: ActionGatePolicy | undefined,
  toolName: string,
  toolInput: unknown,
): ActionGateDecision {
  const actions = normalizeActions(policy?.forbiddenActions);
  if (actions.length === 0) return { allowed: true };
  if (toolName !== 'Bash') return { allowed: true };

  const command = readCommand(toolInput);
  if (!command) return { allowed: true };

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
  return command.toLowerCase().includes(action.toLowerCase());
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
