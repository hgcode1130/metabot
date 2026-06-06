import { z } from 'zod';
import type { BotsJsonNewFormat, FeishuBotJsonEntry } from './config.js';

const managerSchema = z.object({
  enabled: z.boolean().optional(),
  workers: z.array(z.string().min(1)).optional(),
  allowAllLocalWorkers: z.boolean().optional(),
  maxConcurrentWorkerTasks: z.number().int().positive().optional(),
}).passthrough();

const persistentExecutorSchema = z.object({
  enabled: z.boolean().optional(),
  idleTimeoutMs: z.number().int().min(0).optional(),
  maxConcurrent: z.number().int().positive().optional(),
}).passthrough();

const kimiSchema = z.object({
  executable: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.boolean().optional(),
  apiKey: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
}).passthrough();

const codexSchema = z.object({
  executable: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  displayModel: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  approvalPolicy: z.enum(['untrusted', 'on-failure', 'on-request', 'never']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  dangerouslyBypassApprovalsAndSandbox: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  extraArgs: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).passthrough();

const engineFieldsSchema = z.object({
  engine: z.enum(['claude', 'kimi', 'codex']).optional(),
  kimi: kimiSchema.optional(),
  codex: codexSchema.optional(),
  manager: managerSchema.optional(),
  persistentExecutor: persistentExecutorSchema.optional(),
}).passthrough();

const sharedBotFieldsSchema = engineFieldsSchema.extend({
  name: z.string().min(1),
  description: z.string().optional(),
  specialties: z.array(z.string().min(1)).optional(),
  icon: z.string().optional(),
  maxConcurrentTasks: z.number().int().positive().optional(),
  budgetLimitDaily: z.number().nonnegative().optional(),
  ttsVoice: z.string().optional(),
  defaultWorkingDirectory: z.string().min(1),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().nonnegative().optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  outputsBaseDir: z.string().min(1).optional(),
  downloadsDir: z.string().min(1).optional(),
}).passthrough();

const feishuBotSchema = sharedBotFieldsSchema.extend({
  feishuAppId: z.string().min(1),
  feishuAppSecret: z.string().min(1),
  groupNoMention: z.boolean().optional(),
}).passthrough();

const telegramBotSchema = sharedBotFieldsSchema.extend({
  telegramBotToken: z.string().min(1),
}).passthrough();

const webBotSchema = sharedBotFieldsSchema.passthrough();

const wechatBotSchema = engineFieldsSchema.extend({
  name: z.string().min(1),
  description: z.string().optional(),
  specialties: z.array(z.string().min(1)).optional(),
  icon: z.string().optional(),
  ilinkBaseUrl: z.string().min(1).optional(),
  wechatBotToken: z.string().min(1).optional(),
  defaultWorkingDirectory: z.string().min(1),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().nonnegative().optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  outputsBaseDir: z.string().min(1).optional(),
  downloadsDir: z.string().min(1).optional(),
}).passthrough();

const peerSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  secret: z.string().optional(),
}).passthrough();

const taskExecutionSchema = z.object({
  maxConcurrentTasks: z.number().int().positive().optional(),
  maxConcurrentTasksPerChat: z.number().int().positive().optional(),
  maxBackgroundWorkerTasks: z.number().int().positive().optional(),
}).passthrough();

const botsObjectSchema = z.object({
  feishuBots: z.array(feishuBotSchema).optional(),
  telegramBots: z.array(telegramBotSchema).optional(),
  webBots: z.array(webBotSchema).optional(),
  wechatBots: z.array(wechatBotSchema).optional(),
  peers: z.array(peerSchema).optional(),
  taskExecution: taskExecutionSchema.optional(),
}).passthrough();

const botsArraySchema = z.array(feishuBotSchema);

export function validateBotsConfig(
  config: unknown,
  source = 'BOTS_CONFIG',
): asserts config is BotsJsonNewFormat | FeishuBotJsonEntry[] {
  const result = Array.isArray(config)
    ? botsArraySchema.safeParse(config)
    : botsObjectSchema.safeParse(config);

  if (!result.success) {
    throw new Error(formatConfigValidationError(source, result.error));
  }

  if (!Array.isArray(config) && (!config || typeof config !== 'object')) {
    throw new Error(`${source} must contain a JSON array or object`);
  }

  const botNames = collectBotNames(config);
  if (botNames.length === 0) {
    throw new Error(`${source} must define at least one bot`);
  }

  const seen = new Set<string>();
  for (const name of botNames) {
    if (seen.has(name)) {
      throw new Error(`${source} contains duplicate bot name: ${name}`);
    }
    seen.add(name);
  }
}

function collectBotNames(config: unknown): string[] {
  if (Array.isArray(config)) {
    return config.map((entry) => entry?.name).filter((name): name is string => typeof name === 'string');
  }
  if (!config || typeof config !== 'object') return [];
  const cfg = config as BotsJsonNewFormat;
  return [
    ...(cfg.feishuBots ?? []).map((entry) => entry.name),
    ...(cfg.telegramBots ?? []).map((entry) => entry.name),
    ...(cfg.webBots ?? []).map((entry) => entry.name),
    ...(cfg.wechatBots ?? []).map((entry) => entry.name),
  ];
}

function formatConfigValidationError(source: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return `${source} validation failed: ${issues}`;
}
