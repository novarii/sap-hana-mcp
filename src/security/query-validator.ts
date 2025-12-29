/**
 * SQL Query Validator
 *
 * Enforces read-only access by blocking dangerous SQL keywords and patterns.
 * This is the first line of defense - database-level permissions should also be configured.
 */

// Keywords that indicate write/modify operations
const BLOCKED_KEYWORDS = [
  // Data modification
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "REPLACE",

  // Schema modification
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",

  // Permission modification
  "GRANT",
  "REVOKE",

  // Stored procedure execution
  "CALL",
  "EXEC",
  "EXECUTE",

  // Transaction control (prevent injection attacks)
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",

  // Session modification
  "SET",

  // Import/Export
  "IMPORT",
  "EXPORT",
  "LOAD",
  "UNLOAD",
] as const;

// Queries must start with one of these (case-insensitive)
const ALLOWED_PREFIXES = ["SELECT", "WITH", "EXPLAIN"] as const;

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

/**
 * Validates that a SQL query is read-only and safe to execute.
 * Throws QueryValidationError if validation fails.
 */
export function validateQuery(sql: string): void {
  if (!sql || typeof sql !== "string") {
    throw new QueryValidationError("Query must be a non-empty string");
  }

  const trimmed = sql.trim();
  if (!trimmed) {
    throw new QueryValidationError("Query cannot be empty");
  }

  const normalized = trimmed.toUpperCase();

  // Check that query starts with an allowed prefix
  const hasAllowedPrefix = ALLOWED_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix)
  );
  if (!hasAllowedPrefix) {
    throw new QueryValidationError(
      `Query must start with one of: ${ALLOWED_PREFIXES.join(", ")}`
    );
  }

  // Check for blocked keywords using word boundaries
  for (const keyword of BLOCKED_KEYWORDS) {
    // \b ensures we match whole words only (e.g., "SET" won't match "OFFSET")
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(sql)) {
      throw new QueryValidationError(`Blocked keyword detected: ${keyword}`);
    }
  }

  // Check for multiple statements (semicolon followed by non-whitespace)
  // This prevents injection attacks like: SELECT 1; DROP TABLE users;
  const multiStatementPattern = /;\s*\S/;
  if (multiStatementPattern.test(trimmed)) {
    throw new QueryValidationError(
      "Multiple statements are not allowed. Remove any semicolons followed by additional statements."
    );
  }

  // Check for comment-based injection attempts
  // Block queries that use comments to hide malicious code
  const suspiciousCommentPattern = /--.*\b(DROP|DELETE|INSERT|UPDATE|CREATE|ALTER)\b/i;
  if (suspiciousCommentPattern.test(sql)) {
    throw new QueryValidationError(
      "Suspicious comment pattern detected"
    );
  }
}

/**
 * Validates a schema name to prevent SQL injection.
 * Schema names should only contain alphanumeric characters, underscores, and dots.
 */
export function validateIdentifier(identifier: string, type: string = "identifier"): void {
  if (!identifier || typeof identifier !== "string") {
    throw new QueryValidationError(`${type} must be a non-empty string`);
  }

  // Allow alphanumeric, underscore, and some special chars common in HANA
  // Must start with a letter or underscore
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_#$]*$/;

  if (!validPattern.test(identifier)) {
    throw new QueryValidationError(
      `Invalid ${type}: "${identifier}". Must start with a letter or underscore and contain only alphanumeric characters, underscores, #, or $.`
    );
  }

  // Additional length check
  if (identifier.length > 128) {
    throw new QueryValidationError(
      `${type} too long: maximum 128 characters allowed`
    );
  }
}

/**
 * Escapes a string for safe use in SQL.
 * Use parameterized queries when possible instead.
 */
export function escapeString(value: string): string {
  return value.replace(/'/g, "''");
}
