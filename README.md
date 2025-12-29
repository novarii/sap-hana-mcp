# SAP HANA MCP Server

A Model Context Protocol (MCP) server providing read-only access to SAP HANA databases. Enables LLMs like Claude to query your HANA database, explore schemas, and analyze data.

## Features

- **Read-only access** - Only SELECT queries allowed (enforced at app + DB level)
- **Schema introspection** - List schemas, tables, views, and column details
- **Configurable schema restriction** - Limit access to a single schema
- **Safety controls** - Row limits, query timeouts, blocked dangerous keywords
- **SAP HANA 2.0 SPS05+** compatible

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd sap-hana-mcp

# Configure SAP npm registry (required for @sap/hana-client)
npm config set @sap:registry https://npm.sap.com

# Install dependencies
pnpm install

# Build
pnpm build
```

## Configuration

### Environment Variables

Create a `.env` file or configure via `.mcp.json`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HANA_HOST` | Yes | - | HANA server hostname or IP |
| `HANA_PORT` | No | 30015 | HANA port (3\<instance\>15) |
| `HANA_USER` | Yes | - | Database username |
| `HANA_PASSWORD` | Yes | - | Database password |
| `HANA_SCHEMA` | No | - | Restrict to single schema (empty = all) |
| `HANA_ENCRYPT` | No | true | Enable TLS encryption |
| `HANA_SSL_VALIDATE_CERTIFICATE` | No | true | Validate SSL certificate |
| `HANA_ROW_LIMIT` | No | 1000 | Max rows per query |
| `HANA_QUERY_TIMEOUT` | No | 30000 | Query timeout (ms) |
| `HANA_CONNECTION_TIMEOUT` | No | 5000 | Connection timeout (ms) |

### Claude Code Setup

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "sap-hana": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/sap-hana-mcp/dist/index.js"],
      "env": {
        "HANA_HOST": "192.168.0.150",
        "HANA_PORT": "30015",
        "HANA_USER": "MCP_READER",
        "HANA_PASSWORD": "your_password",
        "HANA_SCHEMA": "YOUR_SCHEMA",
        "HANA_ENCRYPT": "false",
        "HANA_SSL_VALIDATE_CERTIFICATE": "false",
        "HANA_ROW_LIMIT": "1000"
      }
    }
  }
}
```

Or add via CLI:

```bash
claude mcp add sap-hana --transport stdio \
  --env HANA_HOST=192.168.0.150 \
  --env HANA_PORT=30015 \
  --env HANA_USER=MCP_READER \
  --env HANA_PASSWORD=your_password \
  --env HANA_SCHEMA=YOUR_SCHEMA \
  --env HANA_ENCRYPT=false \
  -- node /path/to/sap-hana-mcp/dist/index.js
```

## Available Tools

| Tool | Description |
|------|-------------|
| `list_schemas` | List all accessible database schemas |
| `list_tables` | List tables in a schema with record counts |
| `list_views` | List views in a schema |
| `describe_table` | Get columns, primary keys, indexes, foreign keys |
| `execute_query` | Execute read-only SELECT queries |
| `get_table_sample` | Get sample rows from a table |

### Example Usage

```
> List all tables in the schema
> Describe the CUSTOMERS table
> Show me the top 10 orders by date
> SELECT * FROM ORDERS WHERE STATUS = 'OPEN'
```

## Security Model

### Defense-in-Depth Architecture

```
User Query
    ↓
[1] SQL Keyword Validator ─── Block INSERT, UPDATE, DELETE, DROP, etc.
    ↓
[2] Query Parser ─────────── Ensure single statement only (no injection)
    ↓
[3] Prefix Validation ────── Must start with SELECT, WITH, or EXPLAIN
    ↓
[4] DB User Privileges ────── SELECT-only grants (recommended)
    ↓
[5] Result Limits ─────────── Row count and size limits
    ↓
[6] Connection Recycling ──── Fresh connection per query
```

### Blocked Keywords

```
INSERT, UPDATE, DELETE, MERGE, UPSERT, REPLACE
CREATE, ALTER, DROP, TRUNCATE, RENAME
GRANT, REVOKE, CALL, EXEC, EXECUTE
BEGIN, COMMIT, ROLLBACK, SAVEPOINT, SET
IMPORT, EXPORT, LOAD, UNLOAD
```

### Recommended: Create a Read-Only Database User

Instead of using `SYSTEM`, create a dedicated user:

```sql
-- Connect as SYSTEM
hdbsql -i 00 -u SYSTEM

-- Create read-only user
CREATE USER MCP_READER PASSWORD "YourSecurePassword";

-- Grant SELECT on specific schema only
GRANT SELECT ON SCHEMA YOUR_SCHEMA TO MCP_READER;

-- Prevent password expiration (optional)
ALTER USER MCP_READER DISABLE PASSWORD LIFETIME;
```

This provides database-level security - even if the app layer is bypassed, HANA will reject unauthorized operations.

## Development

```bash
# Run in development mode (with hot reload)
pnpm dev

# Build for production
pnpm build

# Run production build
pnpm start
```

### Project Structure

```
sap-hana-mcp/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── config.ts             # Environment configuration
│   ├── hana/
│   │   └── client.ts         # HANA connection management
│   ├── security/
│   │   └── query-validator.ts # SQL validation
│   └── tools/
│       └── index.ts          # MCP tool implementations
├── dist/                     # Compiled output
├── package.json
├── tsconfig.json
└── .env.example
```

## Troubleshooting

### Authentication Failed

- Verify username/password
- Check if user exists: `SELECT USER_NAME FROM SYS.USERS WHERE USER_NAME = 'MCP_READER'`
- Special characters in password? Use single quotes in shell: `hdbsql -u SYSTEM -p 'pass!!word'`

### Connection Refused

- Verify HANA is running: `ssh user@host "HDB info"`
- Check port: Default is `30015` for instance `00`, `30115` for instance `01`
- Firewall blocking? Test: `telnet <host> <port>`

### Permission Denied on Query

- Check grants: `SELECT * FROM GRANTED_PRIVILEGES WHERE GRANTEE = 'MCP_READER'`
- Ensure SELECT granted on schema: `GRANT SELECT ON SCHEMA <schema> TO MCP_READER`

### Query Validation Failed

- Only SELECT, WITH, EXPLAIN queries allowed
- Check for blocked keywords (INSERT, UPDATE, etc.)
- Multi-statement queries not allowed (no semicolons between statements)

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
