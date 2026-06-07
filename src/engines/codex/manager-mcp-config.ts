import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ApiContext } from '../claude/executor.js';
import { MANAGER_MCP_SERVER_NAME } from '../../api/manager-tools.js';

const DEFAULT_MANAGER_API_PORT = '9100';
const LOCAL_BIN_DIR = '../../../node_modules/.bin';

export function buildCodexManagerMcpConfigArgs(apiContext: ApiContext | undefined): string[] {
  if (!apiContext?.managerToolsEnabled) return [];
  const launch = resolveManagerMcpLaunch();
  return [
    ...configOverride('experimental_use_rmcp_client', 'true'),
    ...serverOverride('command', tomlString(launch.command)),
    ...serverOverride('args', tomlStringArray(launch.args)),
    ...serverEnvOverride('METABOT_MANAGER_BOT_NAME', apiContext.botName),
    ...serverEnvOverride('METABOT_MANAGER_CHAT_ID', apiContext.chatId),
    ...serverEnvOverride('METABOT_MANAGER_API_BASE_URL', localManagerApiBaseUrl()),
  ];
}

export function buildCodexManagerMcpEnv(apiContext: ApiContext | undefined): Record<string, string> {
  if (!apiContext?.managerToolsEnabled) return {};
  const apiSecret = managerApiSecret();
  return apiSecret ? { METABOT_API_SECRET: apiSecret } : {};
}

function resolveManagerMcpLaunch(): { command: string; args: string[] } {
  const jsPath = fileURLToPath(new URL('./manager-mcp-server.js', import.meta.url));
  if (existsSync(jsPath)) return { command: process.execPath, args: [jsPath] };

  const tsPath = fileURLToPath(new URL('./manager-mcp-server.ts', import.meta.url));
  const tsxPath = localTsxPath();
  if (existsSync(tsPath) && tsxPath) return { command: tsxPath, args: [tsPath] };

  throw new Error(
    `Codex manager MCP server not found near ${path.dirname(jsPath)}. Build MetaBot before using Codex manager tools.`,
  );
}

function localTsxPath(): string | undefined {
  const suffix = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const candidate = fileURLToPath(new URL(`${LOCAL_BIN_DIR}/${suffix}`, import.meta.url));
  return existsSync(candidate) ? candidate : undefined;
}

function localManagerApiBaseUrl(): string {
  if (process.env.METABOT_MANAGER_API_BASE_URL) return process.env.METABOT_MANAGER_API_BASE_URL;
  const port = process.env.METABOT_API_PORT || process.env.API_PORT || DEFAULT_MANAGER_API_PORT;
  return `http://127.0.0.1:${port}`;
}

function managerApiSecret(): string | undefined {
  return trimmed(process.env.METABOT_API_SECRET) ?? trimmed(process.env.API_SECRET);
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function serverOverride(key: string, value: string): string[] {
  return configOverride(`mcp_servers.${MANAGER_MCP_SERVER_NAME}.${key}`, value);
}

function serverEnvOverride(key: string, value: string): string[] {
  return configOverride(`mcp_servers.${MANAGER_MCP_SERVER_NAME}.env.${key}`, tomlString(value));
}

function configOverride(key: string, value: string): string[] {
  return ['-c', `${key}=${value}`];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}
