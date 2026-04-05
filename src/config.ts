import "dotenv/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// HANA connection config (env vars — secrets)
// ---------------------------------------------------------------------------

export interface HanaConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  schema?: string;
  encrypt: boolean;
  sslValidateCertificate: boolean;
  rowLimit: number;
  queryTimeout: number;
  connectionTimeout: number;
  outputDir: string;
}

// ---------------------------------------------------------------------------
// Server config (env vars — non-secret)
// ---------------------------------------------------------------------------

export type TransportMode = "stdio" | "http";

export interface ServerConfig {
  transport: TransportMode;
  httpPort: number;
  httpHost: string;
  brokerConfigPath: string;
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function getEnvRequired(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvOptional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable ${key}: ${value}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export function loadHanaConfig(): HanaConfig {
  return {
    host: getEnvRequired("HANA_HOST"),
    port: getEnvNumber("HANA_PORT", 30015),
    user: getEnvRequired("HANA_USER"),
    password: getEnvRequired("HANA_PASSWORD"),
    schema: process.env.HANA_SCHEMA || undefined,
    encrypt: getEnvBoolean("HANA_ENCRYPT", true),
    sslValidateCertificate: getEnvBoolean("HANA_SSL_VALIDATE_CERTIFICATE", true),
    rowLimit: getEnvNumber("HANA_ROW_LIMIT", 1000),
    queryTimeout: getEnvNumber("HANA_QUERY_TIMEOUT", 30000),
    connectionTimeout: getEnvNumber("HANA_CONNECTION_TIMEOUT", 5000),
    outputDir: process.env.HANA_OUTPUT_DIR || join(tmpdir(), "sap-broker-mcp"),
  };
}

export function loadServerConfig(): ServerConfig {
  const transport = (process.env.BROKER_TRANSPORT || "stdio") as TransportMode;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid BROKER_TRANSPORT: '${transport}'. Must be 'stdio' or 'http'.`);
  }
  return {
    transport,
    httpPort: getEnvNumber("BROKER_PORT", 3000),
    httpHost: getEnvOptional("BROKER_HOST", "127.0.0.1"),
    brokerConfigPath: process.env.BROKER_CONFIG || "",
  };
}

// ---------------------------------------------------------------------------
// SAP Service Layer config (env vars — secrets, optional)
// ---------------------------------------------------------------------------

export interface SAPConfig {
  baseUrl: string;
  companyDb: string;
  username: string;
  password: string;
}

/**
 * Load SAP Service Layer config. Returns null if SAP_BASE_URL is not set
 * (SAP write tools will be unavailable but HANA read tools still work).
 */
export function loadSAPConfig(): SAPConfig | null {
  const baseUrl = process.env.SAP_BASE_URL;
  if (!baseUrl) return null;

  return {
    baseUrl,
    companyDb: getEnvRequired("SAP_COMPANY_DB"),
    username: getEnvRequired("SAP_USERNAME"),
    password: getEnvRequired("SAP_PASSWORD"),
  };
}

// ---------------------------------------------------------------------------
// Singleton (HANA config — backward compat with hana/client.ts)
// ---------------------------------------------------------------------------

let hanaConfigInstance: HanaConfig | null = null;

export function getConfig(): HanaConfig {
  if (!hanaConfigInstance) {
    hanaConfigInstance = loadHanaConfig();
  }
  return hanaConfigInstance;
}
