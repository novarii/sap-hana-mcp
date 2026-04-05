/**
 * SAP Service Layer v2 client.
 *
 * Ported from ansur daemon. Handles session cookies (B1SESSION/ROUTEID),
 * auto-login, 401 re-auth, and SAP-specific error mapping.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SAPClientConfig = {
  baseUrl: string;
  companyDb: string;
  username: string;
  password: string;
};

export type SAPResponse = {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
};

export type SAPClient = {
  get: (path: string) => Promise<SAPResponse>;
  post: (path: string, body: unknown) => Promise<SAPResponse>;
  patch: (path: string, body: unknown) => Promise<SAPResponse>;
  logout: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const V2_PREFIX = "/b1s/v2";
const V1_PREFIX = "/b1s/v1";

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

type SAPClientError = Error & { status: number; body: unknown };

function createClientError(message: string, status: number, body: unknown): SAPClientError {
  const error = new Error(message) as SAPClientError;
  error.status = status;
  error.body = body;
  return error;
}

function normalizePath(path: string): string {
  if (path.startsWith(V1_PREFIX)) {
    throw createClientError("SAP Service Layer v1 is not supported", 400, null);
  }
  if (path.startsWith(V2_PREFIX)) return path;
  if (path.startsWith("/")) return `${V2_PREFIX}${path}`;
  return `${V2_PREFIX}/${path}`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Cookie handling
// ---------------------------------------------------------------------------

function getSetCookieValues(headers: Headers): string[] {
  const bag = headers as Headers & {
    getSetCookie?: () => string[];
    getAll?: (name: string) => string[];
  };
  if (typeof bag.getSetCookie === "function") return bag.getSetCookie();
  if (typeof bag.getAll === "function") return bag.getAll("set-cookie");
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function extractCookieValue(setCookie: string, name: string): string | null {
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1] ?? null;
}

function buildCookieHeader(headers: Headers): string {
  const cookies = getSetCookieValues(headers);
  const b1Session = cookies.map((v) => extractCookieValue(v, "B1SESSION")).find((v) => v !== null);
  const routeId = cookies.map((v) => extractCookieValue(v, "ROUTEID")).find((v) => v !== null);

  if (!b1Session || !routeId) {
    throw createClientError(
      "SAP login succeeded but did not return both B1SESSION and ROUTEID cookies",
      500,
      null,
    );
  }

  return `B1SESSION=${b1Session}; ROUTEID=${routeId}`;
}

// ---------------------------------------------------------------------------
// SAP error extraction
// ---------------------------------------------------------------------------

function extractSAPMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return typeof body === "string" && body.length > 0 ? body : null;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const value = (message as { value?: unknown }).value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractSAPCode(body: unknown): number | string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number" || typeof code === "string") return code;
  return null;
}

function mapKnownSAPError(
  code: number | string | null,
  message: string | null,
  status: number,
): string | null {
  const normalizedCode =
    typeof code === "number"
      ? code
      : typeof code === "string" && /^-?\d+$/.test(code)
        ? Number.parseInt(code, 10)
        : null;

  if (status === 502 || status === 503) {
    return "SAP Service Layer unavailable — retry later";
  }
  if (normalizedCode === -110925) {
    return "Production order must reference a sales order";
  }
  if (normalizedCode === -5002) {
    const itemCode = message?.match(/['"]([^'"]+)['"]/)?.[1];
    return itemCode
      ? `Item code ${itemCode} not found in SAP`
      : "Item code not found in SAP";
  }
  if (normalizedCode === -2028) {
    return "This production order already exists";
  }
  if (message && /\batp\b|available[- ]to[- ]promise/i.test(message)) {
    return `Insufficient stock: ${message}`;
  }
  return null;
}

export function extractSAPErrorMessage(body: unknown, status: number): string {
  const message = extractSAPMessage(body);
  const code = extractSAPCode(body);
  return (
    mapKnownSAPError(code, message, status) ??
    message ??
    (status >= 500
      ? "SAP Service Layer unavailable — retry later"
      : `SAP request failed with HTTP ${status}`)
  );
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function createSAPClient(config: SAPClientConfig): SAPClient {
  let cookieHeader: string | null = null;
  let loginPromise: Promise<string> | null = null;

  async function login(): Promise<string> {
    if (loginPromise) return await loginPromise;

    loginPromise = (async () => {
      const response = await fetch(`${config.baseUrl}${V2_PREFIX}/Login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          CompanyDB: config.companyDb,
          UserName: config.username,
          Password: config.password,
        }),
      });
      const body = await parseBody(response);
      if (!response.ok) {
        throw createClientError(
          extractSAPErrorMessage(body, response.status),
          response.status,
          body,
        );
      }
      cookieHeader = buildCookieHeader(response.headers);
      return cookieHeader;
    })().finally(() => {
      loginPromise = null;
    });

    return await loginPromise;
  }

  async function ensureCookieHeader(): Promise<string> {
    if (cookieHeader) return cookieHeader;
    return await login();
  }

  async function request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    retryOnUnauthorized = true,
  ): Promise<SAPResponse> {
    let normalizedPath: string;
    try {
      normalizedPath = normalizePath(path);
    } catch (error) {
      if (error instanceof Error && "status" in error && "body" in error) {
        const e = error as SAPClientError;
        return { ok: false, status: e.status, body: e.body, error: e.message };
      }
      return { ok: false, status: 500, body: null, error: error instanceof Error ? error.message : String(error) };
    }

    try {
      const response = await fetch(`${config.baseUrl}${normalizedPath}`, {
        method,
        headers: {
          Accept: "application/json",
          Cookie: await ensureCookieHeader(),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const parsedBody = await parseBody(response);

      if (response.status === 401 && retryOnUnauthorized) {
        cookieHeader = null;
        await login();
        return await request(method, path, body, false);
      }

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          body: parsedBody,
          error: extractSAPErrorMessage(parsedBody, response.status),
        };
      }

      return { ok: true, status: response.status, body: parsedBody };
    } catch (error) {
      if (error instanceof Error && "status" in error && typeof (error as SAPClientError).status === "number") {
        const e = error as SAPClientError;
        return { ok: false, status: e.status, body: e.body, error: e.message };
      }
      return {
        ok: false,
        status: 0,
        body: null,
        error: error instanceof Error ? error.message : "Network error while contacting SAP Service Layer",
      };
    }
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    async logout() {
      if (!cookieHeader) return;
      try {
        await fetch(`${config.baseUrl}${V2_PREFIX}/Logout`, {
          method: "POST",
          headers: { Cookie: cookieHeader },
        });
      } finally {
        cookieHeader = null;
      }
    },
  };
}
