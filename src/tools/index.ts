/**
 * MCP Tools for SAP HANA
 *
 * All tools for schema introspection and query execution.
 */

import { z } from "zod";
import { executeQuery, getEffectiveSchema, isSchemaAllowed } from "../hana/client.js";
import { validateQuery, validateIdentifier, QueryValidationError } from "../security/query-validator.js";
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
  limit: z.number().min(1).max(100).default(10).describe("Number of rows to return (1-100, default 10)."),
});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * List all accessible schemas.
 * If HANA_SCHEMA is configured, only returns that schema.
 */
export async function listSchemas(): Promise<string> {
  const configuredSchema = getEffectiveSchema();

  let sql: string;
  let params: unknown[] = [];

  if (configuredSchema) {
    // If schema is configured, only show that schema
    sql = `
      SELECT SCHEMA_NAME, SCHEMA_OWNER
      FROM SYS.SCHEMAS
      WHERE SCHEMA_NAME = ?
      ORDER BY SCHEMA_NAME
    `;
    params = [configuredSchema];
  } else {
    // Show all schemas the user has privileges on
    sql = `
      SELECT SCHEMA_NAME, SCHEMA_OWNER
      FROM SYS.SCHEMAS
      WHERE HAS_PRIVILEGES = 'TRUE'
      ORDER BY SCHEMA_NAME
    `;
  }

  const result = await executeQuery(sql, params);

  return JSON.stringify({
    schemas: result.rows,
    count: result.rowCount,
    restricted: !!configuredSchema,
  }, null, 2);
}

/**
 * List tables in a schema.
 */
export async function listTables(args: z.infer<typeof listTablesSchema>): Promise<string> {
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

  return JSON.stringify({
    schema,
    tables: result.rows,
    count: result.rowCount,
    truncated: result.truncated,
  }, null, 2);
}

/**
 * List views in a schema.
 */
export async function listViews(args: z.infer<typeof listViewsSchema>): Promise<string> {
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

  return JSON.stringify({
    schema,
    views: result.rows,
    count: result.rowCount,
    truncated: result.truncated,
  }, null, 2);
}

/**
 * Describe a table or view (columns, indexes, constraints).
 */
export async function describeTable(args: z.infer<typeof describeTableSchema>): Promise<string> {
  const schema = resolveSchema(args.schema);
  validateSchemaAccess(schema);
  validateIdentifier(schema, "schema");
  validateIdentifier(args.table, "table");

  // Get columns
  const columnsResult = await executeQuery(`
    SELECT
      COLUMN_NAME,
      DATA_TYPE_NAME,
      LENGTH,
      SCALE,
      IS_NULLABLE,
      DEFAULT_VALUE,
      POSITION,
      COMMENTS
    FROM SYS.TABLE_COLUMNS
    WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
    ORDER BY POSITION
  `, [schema, args.table]);

  // Get primary key columns
  const pkResult = await executeQuery(`
    SELECT COLUMN_NAME, POSITION
    FROM SYS.CONSTRAINTS
    WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? AND IS_PRIMARY_KEY = 'TRUE'
    ORDER BY POSITION
  `, [schema, args.table]);

  // Get indexes
  const indexResult = await executeQuery(`
    SELECT INDEX_NAME, INDEX_TYPE, CONSTRAINT
    FROM SYS.INDEXES
    WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
  `, [schema, args.table]);

  // Get foreign keys
  const fkResult = await executeQuery(`
    SELECT
      CONSTRAINT_NAME,
      COLUMN_NAME,
      REFERENCED_SCHEMA_NAME,
      REFERENCED_TABLE_NAME,
      REFERENCED_COLUMN_NAME
    FROM SYS.REFERENTIAL_CONSTRAINTS
    WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
  `, [schema, args.table]);

  return JSON.stringify({
    schema,
    table: args.table,
    columns: columnsResult.rows,
    primaryKey: pkResult.rows,
    indexes: indexResult.rows,
    foreignKeys: fkResult.rows,
  }, null, 2);
}

/**
 * Execute a read-only SQL query.
 */
export async function executeUserQuery(args: z.infer<typeof executeQuerySchema>): Promise<string> {
  // Validate query is read-only
  try {
    validateQuery(args.query);
  } catch (err) {
    if (err instanceof QueryValidationError) {
      return JSON.stringify({
        error: "Query validation failed",
        message: err.message,
      }, null, 2);
    }
    throw err;
  }

  const config = getConfig();

  try {
    const result = await executeQuery(args.query);

    return JSON.stringify({
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      rowLimit: config.rowLimit,
    }, null, 2);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return JSON.stringify({
      error: "Query execution failed",
      message,
    }, null, 2);
  }
}

/**
 * Get sample data from a table.
 */
export async function getTableSample(args: z.infer<typeof getTableSampleSchema>): Promise<string> {
  const schema = resolveSchema(args.schema);
  validateSchemaAccess(schema);
  validateIdentifier(schema, "schema");
  validateIdentifier(args.table, "table");

  const limit = args.limit || 10;

  // Use TOP for HANA (not LIMIT)
  const sql = `SELECT TOP ${limit} * FROM "${schema}"."${args.table}"`;

  try {
    const result = await executeQuery(sql);

    return JSON.stringify({
      schema,
      table: args.table,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
    }, null, 2);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return JSON.stringify({
      error: "Failed to get table sample",
      message,
      schema,
      table: args.table,
    }, null, 2);
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
