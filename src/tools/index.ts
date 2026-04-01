/**
 * MCP Tools for SAP HANA
 *
 * All tools for schema introspection and query execution.
 */

import { z } from "zod";
import { executeQuery, getEffectiveSchema, isSchemaAllowed, type QueryResult } from "../hana/client.js";
import { validateQuery, validateIdentifier, QueryValidationError } from "../security/query-validator.js";
import { queryRateLimiter } from "../security/rate-limiter.js";
import { formatAsTable, formatResult, formatCompactDescribe, formatAsCsv } from "./format.js";
import { writeToolOutput, writeQueryOutput } from "./output.js";
import { getConfig } from "../config.js";

// ============================================================================
// Tool Definitions (schemas for MCP registration)
// ============================================================================

export const listSchemasSchema = z.object({});

export const listTablesSchema = z.object({
  schema: z.string().optional().describe("Schema name. If not provided, uses configured default schema."),
});

export const listViewsSchema = z.object({
  schema: z.string().optional().describe("Schema name. If not provided, uses configured default schema."),
});

export const describeTableSchema = z.object({
  schema: z.string().optional().describe("Schema name. If not provided, uses configured default schema."),
  table: z.string().describe("Table or view name to describe."),
});

export const executeQuerySchema = z.object({
  query: z.string().describe("SELECT query to execute. Only read-only queries are allowed."),
});

export const getTableSampleSchema = z.object({
  schema: z.string().optional().describe("Schema name. If not provided, uses configured default schema."),
  table: z.string().describe("Table name to sample."),
  limit: z.number().min(1).max(100).default(5).describe("Number of rows to return (1-100, default 5)."),
});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * List all accessible schemas.
 * If HANA_SCHEMA is configured, only returns that schema.
 */
export async function listSchemas(): Promise<string> {
  queryRateLimiter.check();
  const configuredSchema = getEffectiveSchema();

  let sql: string;
  let params: unknown[] = [];

  if (configuredSchema) {
    sql = `
      SELECT SCHEMA_NAME, SCHEMA_OWNER
      FROM SYS.SCHEMAS
      WHERE SCHEMA_NAME = ?
      ORDER BY SCHEMA_NAME
    `;
    params = [configuredSchema];
  } else {
    sql = `
      SELECT SCHEMA_NAME, SCHEMA_OWNER
      FROM SYS.SCHEMAS
      WHERE HAS_PRIVILEGES = 'TRUE'
      ORDER BY SCHEMA_NAME
    `;
  }

  const result = await executeQuery(sql, params);
  return formatAsTable(result);
}

/**
 * List tables in a schema.
 */
export async function listTables(args: z.infer<typeof listTablesSchema>): Promise<string> {
  queryRateLimiter.check();
  const schema = resolveSchema(args.schema);
  validateSchemaAccess(schema);
  validateIdentifier(schema, "schema");

  const sql = `
    SELECT
      T.TABLE_NAME,
      T.TABLE_TYPE,
      M.RECORD_COUNT
    FROM SYS.TABLES T
    LEFT JOIN M_CS_TABLES M ON T.SCHEMA_NAME = M.SCHEMA_NAME AND T.TABLE_NAME = M.TABLE_NAME
    WHERE T.SCHEMA_NAME = ?
    ORDER BY T.TABLE_NAME
  `;

  const result = await executeQuery(sql, [schema]);
  return formatAsTable(result);
}

/**
 * List views in a schema.
 */
export async function listViews(args: z.infer<typeof listViewsSchema>): Promise<string> {
  queryRateLimiter.check();
  const schema = resolveSchema(args.schema);
  validateSchemaAccess(schema);
  validateIdentifier(schema, "schema");

  const sql = `
    SELECT
      VIEW_NAME,
      VIEW_TYPE
    FROM SYS.VIEWS
    WHERE SCHEMA_NAME = ?
    ORDER BY VIEW_NAME
  `;

  const result = await executeQuery(sql, [schema]);
  return formatAsTable(result);
}

/**
 * Describe a table or view — compact format with file output.
 * Returns a short summary inline and writes full column list to a file.
 */
