/**
 * Approval service.
 *
 * Provides the approval gate used by the tool registry to intercept
 * write tool execution. Wraps the store and adds description formatting.
 */

import { ApprovalStore, type ApprovalResult } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalRule = "required" | "auto" | "deny";

export interface ApprovalConfig {
  timeout: number; // seconds
  rules: Record<string, ApprovalRule>; // tool name → rule
}

// ---------------------------------------------------------------------------
// Description formatting (mirrors ansur's formatApprovalDescription)
// ---------------------------------------------------------------------------

function getField(body: Record<string, unknown>, ...keys: string[]): string | number | null {
  for (const key of keys) {
    const val = body[key];
    if (typeof val === "string" && val.length > 0) return val;
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return null;
}

function line(label: string, value: string | number | null): string | null {
  return value !== null ? `${label}: ${value}` : null;
}

export function formatApprovalDescription(tool: string, args: Record<string, unknown>): string {
  const body = (args.body ?? args) as Record<string, unknown>;
  const key = args.key;

  const lines = [
    tool,
    line("Item", getField(body, "ItemCode", "ItemNo", "Code")),
    line("Qty", getField(body, "PlannedQuantity", "PlannedQty", "Quantity")),
    line("Sales Order", getField(body, "OriginAbs")),
    line("Due", getField(body, "DueDate")),
    line("Customer", getField(body, "U_MuhAd")),
    key !== undefined ? line("Key", typeof key === "number" || typeof key === "string" ? key : null) : null,
  ].filter((l): l is string => l !== null);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Approval gate — wraps a tool handler
// ---------------------------------------------------------------------------

/**
 * Wrap a tool handler with an approval gate.
 * Returns a new handler that checks the approval rule before executing.
 */
export function withApprovalGate(
  toolName: string,
  handler: (args: Record<string, unknown>) => Promise<string>,
  store: ApprovalStore,
  config: ApprovalConfig,
  callerIdentity: string,
): (args: Record<string, unknown>) => Promise<string> {
  return async (args) => {
    const rule = config.rules[toolName] ?? "required";

    if (rule === "deny") {
      return `**Denied:** ${toolName} is blocked by approval policy`;
    }

    if (rule === "auto") {
      return handler(args);
    }

    // rule === "required"
    const description = formatApprovalDescription(toolName, args);
    const { shortId, promise } = store.create({
      tool: toolName,
      description,
      callerIdentity,
      timeoutSeconds: config.timeout,
    });

    console.error(`[APPROVAL] Pending: ${shortId} tool=${toolName} caller=${callerIdentity}`);

    const result: ApprovalResult = await promise;

    if (result.decision === "approved") {
      console.error(`[APPROVAL] Approved: ${shortId} tool=${toolName}${result.resolvedBy ? ` by=${result.resolvedBy}` : ""}`);
      return handler(args);
    }

    const reason = result.reason ?? result.decision;
    console.error(`[APPROVAL] ${result.decision}: ${shortId} tool=${toolName} reason=${reason}`);
    return `**${result.decision === "denied" ? "Denied" : "Expired"}:** ${reason}`;
  };
}
