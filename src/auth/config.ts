import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ApprovalRule } from "../approval/service.js";

// ---------------------------------------------------------------------------
// Broker config types
// ---------------------------------------------------------------------------

export interface ScopeDefinition {
  tools: string[];
}

export interface ProfileDefinition {
  description?: string;
  scopes: string[];
}

export interface TokenEntry {
  hash: string; // "sha256:<hex>" or plaintext for dev
  profile: string;
  identity: string;
}

export interface ApprovalConfigDef {
  timeout: number; // seconds
  rules: Record<string, ApprovalRule>;
}

export interface BrokerConfig {
  scopes: Record<string, ScopeDefinition>;
  profiles: Record<string, ProfileDefinition>;
  tokens: TokenEntry[];
  approval?: ApprovalConfigDef;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let cached: BrokerConfig | null = null;

export function loadBrokerConfig(configPath?: string): BrokerConfig {
  if (cached) return cached;

  const filePath = configPath
    ?? process.env.BROKER_CONFIG
    ?? resolve(process.cwd(), "broker.config.yaml");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read broker config at ${filePath}: ${err instanceof Error ? err.message : err}`
    );
  }

  const parsed = parseYaml(raw);
  const config = validateBrokerConfig(parsed, filePath);
  cached = config;
  return config;
}

export function clearBrokerConfigCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateBrokerConfig(raw: unknown, filePath: string): BrokerConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Broker config at ${filePath} is empty or not an object`);
  }

  const obj = raw as Record<string, unknown>;

  // Scopes
  if (!obj.scopes || typeof obj.scopes !== "object") {
    throw new Error(`Broker config: missing or invalid 'scopes' section`);
  }
  const scopes: Record<string, ScopeDefinition> = {};
  for (const [name, def] of Object.entries(obj.scopes as Record<string, unknown>)) {
    if (!def || typeof def !== "object" || !Array.isArray((def as any).tools)) {
      throw new Error(`Broker config: scope '${name}' must have a 'tools' array`);
    }
    scopes[name] = { tools: (def as any).tools as string[] };
  }

  // Profiles
  if (!obj.profiles || typeof obj.profiles !== "object") {
    throw new Error(`Broker config: missing or invalid 'profiles' section`);
  }
  const profiles: Record<string, ProfileDefinition> = {};
  for (const [name, def] of Object.entries(obj.profiles as Record<string, unknown>)) {
    if (!def || typeof def !== "object" || !Array.isArray((def as any).scopes)) {
      throw new Error(`Broker config: profile '${name}' must have a 'scopes' array`);
    }
    const profileScopes = (def as any).scopes as string[];
    for (const s of profileScopes) {
      if (!scopes[s]) {
        throw new Error(`Broker config: profile '${name}' references unknown scope '${s}'`);
      }
    }
    profiles[name] = {
      description: (def as any).description,
      scopes: profileScopes,
    };
  }

  // Tokens
  if (!obj.tokens || !Array.isArray(obj.tokens)) {
    throw new Error(`Broker config: missing or invalid 'tokens' array`);
  }
  const tokens: TokenEntry[] = [];
  for (const entry of obj.tokens) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Broker config: each token entry must be an object`);
    }
    const { hash, profile, identity } = entry as Record<string, unknown>;
    if (typeof hash !== "string" || typeof profile !== "string" || typeof identity !== "string") {
      throw new Error(`Broker config: token entry must have string 'hash', 'profile', 'identity'`);
    }
    if (!profiles[profile]) {
      throw new Error(`Broker config: token references unknown profile '${profile}'`);
    }
    tokens.push({ hash, profile, identity });
  }

  // Approval (optional)
  let approval: ApprovalConfigDef | undefined;
  if (obj.approval !== undefined) {
    if (typeof obj.approval !== "object" || obj.approval === null) {
      throw new Error(`Broker config: 'approval' must be an object`);
    }
    const approvalObj = obj.approval as Record<string, unknown>;
    const timeout = typeof approvalObj.timeout === "number" ? approvalObj.timeout : 120;
    if (typeof timeout !== "number" || timeout <= 0) {
      throw new Error(`Broker config: approval.timeout must be a positive number`);
    }

    const rules: Record<string, ApprovalRule> = {};
    if (approvalObj.rules && typeof approvalObj.rules === "object") {
      const validRules = ["required", "auto", "deny"];
      for (const [tool, rule] of Object.entries(approvalObj.rules as Record<string, unknown>)) {
        if (typeof rule !== "string" || !validRules.includes(rule)) {
          throw new Error(`Broker config: approval.rules.${tool} must be one of: ${validRules.join(", ")}`);
        }
        rules[tool] = rule as ApprovalRule;
      }
    }

    approval = { timeout, rules };
  }

  return { scopes, profiles, tokens, approval };
}
