import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../../utils/logger.js';
import type { ManagerScope, ManagerService } from '../../api/manager-service.js';
import {
  MANAGER_MCP_ALLOWED_TOOLS,
  MANAGER_MCP_SERVER_NAME,
  MANAGER_TOOL_SPECS,
  managerToolContent,
  runManagerToolSafely,
} from '../../api/manager-tools.js';

export { MANAGER_MCP_ALLOWED_TOOLS, MANAGER_MCP_SERVER_NAME };

export interface ManagerMcpOptions {
  service: ManagerService;
  scope: ManagerScope;
  logger: Logger;
}

export function buildManagerMcpServer(options: ManagerMcpOptions): McpSdkServerConfigWithInstance {
  const { service, scope, logger } = options;
  return createSdkMcpServer({
    name: MANAGER_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: MANAGER_TOOL_SPECS.map((spec) =>
      tool(spec.name, spec.description, spec.inputSchema, async (args) =>
        managerToolContent(
          await runManagerToolSafely({
            service,
            scope,
            logger,
            name: spec.name,
            args: args as Record<string, unknown>,
          }),
        ),
      ),
    ),
  });
}

export function getManagerMcpAllowedTools(): string[] {
  return [...MANAGER_MCP_ALLOWED_TOOLS];
}
