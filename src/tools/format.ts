/**
 * Result formatting for LLM consumption.
 *
 * HANA queries return verbose JSON with lots of nulls and redundant metadata.
 * This module formats results into compact, readable output that's easier
 * for LLMs to parse without burning context window.
 */

import type { QueryResult } from "../hana/client.js";

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
