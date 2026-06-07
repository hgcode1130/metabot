import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodexBotConfig } from '../../config.js';

const FALLBACK_CODEX_CONTEXT_WINDOW = 272000;
const isWindows = process.platform === 'win32';

interface CodexModelMetadata {
  model?: string;
  contextWindow?: number;
}

export function resolveCodexPath(): string {
  if (process.env.CODEX_EXECUTABLE_PATH) return process.env.CODEX_EXECUTABLE_PATH;
  try {
    const cmd = isWindows ? 'where codex' : 'which codex';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    if (!isWindows) return existingCodexPath() ?? 'codex';
    return 'codex';
  }
}

export function resolveCodexModelMetadata(codexConfig: CodexBotConfig, requestedModel?: string): CodexModelMetadata {
  const model =
    requestedModel ||
    codexConfig.model ||
    codexConfig.displayModel ||
    readCodexConfigModel(codexConfig.profile) ||
    readDefaultModelFromCache();
  return {
    model,
    contextWindow: codexConfig.contextWindow ?? readContextWindowFromCache(model) ?? fallbackContextWindow(model),
  };
}

export function buildCodexArgs(
  codexConfig: CodexBotConfig,
  cwd: string,
  prompt: string,
  sessionId: string | undefined,
  model: string | undefined,
  configArgs: string[] = [],
): string[] {
  const args = approvalArgs(codexConfig);

  args.push('-C', cwd);
  args.push(...configArgs);
  if (model) args.push('-m', model);
  if (codexConfig.profile) args.push('-p', codexConfig.profile);
  for (const extraArg of codexConfig.extraArgs ?? []) args.push(extraArg);

  args.push('exec');
  if (sessionId) {
    args.push('resume', '--json', '--skip-git-repo-check', sessionId, prompt);
    return args;
  }
  args.push('--json', '--color', 'never', '--skip-git-repo-check', prompt);
  return args;
}

function approvalArgs(codexConfig: CodexBotConfig): string[] {
  if (codexConfig.dangerouslyBypassApprovalsAndSandbox) {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  if (!codexConfig.approvalPolicy && !codexConfig.sandbox) {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  return ['-a', codexConfig.approvalPolicy ?? 'never', '--sandbox', codexConfig.sandbox ?? 'danger-full-access'];
}

function existingCodexPath(): string | undefined {
  for (const candidate of ['/usr/local/bin/codex', '/usr/bin/codex', '/opt/homebrew/bin/codex']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readCodexConfigModel(profile?: string): string | undefined {
  const configPath = codexHomePath('config.toml');
  try {
    const text = readFileSync(configPath, 'utf-8');
    const profileModel = profile ? readTomlSectionValue(text, `profiles.${profile}`, 'model') : undefined;
    return profileModel ?? readTomlTopLevelValue(text, 'model');
  } catch {
    return undefined;
  }
}

function readDefaultModelFromCache(): string | undefined {
  return readModelsCache()?.models?.find((m) => m.slug)?.slug;
}

function readContextWindowFromCache(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const found = readModelsCache()?.models?.find((m) => m.slug === model);
  return found?.context_window ?? found?.max_context_window;
}

function readModelsCache():
  | { models?: Array<{ slug?: string; context_window?: number; max_context_window?: number }> }
  | undefined {
  try {
    return JSON.parse(readFileSync(codexHomePath('models_cache.json'), 'utf-8'));
  } catch {
    return undefined;
  }
}

function codexHomePath(fileName: string): string {
  return process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, fileName)
    : path.join(os.homedir(), '.codex', fileName);
}

function readTomlTopLevelValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) return undefined;
    const value = parseTomlStringAssignment(trimmed, key);
    if (value) return value;
  }
  return undefined;
}

function readTomlSectionValue(text: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      inSection = header[1] === section;
      continue;
    }
    if (!inSection) continue;
    const value = parseTomlStringAssignment(trimmed, key);
    if (value) return value;
  }
  return undefined;
}

function parseTomlStringAssignment(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`^${key}\\s*=\\s*(.+?)(?:\\s+#.*)?$`));
  if (!match) return undefined;
  const raw = match[1].trim();
  const quoted = raw.match(/^["'](.+)["']$/);
  return quoted ? quoted[1] : raw;
}

function fallbackContextWindow(model: string | undefined): number | undefined {
  return model ? FALLBACK_CODEX_CONTEXT_WINDOW : undefined;
}