export async function describeTable(args: z.infer<typeof describeTableSchema>): Promise<string> {
  queryRateLimiter.check();
  const schema = resolveSchema(args.schema);
  validateSchemaAccess(schema);
  validateIdentifier(schema, "schema");
  validateIdentifier(args.table, "table");

  const columnsResult = await executeQuery(`
    SELECT
      COLUMN_NAME,
      DATA_TYPE_NAME,
      LENGTH,
      SCALE,
      DEFAULT_VALUE
    FROM SYS.TABLE_COLUMNS
    WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
    ORDER BY POSITION
  `, [schema, args.table]);

  const pkResult = await executeQuery(`
    SELECT COLUMN_NAME
    FROM SYS.CONSTRAINTS
    WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? AND IS_PRIMARY_KEY = 'TRUE'
    ORDER BY POSITION
  `, [schema, args.table]);

  // SAP B1 doesn't define FKs at DB level — skip that query entirely

  const pkColumns = new Set(pkResult.rows.map((r) => String(r.COLUMN_NAME)));
  const { summary, fileContent } = formatCompactDescribe(
    columnsResult.rows,
    pkColumns,
    schema,
    args.table,
  );

  const filepath = writeToolOutput("describe", `${schema}_${args.table}`, fileContent);

  return `${summary}\n\nFull column list → ${filepath}\nUse Read or Grep on the file to find specific columns.`;
}

/**
 * Execute a read-only SQL query.
 * Small results return inline; large results go to a CSV file.
 */
export async function executeUserQuery(args: z.infer<typeof executeQuerySchema>): Promise<string> {
  queryRateLimiter.check();

  try {
    validateQuery(args.query);
  } catch (err) {
    if (err instanceof QueryValidationError) {
      return `**Query validation failed:** ${err.message}`;
    }
    throw err;
  }

  try {
    const result = await executeQuery(args.query);

    // Small results: return inline (no file needed)
    if (result.rowCount <= 20 && result.columns.length <= 10) {
      const inline = formatResult(result);
      const suffix = result.truncated ? " (truncated)" : "";
      return `${result.rowCount} rows${suffix}.\n\n${inline}`;
    }

    // Large results: write CSV to file, show first 5 rows inline
    const csv = formatAsCsv(result);
    const filepath = writeQueryOutput(args.query, csv);

    const preview = {
      ...result,
      rows: result.rows.slice(0, 5),
      rowCount: Math.min(5, result.rowCount),
    };
    const previewText = formatResult(preview);
    const truncNote = result.truncated ? " (query row limit reached)" : "";

    return [
      `${result.rowCount} rows, ${result.columns.length} columns${truncNote}.`,
      "",
      previewText,
      result.rowCount > 5 ? `... ${result.rowCount - 5} more rows` : "",
      "",
      `Full results → ${filepath}`,
    ].filter(Boolean).join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return `**Query failed:** ${message}`;
  }
}

/**
 * Get sample data from a table.
 * Writes full data to CSV file, returns summary inline.
 */
export async function getTableSample(args: z.infer<typeof getTableSampleSchema>): Promise<string> {
  queryRateLimiter.check();
  const schema = resolveSchema(args.schema);
  validateSchemaAccess(schema);
  validateIdentifier(schema, "schema");
  validateIdentifier(args.table, "table");

  const limit = Math.min(args.limit || 5, 100);

  try {
    // Get total row count for context
    const countResult = await executeQuery(
      `SELECT COUNT(*) AS CNT FROM "${schema}"."${args.table}"`,
    );
    const totalRows = Number(countResult.rows[0]?.CNT ?? 0);

    const sql = `SELECT TOP ${Number(limit)} * FROM "${schema}"."${args.table}"`;
    const result = await executeQuery(sql);

    // Count non-empty columns
    const nonEmptyCols = result.columns.filter((col) =>
      result.rows.some((row) => row[col] != null && String(row[col]).trim() !== "")
    );

    // Write CSV to file
    const csv = formatAsCsv(result);
    const filepath = writeToolOutput("sample", `${schema}_${args.table}`, csv, "csv");

    return [
      `${schema}.${args.table} — ${result.rowCount} sample rows (of ${totalRows.toLocaleString()} total), ${nonEmptyCols.length} non-empty columns (${result.columns.length} total)`,
      "",
      `Data → ${filepath}`,
      `Use Read or Grep on the file to inspect specific columns.`,
    ].join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return `**Failed to sample ${schema}.${args.table}:** ${message}`;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolves the schema to use - either from args or from config.
 */
function resolveSchema(schema?: string): string {
  if (schema) return schema;

  const configuredSchema = getEffectiveSchema();
  if (configuredSchema) return configuredSchema;

  throw new Error(
    "No schema specified and no default schema configured. " +
    "Either provide a schema parameter or set HANA_SCHEMA environment variable."
  );
}

/**
 * Validates that the schema is allowed based on configuration.
 */
function validateSchemaAccess(schema: string): void {
  if (!isSchemaAllowed(schema)) {
    const configuredSchema = getEffectiveSchema();
    throw new Error(
      `Access to schema "${schema}" is not allowed. ` +
      `Server is restricted to schema: ${configuredSchema}`
    );
  }
}
