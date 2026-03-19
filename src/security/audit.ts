/**
 * Query Audit Logger
 *
 * Logs every query execution to stderr (visible in MCP server logs).
 * Essential when developing against production.
 */

interface AuditEntry {
  query: string;
  rowCount?: number;
  truncated?: boolean;
  error?: string;
  durationMs: number;
}

export function auditLog(entry: AuditEntry): void {
  const timestamp = new Date().toISOString();
  const status = entry.error ? "ERROR" : "OK";
  const rows = entry.rowCount !== undefined ? ` rows=${entry.rowCount}` : "";
  const truncated = entry.truncated ? " [TRUNCATED]" : "";
  const error = entry.error ? ` err="${entry.error}"` : "";

  // Single-line format for easy grep/tail
  console.error(
    `[AUDIT] ${timestamp} ${status} ${entry.durationMs}ms${rows}${truncated}${error} | ${entry.query.replace(/\n/g, " ").slice(0, 500)}`
  );
}
