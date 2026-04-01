/**
 * Result formatting for LLM consumption.
 *
 * HANA queries return verbose JSON with lots of nulls and redundant metadata.
 * This module formats results into compact, readable output that's easier
 * for LLMs to parse without burning context window.
 */

import type { QueryResult } from "../hana/client.js";

// ============================================================================
// SAP column classification
// ============================================================================

/** SAP audit/system columns that provide no value for query building */
const SAP_AUDIT_COLUMNS = new Set([
  "CREATEDATE", "CREATETIME", "UPDATEDATE", "UPDATETIME",
  "CREATETS", "UPDATETS",
  "USERSIGN", "USERSIGN2",
  "LOGINSTANC", "OBJTYPE", "INSTANCE",
  "TRANSFERED", "EXPORTED", "DATASOURCE",
  "ATCENTRY", "ATTACHMENT",
  "DRAFTKEY", "FILLER", "STATIONID",
  "DATAVERS", "FLAGS", "SEGMENT",
  "FINNCPRIOD",
]);

/** Currency suffixes in SAP B1 (foreign currency, system currency) */
const CURRENCY_SUFFIXES = ["FC", "SY", "SC"];

/**
 * Formats a query result as a compact markdown table.
 * Strips null/empty columns, truncates long values.
 */
export function formatAsTable(result: QueryResult, opts?: { maxColWidth?: number }): string {
  const maxColWidth = opts?.maxColWidth ?? 60;

  if (result.rows.length === 0) {
    return "No results.";
  }

  // Drop columns that are ALL null/empty across every row
  const activeColumns = result.columns.filter((col) =>
    result.rows.some((row) => row[col] != null && String(row[col]).trim() !== "")
  );

  if (activeColumns.length === 0) {
    return `${result.rowCount} rows, all values null.`;
  }

  // Build markdown table
  const header = "| " + activeColumns.join(" | ") + " |";
  const separator = "| " + activeColumns.map(() => "---").join(" | ") + " |";
  const rows = result.rows.map((row) => {
    const cells = activeColumns.map((col) => {
      const val = row[col];
      if (val == null) return "";
      let str = String(val);
      // Truncate long cell values
      if (str.length > maxColWidth) {
        str = str.slice(0, maxColWidth - 3) + "...";
      }
      // Escape pipes for markdown table
      str = str.replace(/\|/g, "\\|");
      // Replace newlines
      str = str.replace(/\n/g, " ");
      return str;
    });
    return "| " + cells.join(" | ") + " |";
  });

  const parts = [header, separator, ...rows];

  if (result.truncated) {
    parts.push(`\n*Showing ${result.rowCount} rows (truncated)*`);
  }

  return parts.join("\n");
}

/**
 * Formats a compact JSON result — strips nulls from each row.
 */
export function formatCompactJson(result: QueryResult): string {
  const cleanRows = result.rows.map((row) => {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(row)) {
      if (val != null && String(val).trim() !== "") {
        clean[key] = val;
      }
    }
    return clean;
  });

  return JSON.stringify({
    rows: cleanRows,
    count: result.rowCount,
    ...(result.truncated ? { truncated: true } : {}),
  }, null, 2);
}

/**
 * Picks the best format based on result shape.
 * Tables for small/medium results, compact JSON for wide/complex data.
 */
export function formatResult(result: QueryResult): string {
  // Use markdown table if columns <= 8 and rows <= 100 (readable)
  if (result.columns.length <= 8 && result.rowCount <= 100) {
    return formatAsTable(result);
  }
  // Otherwise compact JSON (wide tables don't render well in markdown)
  return formatCompactJson(result);
}

// ============================================================================
// Compact describe_table formatting
// ============================================================================

/** How many columns to show inline in the agent's context */
const INLINE_COLUMN_LIMIT = 20;

/**
 * Formats describe_table output into compact notation.
 * Returns a short inline summary (for context) and full file content.
 *
 * Optimizations applied:
 * - Audit/system columns stripped
 * - QryGroup1..64 collapsed to one line
 * - Currency variants (FC/Sy/SC) collapsed with [+FC,Sy] notation
 * - One line per column: Name TYPE(len) PK default=X [+FC,Sy]
 */
