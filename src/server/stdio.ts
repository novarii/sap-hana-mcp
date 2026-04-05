/**
 * Stdio transport for SAP Broker MCP (dev mode).
 *
 * Registers all tools with no auth required.
 * Preserves backward compatibility with the original sap-hana-mcp stdio behavior.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDevServer } from "./registry.js";

export async function startStdioServer(): Promise<void> {
  const server = createDevServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SAP Broker MCP running on stdio (dev mode — all tools, no auth)");
}
