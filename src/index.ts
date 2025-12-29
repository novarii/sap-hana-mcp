#!/usr/bin/env node

/**
 * SAP HANA MCP Server
 *
 * A Model Context Protocol server providing read-only access to SAP HANA databases.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  listSchemasSchema,
  listTablesSchema,
  listViewsSchema,
  describeTableSchema,
  executeQuerySchema,
  getTableSampleSchema,
  listSchemas,
  listTables,
  listViews,
  describeTable,
  executeUserQuery,
  getTableSample,
} from "./tools/index.js";
import { testConnection } from "./hana/client.js";
import { getConfig } from "./config.js";

// Create MCP server
const server = new McpServer({
  name: "sap-hana-mcp",
  version: "1.0.0",
});

// ============================================================================
// Register Tools
// ============================================================================

server.tool(
  "list_schemas",
  "List all accessible database schemas. If HANA_SCHEMA is configured, only shows that schema.",
  listSchemasSchema.shape,
  async () => {
    const result = await listSchemas();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "list_tables",
  "List all tables in a schema with their types and record counts.",
  listTablesSchema.shape,
  async (args) => {
    const result = await listTables(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "list_views",
  "List all views in a schema.",
  listViewsSchema.shape,
  async (args) => {
    const result = await listViews(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "describe_table",
  "Get detailed information about a table or view including columns, primary keys, indexes, and foreign keys.",
  describeTableSchema.shape,
  async (args) => {
    const result = await describeTable(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "execute_query",
  "Execute a read-only SQL SELECT query. Only SELECT and WITH statements are allowed. Results are limited to prevent memory issues.",
  executeQuerySchema.shape,
  async (args) => {
    const result = await executeUserQuery(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "get_table_sample",
  "Get sample rows from a table. Useful for understanding data structure and content.",
  getTableSampleSchema.shape,
  async (args) => {
    const result = await getTableSample(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  // Validate configuration
  try {
    const config = getConfig();
    console.error(`SAP HANA MCP Server starting...`);
    console.error(`  Host: ${config.host}:${config.port}`);
    console.error(`  Schema restriction: ${config.schema || "none (all schemas)"}`);
    console.error(`  Row limit: ${config.rowLimit}`);
    console.error(`  Query timeout: ${config.queryTimeout}ms`);

    // Test connection on startup
    console.error("Testing HANA connection...");
    const connectionTest = await testConnection();
    if (!connectionTest.success) {
      console.error(`Connection test failed: ${connectionTest.message}`);
      console.error("Server will start but queries may fail until connection is available.");
    } else {
      console.error("Connection test successful.");
    }
  } catch (err) {
    console.error("Configuration error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Start MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("SAP HANA MCP Server running on stdio");
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.error("Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("Shutting down...");
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
