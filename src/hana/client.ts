/**
 * SAP HANA Connection Management
 *
 * Uses connection-per-request pattern for safety:
 * - Each query gets a fresh connection
 * - Connection is closed after query completes
 * - Prevents session state persistence attacks
 */

import hana from "@sap/hana-client";
import { getConfig, type HanaConfig } from "../config.js";

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

/**
 * Creates connection parameters for @sap/hana-client
 */
function getConnectionParams(config: HanaConfig): hana.ConnectionOptions {
  return {
    host: config.host,
    port: config.port,
    uid: config.user,
    pwd: config.password,
    encrypt: config.encrypt,
    sslValidateCertificate: config.sslValidateCertificate,
    connectTimeout: config.connectionTimeout,
    // Set current schema if configured
    ...(config.schema ? { currentSchema: config.schema } : {}),
  };
}

/**
 * Creates a new connection to SAP HANA.
 * Caller is responsible for closing the connection.
 */
export function createConnection(): Promise<hana.Connection> {
  const config = getConfig();
  const params = getConnectionParams(config);

  return new Promise((resolve, reject) => {
    const conn = hana.createConnection();

    conn.connect(params, (err) => {
      if (err) {
        reject(new Error(`Failed to connect to HANA: ${err.message}`));
      } else {
        resolve(conn);
      }
    });
  });
}

/**
 * Closes a connection safely.
 */
export function closeConnection(conn: hana.Connection): Promise<void> {
  return new Promise((resolve) => {
    try {
      conn.disconnect((err) => {
        if (err) {
          console.error("Error closing connection:", err.message);
        }
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/**
 * Executes a query with timeout and row limiting.
 * Creates a new connection, executes, then closes - ensuring connection recycling.
 */
export async function executeQuery(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult> {
  const config = getConfig();
  const conn = await createConnection();

  try {
    // Set query timeout via session variable
    await execStatement(conn, `SET 'statement_timeout' = '${config.queryTimeout}'`);

    // Execute the query
    const result = await execQuery(conn, sql, params);

    // Process results
    const columns = result.length > 0 ? Object.keys(result[0]) : [];
    const truncated = result.length >= config.rowLimit;

    // Apply row limit
    const limitedRows = result.slice(0, config.rowLimit);

    return {
      columns,
      rows: limitedRows,
      rowCount: limitedRows.length,
      truncated,
    };
  } finally {
    // Always close connection - connection recycling for security
    await closeConnection(conn);
  }
}

/**
 * Executes a query and returns results.
 */
function execQuery(
  conn: hana.Connection,
  sql: string,
  params: unknown[]
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    conn.exec(sql, params, (err, result) => {
      if (err) {
        reject(new Error(`Query execution failed: ${err.message}`));
      } else {
        // Ensure result is an array
        const rows = Array.isArray(result) ? result : [];
        resolve(rows as Record<string, unknown>[]);
      }
    });
  });
}

/**
 * Executes a statement without returning results (for SET commands etc.)
 */
function execStatement(conn: hana.Connection, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.exec(sql, (err) => {
      if (err) {
        // Don't fail on SET errors - some HANA versions may not support all settings
        console.error(`Statement warning: ${err.message}`);
        resolve();
      } else {
        resolve();
      }
    });
  });
}

/**
 * Tests the connection to HANA.
 */
export async function testConnection(): Promise<{ success: boolean; message: string }> {
  try {
    const conn = await createConnection();
    const result = await execQuery(conn, "SELECT 'OK' AS status FROM DUMMY", []);
    await closeConnection(conn);

    if (result.length > 0 && result[0].STATUS === "OK") {
      return { success: true, message: "Connection successful" };
    }
    return { success: false, message: "Unexpected response from HANA" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, message };
  }
}

/**
 * Gets the effective schema - either from config or the connection default.
 */
export function getEffectiveSchema(): string | undefined {
  return getConfig().schema;
}

/**
 * Validates that a schema is accessible (either matches config or config allows all).
 */
export function isSchemaAllowed(schema: string): boolean {
  const configuredSchema = getConfig().schema;
  // If no schema configured, all schemas are allowed
  if (!configuredSchema) return true;
  // Otherwise, must match the configured schema
  return schema.toUpperCase() === configuredSchema.toUpperCase();
}
