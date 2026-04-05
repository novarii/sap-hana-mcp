import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import type { BrokerConfig } from "./config.js";
import type { CallerContext } from "../server/context.js";

/**
 * Validate a bearer token against the broker config.
 * Returns a CallerContext if valid, null otherwise.
 *
 * Supports two hash formats:
 *   - "sha256:<hex>" — compared against SHA-256 of the raw token
 *   - plaintext string — compared directly (dev/internal only)
 */
export function validateToken(
  rawToken: string,
  config: BrokerConfig,
): CallerContext | null {
  const tokenHash = sha256(rawToken);

  for (const entry of config.tokens) {
    let match = false;

    if (entry.hash.startsWith("sha256:")) {
      const expected = entry.hash.slice(7); // strip "sha256:" prefix
      match = timingSafeEqual(tokenHash, expected);
    } else {
      // Plaintext comparison (dev only)
      match = timingSafeEqual(rawToken, entry.hash);
    }

    if (match) {
      const profile = config.profiles[entry.profile];
      if (!profile) return null; // broken config, fail closed

      return {
        identity: entry.identity,
        profile: entry.profile,
        scopes: new Set(profile.scopes),
      };
    }
  }

  return null;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time string comparison to prevent timing attacks on token matching.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    // Compare against self to burn the same time, then return false.
    cryptoTimingSafeEqual(bufA, bufA);
    return false;
  }

  return cryptoTimingSafeEqual(bufA, bufB);
}
