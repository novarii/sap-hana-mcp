/**
 * Scope-aware tool registry.
 *
 * Creates an McpServer instance with only the tools the caller's scopes allow.
 * Each session gets its own server — listTools naturally shows only allowed tools,
 * and callTool can only reach registered handlers.
 *
 * Write tools are wrapped with an approval gate when approval config is present.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_DEFINITIONS } from "../tools/index.js";
import { resolveAllowedTools } from "../auth/scopes.js";
import { withApprovalGate } from "../approval/service.js";
import type { ApprovalStore } from "../approval/store.js";
import type { BrokerConfig } from "../auth/config.js";
import type { CallerContext } from "./context.js";

const SERVER_NAME = "sap-broker-mcp";
const SERVER_VERSION = "2.0.0";

/**
 * Create an McpServer with only the tools this caller may access.
 * Write tools are gated by approval when configured.
 */
export function createServerForCaller(
  caller: CallerContext,
  brokerConfig: BrokerConfig,
  approvalStore?: ApprovalStore,
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const allowedTools = resolveAllowedTools(caller.scopes, brokerConfig);
  const approvalConfig = brokerConfig.approval;

  for (const tool of TOOL_DEFINITIONS) {
    if (!allowedTools.has(tool.name)) continue;

    let handler = tool.handler;

    // Wrap with approval gate if this tool has an approval rule
    if (approvalConfig && approvalStore && approvalConfig.rules[tool.name]) {
      handler = withApprovalGate(
        tool.name,
        handler,
        approvalStore,
        approvalConfig,
        caller.identity,
      );
    }

    const boundHandler = handler;
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape,
      async (args: Record<string, unknown>) => {
        const result = await boundHandler(args);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );
  }

  return server;
}

/**
 * Create a dev-mode server with all tools registered (no scope filtering, no approval).
 */
export function createDevServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  for (const tool of TOOL_DEFINITIONS) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape,
      async (args: Record<string, unknown>) => {
        const result = await tool.handler(args);
        return { content: [{ type: "text" as const, text: result }] };
      },
    );
  }

  return server;
}
