import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
    apiSecret: process.env.METABOT_API_SECRET,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
