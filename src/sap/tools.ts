/**
 * Operation-shaped SAP write tools.
 *
 * Each tool maps to a specific business operation rather than exposing
 * raw entity/method/body. This improves tool selection quality and
 * keeps the agent context smaller.
 */

import { z } from "zod";
import type { SAPClient, SAPResponse } from "./client.js";
import type { ToolDefinition } from "../tools/index.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

const SAP_ENTITIES = {
  ProductionOrders: "Production Order",
  PurchaseRequests: "Purchase Request",
  InventoryGenEntries: "Goods Receipt",
  InventoryGenExits: "Goods Issue",
} as const;

type SAPEntity = keyof typeof SAP_ENTITIES;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function escapeODataKey(key: string | number): string {
  return typeof key === "number" ? String(key) : `'${String(key).replaceAll("'", "''")}'`;
}

function stringifyBody(body: unknown): string {
  if (body === null) return "null";
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2);
}

function formatSuccess(entity: SAPEntity, action: string, response: SAPResponse): string {
  return `${action} ${SAP_ENTITIES[entity]} in SAP (HTTP ${response.status}).\n${stringifyBody(response.body)}`;
}

function formatFailure(entity: SAPEntity, response: SAPResponse): string {
  return `**Failed:** ${response.error ?? `SAP request for ${SAP_ENTITIES[entity]} failed`}`;
}

// ---------------------------------------------------------------------------
// Lazy SAP client accessor
// ---------------------------------------------------------------------------

let sapClientInstance: SAPClient | null = null;

export function setSAPClient(client: SAPClient): void {
  sapClientInstance = client;
}

function getSAPClient(): SAPClient {
  if (!sapClientInstance) {
    throw new Error("SAP client not initialized. Set SAP_BASE_URL, SAP_COMPANY_DB, SAP_USERNAME, SAP_PASSWORD.");
  }
  return sapClientInstance;
}

// ---------------------------------------------------------------------------
// Tool: create_production_order
// ---------------------------------------------------------------------------

const createProductionOrderSchema = z.object({
  body: z.record(z.string(), z.unknown()).describe(
    "SAP Production Order payload. Must include OriginAbs (linked sales order DocEntry). " +
    "Common fields: ItemCode, PlannedQuantity, DueDate, ProductionOrderOriginEntry.",
  ),
});

async function createProductionOrder(args: z.infer<typeof createProductionOrderSchema>): Promise<string> {
  if (!("OriginAbs" in args.body)) {
    return "**Validation failed:** Production order must reference a sales order via OriginAbs";
  }
  const client = getSAPClient();
  const response = await client.post("/ProductionOrders", args.body);
  return response.ok
    ? formatSuccess("ProductionOrders", "Created", response)
    : formatFailure("ProductionOrders", response);
}

// ---------------------------------------------------------------------------
// Tool: update_production_order
// ---------------------------------------------------------------------------

const updateProductionOrderSchema = z.object({
  key: z.union([z.string(), z.number()]).describe("DocEntry of the production order to update."),
  body: z.record(z.string(), z.unknown()).describe("Partial update payload for the production order."),
});

async function updateProductionOrder(args: z.infer<typeof updateProductionOrderSchema>): Promise<string> {
  const client = getSAPClient();
  const response = await client.patch(`/ProductionOrders(${escapeODataKey(args.key)})`, args.body);
  return response.ok
    ? formatSuccess("ProductionOrders", "Updated", response)
    : formatFailure("ProductionOrders", response);
}

// ---------------------------------------------------------------------------
// Tool: create_purchase_request
// ---------------------------------------------------------------------------

const createPurchaseRequestSchema = z.object({
  body: z.record(z.string(), z.unknown()).describe(
    "SAP Purchase Request payload. Common fields: RequriedDate, DocumentLines (array of line items with ItemCode, Quantity, etc.).",
  ),
});

async function createPurchaseRequest(args: z.infer<typeof createPurchaseRequestSchema>): Promise<string> {
  const client = getSAPClient();
  const response = await client.post("/PurchaseRequests", args.body);
  return response.ok
    ? formatSuccess("PurchaseRequests", "Created", response)
    : formatFailure("PurchaseRequests", response);
}

