import "dotenv/config";

export interface HanaConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  schema?: string; // If set, restrict to this schema only
  encrypt: boolean;
  sslValidateCertificate: boolean;
  rowLimit: number;
  maxResultSize: number; // bytes
  queryTimeout: number; // ms
  connectionTimeout: number; // ms
}

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

export function loadConfig(): HanaConfig {
  return {
    host: getEnvRequired("HANA_HOST"),
    port: getEnvNumber("HANA_PORT", 30015),
    user: getEnvRequired("HANA_USER"),
    password: getEnvRequired("HANA_PASSWORD"),
    schema: process.env.HANA_SCHEMA || undefined,
    encrypt: getEnvBoolean("HANA_ENCRYPT", true),
    sslValidateCertificate: getEnvBoolean("HANA_SSL_VALIDATE_CERTIFICATE", true),
    rowLimit: getEnvNumber("HANA_ROW_LIMIT", 1000),
    maxResultSize: getEnvNumber("HANA_MAX_RESULT_SIZE", 5 * 1024 * 1024), // 5MB
    queryTimeout: getEnvNumber("HANA_QUERY_TIMEOUT", 30000), // 30s
    connectionTimeout: getEnvNumber("HANA_CONNECTION_TIMEOUT", 5000), // 5s
  };
}

// Singleton config instance
let configInstance: HanaConfig | null = null;

export function getConfig(): HanaConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
