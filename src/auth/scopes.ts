import type { BrokerConfig } from "./config.js";

/**
 * Resolve a set of scopes to the tool names they grant access to.
 */
export function resolveAllowedTools(
  scopes: Set<string>,
  config: BrokerConfig,
): Set<string> {
  const tools = new Set<string>();
  for (const scope of scopes) {
    const def = config.scopes[scope];
    if (def) {
      for (const tool of def.tools) {
        tools.add(tool);
      }
    }
  }
  return tools;
}
