/**
 * MCP Tool definitions for SAP Broker.
 *
 * Exports a TOOL_DEFINITIONS array consumed by the tool registry.
 * Each tool declares its name, description, input schema, and handler.
 * The registry decides which tools to register based on caller scopes.
 */

import { z } from "zod";
import { SAP_WRITE_TOOLS } from "../sap/tools.js";
import { executeQuery, getEffectiveSchema, isSchemaAllowed, type QueryResult } from "../hana/client.js";
import { validateQuery, validateIdentifier, QueryValidationError } from "../security/query-validator.js";
import { queryRateLimiter } from "../security/rate-limiter.js";
import { formatAsTable, formatResult, formatCompactDescribe, formatAsCsv } from "./format.js";
import { writeToolOutput, writeQueryOutput } from "./output.js";
import { getConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Tool definition type
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (args: any) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listSchemasSchema = z.object({});

const listTablesSchema = z.object({
  schema: z.string().optional().describe("Schema name. If not provided, uses configured default schema."),
});

const listViewsSchema = z.object({
  schema: z.string().optional().describe("Schema name. If not provided, uses configured default schema."),
});

const describeTableSchema = z.object({
  schema: z.string().optional().describe("Schema name. If not provided, uses configured default schema."),
  table: z.string().describe("Table or view name to describe."),
});

const executeQuerySchema = z.object({
  query: z.string().describe("SELECT query to execute. Only read-only queries are allowed."),
});

const getTableSampleSchema = z.object({
  schema: z.string().optional().describe("Schema name. If not provided, uses configured default schema."),
  table: z.string().describe("Table name to sample."),
  limit: z.number().min(1).max(100).default(5).describe("Number of rows to return (1-100, default 5)."),
});

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function listSchemas(): Promise<string> {
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

async function listTables(args: z.infer<typeof listTablesSchema>): Promise<string> {
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

async function listViews(args: z.infer<typeof listViewsSchema>): Promise<string> {
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

async function describeTable(args: z.infer<typeof describeTableSchema>): Promise<string> {
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

  const pkColumns = new Set(pkResult.rows.map((r) => String(r.COLUMN_NAME)));
  const { summary, fileContent } = formatCompactDescribe(
    columnsResult.rows,
    pkColumns,
    schema,
    args.table,
  );

  const filepath = writeToolOutput("describe", `${schema}_${args.table}`, fileContent);

  return `${summary}\n\nFull column list -> ${filepath}\nUse Read or Grep on the file to find specific columns.`;
}

async function executeUserQuery(args: z.infer<typeof executeQuerySchema>): Promise<string> {
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

    if (result.rowCount <= 20 && result.columns.length <= 10) {
      const inline = formatResult(result);
      const suffix = result.truncated ? " (truncated)" : "";
      return `${result.rowCount} rows${suffix}.\n\n${inline}`;
    }

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
      `Full results -> ${filepath}`,
    ].filter(Boolean).join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return `**Query failed:** ${message}`;
  }
}

async function getTableSample(args: z.infer<typeof getTableSampleSchema>): Promise<string> {
  queryRateLimiter.check();
  const schema = resolveSchema(args.schema);
  validateSchemaAccess(schema);
  validateIdentifier(schema, "schema");
  validateIdentifier(args.table, "table");

  const limit = Math.min(args.limit || 5, 100);

  try {
    const countResult = await executeQuery(
      `SELECT COUNT(*) AS CNT FROM "${schema}"."${args.table}"`,
    );
    const totalRows = Number(countResult.rows[0]?.CNT ?? 0);

    const sql = `SELECT TOP ${Number(limit)} * FROM "${schema}"."${args.table}"`;
    const result = await executeQuery(sql);

    const nonEmptyCols = result.columns.filter((col) =>
      result.rows.some((row) => row[col] != null && String(row[col]).trim() !== "")
    );

    const csv = formatAsCsv(result);
    const filepath = writeToolOutput("sample", `${schema}_${args.table}`, csv, "csv");

    return [
      `${schema}.${args.table} -- ${result.rowCount} sample rows (of ${totalRows.toLocaleString()} total), ${nonEmptyCols.length} non-empty columns (${result.columns.length} total)`,
      "",
      `Data -> ${filepath}`,
      `Use Read or Grep on the file to inspect specific columns.`,
    ].join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return `**Failed to sample ${schema}.${args.table}:** ${message}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSchema(schema?: string): string {
  if (schema) return schema;

  const configuredSchema = getEffectiveSchema();
  if (configuredSchema) return configuredSchema;

  throw new Error(
    "No schema specified and no default schema configured. " +
    "Either provide a schema parameter or set HANA_SCHEMA environment variable."
  );
}

function validateSchemaAccess(schema: string): void {
  if (!isSchemaAllowed(schema)) {
    const configuredSchema = getEffectiveSchema();
    throw new Error(
      `Access to schema "${schema}" is not allowed. ` +
      `Server is restricted to schema: ${configuredSchema}`
    );
  }
}

// ---------------------------------------------------------------------------
// Registry export
// ---------------------------------------------------------------------------

export const HANA_READ_TOOLS: ToolDefinition[] = [
  {
    name: "list_schemas",
    description: "List all accessible database schemas. If HANA_SCHEMA is configured, only shows that schema.",
    inputSchema: listSchemasSchema,
    handler: listSchemas,
  },
  {
    name: "list_tables",
    description: "List all tables in a schema with their types and record counts.",
    inputSchema: listTablesSchema,
    handler: listTables,
  },
  {
    name: "list_views",
    description: "List all views in a schema.",
    inputSchema: listViewsSchema,
    handler: listViews,
  },
  {
    name: "describe_table",
    description: "Get table schema in compact notation. Returns a summary inline and writes full column list to a file. Use Read or Grep on the file path to find specific columns.",
    inputSchema: describeTableSchema,
    handler: describeTable,
  },
  {
    name: "execute_query",
    description: "Execute a read-only SQL SELECT query. Only SELECT and WITH statements are allowed. Small results return inline; large results are written to a CSV file with a preview shown inline.",
    inputSchema: executeQuerySchema,
    handler: executeUserQuery,
  },
  {
    name: "get_table_sample",
    description: "Get sample rows from a table written to a CSV file. Returns a summary inline with the file path. Use Read or Grep on the file to inspect specific columns.",
    inputSchema: getTableSampleSchema,
    handler: getTableSample,
  },
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...HANA_READ_TOOLS,
  ...SAP_WRITE_TOOLS,
];
