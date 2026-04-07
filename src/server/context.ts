import type { ResolvedHanaOverride } from "../auth/config.js";

/**
 * Caller context attached to each authenticated session.
 * Carries identity, profile, and resolved scopes.
 */
export interface CallerContext {
  identity: string;
  profile: string;
  scopes: Set<string>;
  hanaOverrides?: ResolvedHanaOverride;
}

/**
 * Default context for stdio dev mode — full access, no auth required.
 */
export const DEV_CONTEXT: CallerContext = {
  identity: "dev-local",
  profile: "dev",
  scopes: new Set(["read:metadata", "query:hana"]),
};
