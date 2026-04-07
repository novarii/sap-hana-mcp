# SAP B1-HANA Broker MCP

Authenticated, scope-aware MCP server for SAP HANA reads and SAP Service Layer writes. Connects LLMs like Claude to your SAP environment with per-caller profiles, approval gates, and defense-in-depth security.

## Features

- **Two transports** — stdio (dev, no auth) and HTTP (production, bearer token auth)
- **Scope-based access control** — profiles define which tools each caller can see and use
- **HANA read tools** — schema introspection, table sampling, read-only SQL queries
- **SAP write tools** — production orders, purchase requests, inventory movements via Service Layer
- **Approval workflow** — write operations can require human approval before execution
- **Safety controls** — SQL validation, rate limiting, row limits, query timeouts, audit logging
- **SAP HANA 2.0 SPS05+** and **SAP Business One Service Layer** compatible

## Installation

```bash
git clone <repo-url>
cd sap-hana-mcp

# Configure SAP npm registry (required for @sap/hana-client)
npm config set @sap:registry https://npm.sap.com

pnpm install
pnpm build
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and fill in your values.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| **Broker** | | | |
| `BROKER_TRANSPORT` | No | `stdio` | `stdio` (dev) or `http` (production) |
| `BROKER_HOST` | No | `127.0.0.1` | HTTP bind address |
| `BROKER_PORT` | No | `3000` | HTTP port |
| `BROKER_CONFIG` | No | `./broker.config.yaml` | Path to broker config (HTTP mode only) |
| `BROKER_TLS` | No | `false` | Enable HTTPS for the broker endpoint |
| `BROKER_TLS_KEY` | No | `/opt/sap-broker/tls/key.pem` | PEM private key path when TLS is enabled |
| `BROKER_TLS_CERT` | No | `/opt/sap-broker/tls/cert.pem` | PEM certificate path when TLS is enabled |
| **HANA** | | | |
| `HANA_HOST` | Yes | - | HANA server hostname or IP |
| `HANA_PORT` | No | `30015` | HANA port (3\<instance\>15) |
| `HANA_USER` | Yes | - | Database username |
| `HANA_PASSWORD` | Yes | - | Database password |
| `HANA_SCHEMA` | No | - | Restrict to single schema (empty = all) |
| `HANA_ENCRYPT` | No | `true` | Enable TLS encryption |
| `HANA_SSL_VALIDATE_CERTIFICATE` | No | `true` | Validate SSL certificate |
| `HANA_ROW_LIMIT` | No | `1000` | Max rows per query |
| `HANA_QUERY_TIMEOUT` | No | `30000` | Query timeout (ms) |
| `HANA_CONNECTION_TIMEOUT` | No | `5000` | Connection timeout (ms) |
| **SAP Service Layer** (optional) | | | |
| `SAP_BASE_URL` | No | - | Service Layer URL (enables write tools) |
| `SAP_COMPANY_DB` | No | - | Company database name |
| `SAP_USERNAME` | No | - | Service Layer username |
| `SAP_PASSWORD` | No | - | Service Layer password |

### Broker Config (HTTP mode)

`broker.config.yaml` defines scopes, profiles, tokens, and approval rules. See the included file for a fully commented example.

**Scopes** map to tool sets:

| Scope | Tools |
|-------|-------|
| `read:metadata` | `list_schemas`, `list_tables`, `list_views`, `describe_table`, `get_table_sample` |
| `query:hana` | `execute_query` |
| `write:production_orders` | `create_production_order`, `update_production_order` |
| `write:purchase_requests` | `create_purchase_request`, `update_purchase_request` |
| `write:inventory` | `receive_inventory`, `issue_inventory` |

**Profiles** bundle scopes for different roles (observer, analyst, planner, warehouse, operator).

**Tokens** are SHA-256 hashed bearer tokens mapped to profiles:

```bash
# Generate a token + hash pair
TOKEN=$(openssl rand -hex 32)
HASH=$(echo -n "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
echo "token: $TOKEN"
echo "hash:  sha256:$HASH"
```

**Approval rules** gate write tools: `required` (human must approve), `auto` (execute immediately), or `deny` (block).

## Setup

### Dev mode (stdio)

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "sap-broker": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/sap-hana-mcp/dist/index.js"],
      "env": {
        "HANA_HOST": "your-hana-host.example.com",
        "HANA_PORT": "30015",
        "HANA_USER": "MCP_READER",
        "HANA_PASSWORD": "your_password",
        "HANA_SCHEMA": "YOUR_SCHEMA"
      }
    }
  }
}
```

Or via CLI:

```bash
claude mcp add sap-broker --transport stdio \
  --env HANA_HOST=your-hana-host.example.com \
  --env HANA_PORT=30015 \
  --env HANA_USER=your_user \
  --env HANA_PASSWORD=your_password \
  --env HANA_SCHEMA=YOUR_SCHEMA \
  -- node /path/to/sap-hana-mcp/dist/index.js
```

In stdio mode all tools are available with no auth (dev only).

### Production mode (HTTP)

```bash
BROKER_TRANSPORT=http \
BROKER_HOST=127.0.0.1 \
BROKER_PORT=3000 \
BROKER_TLS=true \
BROKER_TLS_KEY=/opt/sap-broker/tls/key.pem \
BROKER_TLS_CERT=/opt/sap-broker/tls/cert.pem \
HANA_HOST=your-hana-host.example.com \
HANA_USER=MCP_READER \
HANA_PASSWORD=your_password \
node dist/index.js
```

Callers authenticate with `Authorization: Bearer <token>` and only see tools matching their profile's scopes.

## Available Tools

### Read Tools (HANA)

| Tool | Description |
|------|-------------|
| `list_schemas` | List accessible database schemas |
| `list_tables` | List tables in a schema with record counts |
| `list_views` | List views in a schema |
| `describe_table` | Get columns, primary keys; full details written to file |
| `execute_query` | Execute read-only SELECT queries |
| `get_table_sample` | Sample rows from a table (written to CSV) |

### Write Tools (SAP Service Layer)

Require `SAP_BASE_URL` to be configured. Only available in scopes that include write permissions.

| Tool | Description |
|------|-------------|
| `create_production_order` | Create a production order (requires OriginAbs) |
| `update_production_order` | Update a production order by DocEntry |
| `create_purchase_request` | Create a purchase request |
| `update_purchase_request` | Update a purchase request by DocEntry |
| `receive_inventory` | Goods receipt (InventoryGenEntries) |
| `issue_inventory` | Goods issue (InventoryGenExits) |

## HTTP API

### MCP Endpoint

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mcp` | Initialize session or send MCP request |
| `GET` | `/mcp` | SSE stream for existing session |
| `DELETE` | `/mcp` | Close session |

Sessions are tracked via the `Mcp-Session-Id` header.

### Approval API (side-channel)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/approvals` | List pending approvals |
| `POST` | `/approvals/:id/approve` | Approve a pending request |
| `POST` | `/approvals/:id/deny` | Deny a pending request (optional `reason` in body) |

### Health Check

`GET /health` — returns `{ status, sessions, pendingApprovals }` (unauthenticated). If `BROKER_TLS=true`, probe it with `curl -k https://127.0.0.1:${BROKER_PORT:-3000}/health`.

## Security Model

### Defense-in-Depth Architecture

```
Agent Request
    |
[1] Bearer Token Auth ────── Validate token, resolve profile + scopes
    |
[2] Scope Filtering ─────── Only tools matching caller scopes are visible
    |
[3] Approval Gate ────────── Write tools may require human approval
    |
[4] SQL Keyword Validator ── Block INSERT, UPDATE, DELETE, DROP, etc.
    |
[5] Query Parser ─────────── Single statement only (no injection)
    |
[6] Prefix Validation ────── Must start with SELECT, WITH, or EXPLAIN
    |
[7] Rate Limiter ─────────── Sliding window (30 req / 60s)
    |
[8] DB User Privileges ───── SELECT-only grants (recommended)
    |
[9] Result Limits ─────────── Row count and query timeout enforcement
```

### Blocked SQL Keywords

```
INSERT, UPDATE, DELETE, MERGE, UPSERT, REPLACE
CREATE, ALTER, DROP, TRUNCATE, RENAME
GRANT, REVOKE, CALL, EXEC, EXECUTE
BEGIN, COMMIT, ROLLBACK, SAVEPOINT, SET
IMPORT, EXPORT, LOAD, UNLOAD
```

### Recommended: Read-Only Database User

```sql
CREATE USER MCP_READER PASSWORD "YourSecurePassword";
GRANT SELECT ON SCHEMA YOUR_SCHEMA TO MCP_READER;
ALTER USER MCP_READER DISABLE PASSWORD LIFETIME;
```

## Development

```bash
pnpm dev      # stdio mode with hot reload
pnpm build    # compile TypeScript
pnpm start    # run production build
```

### Project Structure

```
sap-hana-mcp/
├── src/
│   ├── index.ts              # Entry point, transport selection
│   ├── config.ts             # Environment configuration
│   ├── hana/
│   │   └── client.ts         # HANA connection & query execution
│   ├── sap/
│   │   ├── client.ts         # SAP Service Layer HTTP client
│   │   └── tools.ts          # Write tool implementations
│   ├── security/
│   │   ├── query-validator.ts # SQL injection prevention
│   │   ├── rate-limiter.ts   # Sliding window rate limiter
│   │   └── audit.ts          # Query audit logging
│   ├── auth/
│   │   ├── config.ts         # Broker config YAML loader
│   │   ├── tokens.ts         # Bearer token validation
│   │   └── scopes.ts         # Scope resolution
│   ├── server/
│   │   ├── context.ts        # Caller context model
│   │   ├── registry.ts       # Scope-aware tool registration
│   │   ├── stdio.ts          # Dev transport
│   │   └── http.ts           # Production HTTP transport
│   ├── tools/
│   │   ├── index.ts          # Read tool definitions & handlers
│   │   ├── format.ts         # Result formatting (table, CSV)
│   │   └── output.ts         # File output management
│   └── approval/
│       ├── service.ts        # Approval gate wrapper
│       ├── store.ts          # In-memory approval store
│       └── routes.ts         # Approval REST API
├── broker.config.yaml        # Scopes, profiles, tokens, approval rules
├── .env.example              # Environment variable template
├── package.json
└── tsconfig.json
```

## Troubleshooting

### Authentication Failed

- Verify username/password
- Check if user exists: `SELECT USER_NAME FROM SYS.USERS WHERE USER_NAME = 'MCP_READER'`

### Connection Refused

- Verify HANA is running: `ssh user@host "HDB info"`
- Check port: `30015` for instance `00`, `30115` for instance `01`
- Test connectivity: `telnet <host> <port>`

### Query Validation Failed

- Only SELECT, WITH, EXPLAIN queries allowed
- Check for blocked keywords
- Multi-statement queries not allowed

### HTTP 401/403

- Ensure `Authorization: Bearer <token>` header is set
- Verify token hash is in `broker.config.yaml`
- Check that the token's profile has the required scopes

### Write Tools Unavailable

- Set `SAP_BASE_URL`, `SAP_COMPANY_DB`, `SAP_USERNAME`, `SAP_PASSWORD`
- Ensure the caller's profile includes write scopes

## HANA System Views Reference

| View | Purpose |
|------|---------|
| `SYS.SCHEMAS` | List schemas |
| `SYS.TABLES` | List tables |
| `SYS.VIEWS` | List views |
| `SYS.TABLE_COLUMNS` | Column metadata |
| `SYS.INDEXES` | Index information |
| `SYS.CONSTRAINTS` | Primary/foreign keys |
| `M_CS_TABLES` | Column store table stats (record counts) |

## License

MIT
