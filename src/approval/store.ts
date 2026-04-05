/**
 * In-memory pending approval store.
 *
 * Each pending approval is a Promise that the tool handler awaits.
 * The approval HTTP API resolves/rejects it. Timeout auto-denies.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalDecision = "approved" | "denied" | "expired";

export interface ApprovalResult {
  decision: ApprovalDecision;
  reason?: string;
  resolvedAt: number;
  resolvedBy?: string;
}

export interface PendingApproval {
  id: string;
  shortId: string;
  tool: string;
  description: string;
  callerIdentity: string;
  createdAt: number;
}

interface PendingEntry extends PendingApproval {
  resolve: (result: ApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ApprovalStore {
  private pending = new Map<string, PendingEntry>();

  /**
   * Create a pending approval. Returns an ID and a Promise that resolves
   * when the approval is granted, denied, or times out.
   */
  create(opts: {
    tool: string;
    description: string;
    callerIdentity: string;
    timeoutSeconds: number;
  }): { id: string; shortId: string; promise: Promise<ApprovalResult> } {
    const id = randomUUID();
    const shortId = id.slice(0, 6);

    let resolvePromise!: (result: ApprovalResult) => void;
    const promise = new Promise<ApprovalResult>((resolve) => {
      resolvePromise = resolve;
    });

    const timer = setTimeout(() => {
      if (this.pending.has(id)) {
        this.settle(id, {
          decision: "expired",
          reason: "Approval timed out",
          resolvedAt: Date.now(),
        });
      }
    }, opts.timeoutSeconds * 1000);

    const entry: PendingEntry = {
      id,
      shortId,
      tool: opts.tool,
      description: opts.description,
      callerIdentity: opts.callerIdentity,
      createdAt: Date.now(),
      resolve: resolvePromise,
      timer,
    };

    this.pending.set(id, entry);

    return { id, shortId, promise };
  }

  /**
   * Approve a pending request by full ID or short prefix.
   */
  approve(idOrPrefix: string, resolvedBy?: string): PendingApproval {
    const entry = this.findByPrefix(idOrPrefix);
    this.settle(entry.id, {
      decision: "approved",
      resolvedAt: Date.now(),
      resolvedBy,
    });
    return this.toPublic(entry);
  }

  /**
   * Deny a pending request by full ID or short prefix.
   */
  deny(idOrPrefix: string, reason?: string, resolvedBy?: string): PendingApproval {
    const entry = this.findByPrefix(idOrPrefix);
    this.settle(entry.id, {
      decision: "denied",
      reason,
      resolvedAt: Date.now(),
      resolvedBy,
    });
    return this.toPublic(entry);
  }

  /**
   * List all pending approvals.
   */
  list(): PendingApproval[] {
    return [...this.pending.values()].map((e) => this.toPublic(e));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Cancel all pending approvals (e.g. on shutdown).
   */
  cancelAll(reason = "Server shutting down"): void {
    for (const entry of this.pending.values()) {
      this.settle(entry.id, {
        decision: "expired",
        reason,
        resolvedAt: Date.now(),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private settle(id: string, result: ApprovalResult): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(result);
  }

  private findByPrefix(idOrPrefix: string): PendingEntry {
    // Try exact match first
    const exact = this.pending.get(idOrPrefix);
    if (exact) return exact;

    // Prefix match
    const matches = [...this.pending.values()].filter(
      (e) => e.id.startsWith(idOrPrefix) || e.shortId === idOrPrefix,
    );

    if (matches.length === 0) {
      throw new Error(`No pending approval matches "${idOrPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(`Approval prefix "${idOrPrefix}" is ambiguous (${matches.length} matches)`);
    }
    return matches[0]!;
  }

  private toPublic(entry: PendingEntry): PendingApproval {
    return {
      id: entry.id,
      shortId: entry.shortId,
      tool: entry.tool,
      description: entry.description,
      callerIdentity: entry.callerIdentity,
      createdAt: entry.createdAt,
    };
  }
}