// ---------------------------------------------------------------------------
// Tool: update_purchase_request
// ---------------------------------------------------------------------------

const updatePurchaseRequestSchema = z.object({
  key: z.union([z.string(), z.number()]).describe("DocEntry of the purchase request to update."),
  body: z.record(z.string(), z.unknown()).describe("Partial update payload for the purchase request."),
});

async function updatePurchaseRequest(args: z.infer<typeof updatePurchaseRequestSchema>): Promise<string> {
  const client = getSAPClient();
  const response = await client.patch(`/PurchaseRequests(${escapeODataKey(args.key)})`, args.body);
  return response.ok
    ? formatSuccess("PurchaseRequests", "Updated", response)
    : formatFailure("PurchaseRequests", response);
}

// ---------------------------------------------------------------------------
// Tool: receive_inventory (Goods Receipt via InventoryGenEntries)
// ---------------------------------------------------------------------------

const receiveInventorySchema = z.object({
  body: z.record(z.string(), z.unknown()).describe(
    "SAP Goods Receipt (InventoryGenEntries) payload. Common fields: DocumentLines (array with ItemCode, Quantity, WarehouseCode).",
  ),
});

async function receiveInventory(args: z.infer<typeof receiveInventorySchema>): Promise<string> {
  const client = getSAPClient();
  const response = await client.post("/InventoryGenEntries", args.body);
  return response.ok
    ? formatSuccess("InventoryGenEntries", "Created", response)
    : formatFailure("InventoryGenEntries", response);
}

// ---------------------------------------------------------------------------
// Tool: issue_inventory (Goods Issue via InventoryGenExits)
// ---------------------------------------------------------------------------

const issueInventorySchema = z.object({
  body: z.record(z.string(), z.unknown()).describe(
    "SAP Goods Issue (InventoryGenExits) payload. Common fields: DocumentLines (array with ItemCode, Quantity, WarehouseCode).",
  ),
});

async function issueInventory(args: z.infer<typeof issueInventorySchema>): Promise<string> {
  const client = getSAPClient();
  const response = await client.post("/InventoryGenExits", args.body);
  return response.ok
    ? formatSuccess("InventoryGenExits", "Created", response)
    : formatFailure("InventoryGenExits", response);
}

// ---------------------------------------------------------------------------
// Export all write tool definitions
// ---------------------------------------------------------------------------

export const SAP_WRITE_TOOLS: ToolDefinition[] = [
  {
    name: "create_production_order",
    description:
      "Create a production order in SAP. The payload must include OriginAbs (linked sales order DocEntry). " +
      "Common fields: ItemCode, PlannedQuantity, DueDate, ProductionOrderOriginEntry.",
    inputSchema: createProductionOrderSchema,
    handler: createProductionOrder,
  },
  {
    name: "update_production_order",
    description:
      "Update an existing production order in SAP by DocEntry. " +
      "Pass only the fields to change in body.",
    inputSchema: updateProductionOrderSchema,
    handler: updateProductionOrder,
  },
  {
    name: "create_purchase_request",
    description:
      "Create a purchase request in SAP. " +
      "Common fields: RequriedDate, DocumentLines (array of line items).",
    inputSchema: createPurchaseRequestSchema,
    handler: createPurchaseRequest,
  },
  {
    name: "update_purchase_request",
    description:
      "Update an existing purchase request in SAP by DocEntry. " +
      "Pass only the fields to change in body.",
    inputSchema: updatePurchaseRequestSchema,
    handler: updatePurchaseRequest,
  },
  {
    name: "receive_inventory",
    description:
      "Create a goods receipt (inventory in) in SAP. " +
      "Use InventoryGenEntries format: DocumentLines with ItemCode, Quantity, WarehouseCode.",
    inputSchema: receiveInventorySchema,
    handler: receiveInventory,
  },
  {
    name: "issue_inventory",
    description:
      "Create a goods issue (inventory out) in SAP. " +
      "Use InventoryGenExits format: DocumentLines with ItemCode, Quantity, WarehouseCode.",
    inputSchema: issueInventorySchema,
    handler: issueInventory,
  },
];
