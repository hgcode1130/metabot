import type { SideEffectClass } from './retry-policy.js';

export const INSTRUCTION_CONTRACT_VERSION = '2026-06-07';

export interface InstructionContract {
  version: string;
  objective: string;
  forbiddenActions: string[];
  acceptanceCriteria: string[];
  sideEffectClass: SideEffectClass;
  idempotencyKey?: string;
}

export interface InstructionContractInput {
  prompt: string;
  metadata?: Record<string, unknown>;
  sideEffectClass?: SideEffectClass;
  idempotencyKey?: string;
}

const OBJECTIVE_LIMIT = 500;

const FORBIDDEN_PATTERNS: Array<{ action: string; pattern: RegExp }> = [
  { action: 'train', pattern: /(?:不要|别|禁止|不得|不能|不会|不启动|不跑).{0,24}(?:train|训练)/i },
  { action: 'train', pattern: /(?:do not|don't|never|must not|without).{0,40}(?:train|training|fine[-_ ]?tune)/i },
  { action: 'push', pattern: /(?:不要|别|禁止|不得|不能|不会).{0,24}(?:push|推送)/i },
  { action: 'push', pattern: /(?:do not|don't|never|must not|without).{0,40}(?:git push|push)/i },
  { action: 'delete', pattern: /(?:不要|别|禁止|不得|不能|不会).{0,24}(?:删除|rm\s+-|clean)/i },
  { action: 'delete', pattern: /(?:do not|don't|never|must not|without).{0,40}(?:delete|remove|rm\s+-|git clean)/i },
  { action: 'scan_all', pattern: /(?:只看|只读|仅看|仅检查).{0,80}(?:文件|file|路径|path)/i },
  { action: 'scan_all', pattern: /(?:only|just).{0,40}(?:inspect|read|check).{0,80}(?:file|path)/i },
  { action: 'deploy', pattern: /(?:看看|检查|评估).{0,40}(?:能不能|是否|可否).{0,40}(?:部署|上线)/i },
  { action: 'deploy', pattern: /(?:check|see|evaluate).{0,40}(?:whether|if|can).{0,40}(?:deploy|release)/i },
];

export function buildInstructionContract(input: InstructionContractInput): InstructionContract {
  const metadataContract = readMetadataContract(input.metadata);
  const forbiddenActions = uniqueStrings([
    ...extractForbiddenActions(input.prompt),
    ...readStringArray(input.metadata?.forbiddenActions),
    ...readStringArray(metadataContract?.forbiddenActions),
  ]);
  return {
    version: INSTRUCTION_CONTRACT_VERSION,
    objective: readString(metadataContract?.objective) ?? summarizeObjective(input.prompt),
    forbiddenActions,
    acceptanceCriteria: uniqueStrings([
      ...readStringArray(input.metadata?.acceptanceCriteria),
      ...readStringArray(metadataContract?.acceptanceCriteria),
    ]),
    sideEffectClass: input.sideEffectClass ?? readSideEffectClass(input.metadata?.sideEffectClass),
    idempotencyKey: input.idempotencyKey ?? readString(input.metadata?.idempotencyKey),
  };
}

export function contractMetadata(contract: InstructionContract): Record<string, unknown> {
  return {
    version: contract.version,
    objective: contract.objective,
    forbiddenActions: contract.forbiddenActions,
    acceptanceCriteria: contract.acceptanceCriteria,
    sideEffectClass: contract.sideEffectClass,
    ...(contract.idempotencyKey ? { idempotencyKey: contract.idempotencyKey } : {}),
  };
}

export function readInstructionContract(value: unknown): InstructionContract | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  return {
    version: readString(obj.version) ?? INSTRUCTION_CONTRACT_VERSION,
    objective: readString(obj.objective) ?? '',
    forbiddenActions: readStringArray(obj.forbiddenActions),
    acceptanceCriteria: readStringArray(obj.acceptanceCriteria),
    sideEffectClass: readSideEffectClass(obj.sideEffectClass),
    idempotencyKey: readString(obj.idempotencyKey),
  };
}

function extractForbiddenActions(prompt: string): string[] {
  return FORBIDDEN_PATTERNS
    .filter((item) => item.pattern.test(prompt))
    .map((item) => item.action);
}

function summarizeObjective(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, OBJECTIVE_LIMIT);
}

function readMetadataContract(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = metadata?.instructionContract;
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readSideEffectClass(value: unknown): SideEffectClass {
  if (value === 'none' || value === 'readOnly' || value === 'localWrite' || value === 'externalWrite') return value;
  return 'unknown';
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