export function formatCompactDescribe(
  rows: Record<string, unknown>[],
  pkColumns: Set<string>,
  schema: string,
  table: string,
): { summary: string; fileContent: string } {
  const totalCount = rows.length;

  // 1. Separate audit columns
  const auditCols: string[] = [];
  const nonAuditRows: Record<string, unknown>[] = [];
  for (const row of rows) {
    const name = String(row.COLUMN_NAME);
    if (SAP_AUDIT_COLUMNS.has(name.toUpperCase())) {
      auditCols.push(name);
    } else {
      nonAuditRows.push(row);
    }
  }

  // 2. Collapse QryGroup columns
  const qryGroupRows = nonAuditRows.filter(r => /^QryGroup\d+$/i.test(String(r.COLUMN_NAME)));
  const mainRows = nonAuditRows.filter(r => !/^QryGroup\d+$/i.test(String(r.COLUMN_NAME)));
  let qryGroupLine: string | null = null;
  if (qryGroupRows.length > 1) {
    const nums = qryGroupRows.map(r => parseInt(String(r.COLUMN_NAME).replace(/\D/g, "")));
    qryGroupLine = `QryGroup${Math.min(...nums)}..${Math.max(...nums)} NVARCHAR(1) default=N (${qryGroupRows.length} boolean flags)`;
  } else if (qryGroupRows.length === 1) {
    mainRows.push(qryGroupRows[0]);
  }

  // 3. Identify currency variants to collapse
  const colNameSet = new Set(mainRows.map(r => String(r.COLUMN_NAME).toUpperCase()));
  const variantAnnotations = new Map<string, string[]>(); // base UPPER → suffixes
  const skipCols = new Set<string>(); // UPPER names of variant columns to skip

  for (const row of mainRows) {
    const name = String(row.COLUMN_NAME);
    const upper = name.toUpperCase();
    for (const suffix of CURRENCY_SUFFIXES) {
      if (upper.length > suffix.length && upper.endsWith(suffix)) {
        const baseUpper = upper.slice(0, -suffix.length);
        if (colNameSet.has(baseUpper)) {
          if (!variantAnnotations.has(baseUpper)) variantAnnotations.set(baseUpper, []);
          variantAnnotations.get(baseUpper)!.push(suffix);
          skipCols.add(upper);
          break;
        }
      }
    }
  }

  // 4. Build compact lines
  const lines: string[] = [];
  for (const row of mainRows) {
    const name = String(row.COLUMN_NAME);
    if (skipCols.has(name.toUpperCase())) continue;

    const dataType = String(row.DATA_TYPE_NAME);
    const length = row.LENGTH != null ? Number(row.LENGTH) : null;
    const scale = row.SCALE != null ? Number(row.SCALE) : null;
    const defaultVal = row.DEFAULT_VALUE != null ? String(row.DEFAULT_VALUE).trim() : null;

    let line = name + " " + formatDataType(dataType, length, scale);
    if (pkColumns.has(name)) line += " PK";
    if (defaultVal) line += ` default=${defaultVal}`;

    const variants = variantAnnotations.get(name.toUpperCase());
    if (variants) line += ` [+${variants.join(",")}]`;

    lines.push(line);
  }

  if (qryGroupLine) lines.push(qryGroupLine);

  // 5. Build file content
  const pkStr = pkColumns.size > 0 ? [...pkColumns].join(", ") : "none";
  const fileParts: string[] = [
    `${schema}.${table} — ${totalCount} columns, PK: ${pkStr}`,
    "",
    lines.join("\n"),
  ];
  if (auditCols.length > 0) {
    fileParts.push("", `-- ${auditCols.length} audit/system columns hidden: ${auditCols.join(", ")}`);
  }
  const fileContent = fileParts.join("\n");

  // 6. Build inline summary
  const visibleLines = lines.slice(0, INLINE_COLUMN_LIMIT);
  const notes: string[] = [];
  if (auditCols.length > 0) notes.push(`${auditCols.length} audit cols hidden`);
  if (qryGroupLine) notes.push("QryGroup collapsed");
  if (skipCols.size > 0) notes.push(`${skipCols.size} currency variants collapsed`);

  const summaryParts: string[] = [
    `${schema}.${table} — ${totalCount} columns, PK: ${pkStr}`,
  ];
  if (notes.length > 0) summaryParts[0] += ` (${notes.join(", ")})`;
  summaryParts.push("");
  summaryParts.push(visibleLines.join("\n"));
  if (lines.length > INLINE_COLUMN_LIMIT) {
    summaryParts.push(`... and ${lines.length - INLINE_COLUMN_LIMIT} more`);
  }

  return { summary: summaryParts.join("\n"), fileContent };
}

function formatDataType(type: string, length: number | null, scale: number | null): string {
  const noLengthTypes = new Set([
    "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "DATE", "TIME",
    "TIMESTAMP", "SECONDDATE", "DOUBLE", "REAL", "BOOLEAN",
    "NCLOB", "CLOB", "BLOB", "TEXT",
  ]);
  if (noLengthTypes.has(type)) return type;
  if ((type === "DECIMAL" || type === "NUMERIC") && length != null) {
    return scale ? `${type}(${length},${scale})` : `${type}(${length})`;
  }
  if (length != null && length < 2147483647) return `${type}(${length})`;
  return type;
}

// ============================================================================
// CSV formatting
// ============================================================================

/**
 * Formats query results as CSV. Strips all-null columns by default.
 */
export function formatAsCsv(result: QueryResult, stripNullCols: boolean = true): string {
  let columns = result.columns;
  if (stripNullCols) {
    columns = columns.filter((col) =>
      result.rows.some((row) => row[col] != null && String(row[col]).trim() !== "")
    );
  }
  const header = columns.map(escapeCsv).join(",");
  const rows = result.rows.map((row) =>
    columns.map((col) => escapeCsv(row[col])).join(",")
  );
  return [header, ...rows].join("\n");
}

function escapeCsv(val: unknown): string {
  if (val == null) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
