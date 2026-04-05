/**
 * Express routes for managing pending approvals.
 *
 * These endpoints are for operators/admins to list and resolve approvals.
 * They are NOT part of the MCP protocol — they're a side-channel API.
 */

import { Router, type Request, type Response } from "express";
import type { ApprovalStore } from "./store.js";

export function createApprovalRoutes(store: ApprovalStore): Router {
  const router = Router();

  // GET /approvals — list pending approvals
  router.get("/", (_req: Request, res: Response) => {
    const pending = store.list();
    res.json({
      count: pending.length,
      approvals: pending.map((a) => ({
        id: a.id,
        shortId: a.shortId,
        tool: a.tool,
        description: a.description,
        callerIdentity: a.callerIdentity,
        createdAt: new Date(a.createdAt).toISOString(),
        ageSeconds: Math.round((Date.now() - a.createdAt) / 1000),
      })),
    });
  });

  // POST /approvals/:id/approve — approve a pending request
  router.post("/:id/approve", (req: Request, res: Response) => {
    try {
      const record = store.approve(String(req.params.id), req.body?.resolvedBy);
      console.error(`[APPROVAL-API] Approved: ${record.shortId} tool=${record.tool}`);
      res.json({ status: "approved", id: record.id, tool: record.tool });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : "Not found" });
    }
  });

  // POST /approvals/:id/deny — deny a pending request
  router.post("/:id/deny", (req: Request, res: Response) => {
    try {
      const record = store.deny(String(req.params.id), req.body?.reason, req.body?.resolvedBy);
      console.error(`[APPROVAL-API] Denied: ${record.shortId} tool=${record.tool} reason=${req.body?.reason ?? "none"}`);
      res.json({ status: "denied", id: record.id, tool: record.tool });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : "Not found" });
    }
  });

  return router;
}
