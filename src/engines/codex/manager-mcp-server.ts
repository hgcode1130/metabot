import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MANAGER_MCP_SERVER_NAME,
  MANAGER_TOOL_SPECS,
  managerToolContent,
  type ManagerToolResult,
} from '../../api/manager-tools.js';

interface ManagerMcpEnv {
  managerBotName: string;
  managerChatId: string;
  apiBaseUrl: string;
  apiSecret?: string;
}

async function main(): Promise<void> {
  const env = readEnv();
  const server = new McpServer({ name: MANAGER_MCP_SERVER_NAME, version: '1.0.0' });
  registerManagerTools(server, env);
  await server.connect(new StdioServerTransport());
}

function registerManagerTools(server: McpServer, env: ManagerMcpEnv): void {
  for (const spec of MANAGER_TOOL_SPECS) {
    server.registerTool(spec.name, { description: spec.description, inputSchema: spec.inputSchema }, async (args) =>
      managerToolContent(await callManagerTool(env, spec.name, args)),
    );
  }
}

async function callManagerTool(
  env: ManagerMcpEnv,
  name: string,
  args: Record<string, unknown>,
): Promise<ManagerToolResult> {
  const body = {
    managerBotName: env.managerBotName,
    managerChatId: env.managerChatId,
    args,
  };
  const payload = await postJson(env, `/api/manager/tools/${encodeURIComponent(name)}`, body);
  return { payload, isError: payload.ok === false };
}

async function postJson(
  env: ManagerMcpEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, env.apiBaseUrl), {
    method: 'POST',
    headers: requestHeaders(env),
    body: JSON.stringify(body),
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) return httpErrorPayload(response, payload);
  return payload;
}

function requestHeaders(env: ManagerMcpEnv): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(env.apiSecret ? { authorization: `Bearer ${env.apiSecret}` } : {}),
  };
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: parsed };
  } catch (err: any) {
    throw new Error(`Manager API returned non-JSON response: ${err?.message || String(err)}`, { cause: err });
  }
}

function httpErrorPayload(response: Response, payload: Record<string, unknown>): Record<string, unknown> {
  const error =
    typeof payload.error === 'string' ? payload.error : `Manager API request failed with HTTP ${response.status}`;
  return { ok: false, error, status: response.status };
}

function readEnv(): ManagerMcpEnv {
  return {
    managerBotName: requiredEnv('METABOT_MANAGER_BOT_NAME'),
    managerChatId: requiredEnv('METABOT_MANAGER_CHAT_ID'),
    apiBaseUrl: requiredEnv('METABOT_MANAGER_API_BASE_URL').replace(/\/+$/, ''),
    apiSecret: resolveManagerMcpApiSecret(process.env),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function resolveManagerMcpApiSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return trimmed(env.METABOT_API_SECRET)
    ?? trimmed(env.API_SECRET)
    ?? readEnvFileSecret(env, 'METABOT_API_SECRET')
    ?? readEnvFileSecret(env, 'API_SECRET');
}

function readEnvFileSecret(env: NodeJS.ProcessEnv, key: string): string | undefined {
  for (const filePath of envFileCandidates(env)) {
    const value = readEnvFileValue(filePath, key);
    if (value) return value;
  }
  return undefined;
}

function envFileCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [
    env.METABOT_HOME ? path.join(env.METABOT_HOME, '.env') : undefined,
    path.join(repoRootDir(), '.env'),
    path.join(os.homedir(), 'metabot', '.env'),
  ];
  return [...new Set(candidates.filter((item): item is string => !!item))];
}

function readEnvFileValue(filePath: string, key: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (parsed?.key === key) return trimmed(parsed.value);
  }
  return undefined;
}

function parseEnvLine(line: string): { key: string; value: string } | undefined {
  const normalized = line.trim();
  if (!normalized || normalized.startsWith('#')) return undefined;
  const body = normalized.startsWith('export ') ? normalized.slice('export '.length).trim() : normalized;
  const index = body.indexOf('=');
  if (index <= 0) return undefined;
  const key = body.slice(0, index).trim();
  const value = unquoteEnvValue(body.slice(index + 1).trim());
  return { key, value };
}

function unquoteEnvValue(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === last && (first === '"' || first === "'")) ? value.slice(1, -1) : value;
}

function repoRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isMainModule(): boolean {
  return process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false;
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exitCode = 1;
  });
}
