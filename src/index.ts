#!/usr/bin/env node

/**
 * SAP Broker MCP Server
 *
 * Authenticated, scope-aware MCP server for SAP HANA reads and SAP Service Layer writes.
 *
 * Transport modes:
 *   - stdio  (default) — dev mode, all tools, no auth
 *   - http   — production mode, bearer token auth, scope-filtered tools
 *
 * Set BROKER_TRANSPORT=http to run as an HTTP service.
 */

import { getConfig, loadServerConfig, loadSAPConfig } from "./config.js";
import { loadBrokerConfig } from "./auth/config.js";
import { testConnection } from "./hana/client.js";
import { createSAPClient } from "./sap/client.js";
import { setSAPClient } from "./sap/tools.js";
import { initOutputDir, getOutputDir } from "./tools/output.js";
import { startStdioServer } from "./server/stdio.js";
import { createHttpApp } from "./server/http.js";

async function main() {
  // Load HANA config (always required)
  const hanaConfig = getConfig();
  const serverConfig = loadServerConfig();

  // Initialize output directory
  initOutputDir();

  console.error("SAP Broker MCP starting...");
  console.error(`  Transport: ${serverConfig.transport}`);
  console.error(`  HANA host: ${hanaConfig.host}:${hanaConfig.port}`);
  console.error(`  Schema restriction: ${hanaConfig.schema || "none (all schemas)"}`);
  console.error(`  Row limit: ${hanaConfig.rowLimit}`);
  console.error(`  Query timeout: ${hanaConfig.queryTimeout}ms`);
  console.error(`  Output directory: ${getOutputDir()}`);

  // Initialize SAP Service Layer client (optional — write tools need it)
  const sapConfig = loadSAPConfig();
  if (sapConfig) {
    const sapClient = createSAPClient(sapConfig);
    setSAPClient(sapClient);
    console.error(`  SAP Service Layer: ${sapConfig.baseUrl} (${sapConfig.companyDb})`);
  } else {
    console.error("  SAP Service Layer: not configured (write tools unavailable)");
  }

  // Test HANA connection
  console.error("Testing HANA connection...");
  const connectionTest = await testConnection();
  if (!connectionTest.success) {
    console.error(`Connection test failed: ${connectionTest.message}`);
    console.error("Server will start but queries may fail until connection is available.");
  } else {
    console.error("Connection test successful.");
  }

  // Start the appropriate transport
  if (serverConfig.transport === "stdio") {
    await startStdioServer();
  } else {
    // HTTP mode — load broker config for auth + scoping
    const brokerConfig = loadBrokerConfig(
      serverConfig.brokerConfigPath || undefined,
    );
    console.error(`  Broker config loaded: ${Object.keys(brokerConfig.profiles).length} profiles, ${brokerConfig.tokens.length} tokens`);

    const app = createHttpApp(brokerConfig);
    app.listen(serverConfig.httpPort, serverConfig.httpHost, () => {
      console.error(`SAP Broker MCP listening on http://${serverConfig.httpHost}:${serverConfig.httpPort}/mcp`);
    });
  }
}

// Graceful shutdown
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
