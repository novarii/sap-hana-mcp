/**
 * Output file management for MCP tool results.
 *
 * Instead of dumping large results into the agent's context window,
 * tools write detailed output to files and return a compact summary
 * with the file path. The agent can then Read or Grep the file as needed.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";

/**
 * Returns the output directory path from config.
 */
export function getOutputDir(): string {
  return getConfig().outputDir;
}

/**
 * Initializes the output directory on server startup.
 * Wipes any stale files from previous sessions and ensures the dir exists.
 */
export function initOutputDir(): void {
  const dir = getOutputDir();
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, file));
      } catch {
        // Ignore cleanup errors for files in use
      }
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }
}

function formatTimestamp(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * Writes tool output to a file and returns the full path.
 * Used by describe_table and get_table_sample (deterministic names).
 */
export function writeToolOutput(
  prefix: string,
  name: string,
  content: string,
  ext: string = "txt",
): string {
  const dir = getOutputDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filename = `${prefix}_${name}_${formatTimestamp()}.${ext}`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, content, "utf-8");
  return filepath;
}

/**
 * Writes query output to a file with a hash-based name.
 */
export function writeQueryOutput(
  sql: string,
  content: string,
  ext: string = "csv",
): string {
  let hash = 0;
  for (let i = 0; i < sql.length; i++) {
    hash = ((hash << 5) - hash) + sql.charCodeAt(i);
    hash |= 0;
  }
  const hexHash = Math.abs(hash).toString(16).padStart(6, "0").slice(0, 6);
  return writeToolOutput("query", hexHash, content, ext);
}
