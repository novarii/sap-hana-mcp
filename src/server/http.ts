/**
 * Express HTTP transport for SAP Broker MCP.
 *
 * Provides streamable HTTP MCP with:
 * - Bearer token authentication
 * - Per-session McpServer scoped to caller's profile
 * - Session management (create, reuse, cleanup)
 * - Approval API side-channel for operators
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { validateToken } from "../auth/tokens.js";
import { ApprovalStore } from "../approval/store.js";
import { createApprovalRoutes } from "../approval/routes.js";
import type { BrokerConfig } from "../auth/config.js";
import type { CallerContext } from "./context.js";
import { createServerForCaller } from "./registry.js";

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

interface SessionInfo {
  transport: StreamableHTTPServerTransport;
  caller: CallerContext;
}

const sessions = new Map<string, SessionInfo>();

// ---------------------------------------------------------------------------
// Express app factory
// ---------------------------------------------------------------------------

export function createHttpApp(brokerConfig: BrokerConfig): express.Express {
  const app = express();
  app.use(express.json());

  // Shared approval store (lives for the lifetime of the server)
  const approvalStore = new ApprovalStore();

  // Health check (unauthenticated)
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      sessions: sessions.size,
      pendingApprovals: approvalStore.pendingCount,
    });
  });

  // Approval management API (unauthenticated for now — operator side-channel)
  app.use("/approvals", createApprovalRoutes(approvalStore));

  // Auth middleware for /mcp — skip re-auth for existing sessions
  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing bearer token" },
        id: null,
      });
      return;
    }

    const token = authHeader.slice(7);
    const caller = validateToken(token, brokerConfig);
    if (!caller) {
      console.error(`[AUTH] Rejected token from ${req.ip}`);
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or unauthorized token" },
        id: null,
      });
      return;
    }

    console.error(`[AUTH] Authenticated: identity=${caller.identity} profile=${caller.profile} scopes=[${[...caller.scopes].join(",")}]`);
    (req as any)._caller = caller;
    next();
  });

  // POST /mcp — initialize new session or route to existing one
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — must be an initialize request
    if (!sessionId && isInitializeRequest(req.body)) {
      const caller = (req as any)._caller as CallerContext;

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, caller });
          console.error(`[SESSION] Created: id=${id} identity=${caller.identity} profile=${caller.profile}`);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          console.error(`[SESSION] Closed: id=${transport.sessionId}`);
        }
      };

      const server = createServerForCaller(caller, brokerConfig, approvalStore);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad request: missing session or not an initialize request" },
      id: null,
    });
  });

  // GET /mcp — SSE stream for existing session
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (session) {
      await session.transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: "Invalid or missing session" });
    }
  });

  // DELETE /mcp — close session
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (session) {
      await session.transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: "Invalid or missing session" });
    }
  });

  // Cleanup on shutdown
  process.on("SIGTERM", () => approvalStore.cancelAll());
  process.on("SIGINT", () => approvalStore.cancelAll());

  return app;
}
