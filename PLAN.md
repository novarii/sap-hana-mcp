# SAP HANA MCP Server - Implementation Plan

## Overview

Build a read-only MCP (Model Context Protocol) server that provides LLM access to an on-premises SAP HANA 2.00 SPS05 database with configurable schema visibility.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude/LLM     │────▶│  SAP HANA MCP    │────▶│  SAP HANA DB    │
│  Client         │◀────│  Server (stdio)  │◀────│  (On-Prem)      │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Defense-in-Depth Security Model

```
User Query
    ↓
[1] SQL Keyword Validator ─── Block dangerous keywords (DROP, INSERT, etc.)
    ↓
[2] Query Parser ─────────── Ensure single statement only
    ↓
[3] Parameterized Execution ─ Prevent SQL injection
    ↓
[4] DB User Privileges ────── SELECT-only database user (recommended)
    ↓
[5] Result Limits ─────────── Truncate large results, enforce row cap
    ↓
[6] Connection Recycling ──── Fresh connection per query (no state persistence)
```

## Technology Stack

| Component | Choice | Notes |
|-----------|--------|-------|
| Runtime | Node.js 18+ | LTS recommended |
| Language | TypeScript | Type safety |
| MCP SDK | `@modelcontextprotocol/sdk` v1.x | Production-ready (v2 is pre-alpha) |
| HANA Driver | `@sap/hana-client` | Official SAP driver, v2.25+ |
| Schema Validation | `zod` | Required by MCP SDK |
| Transport | stdio | Standard for CLI-based MCP servers |

## Configuration

Environment variables:

```env
# Required - Connection
HANA_HOST=your-hana-host.example.com
HANA_PORT=30015
HANA_USER=your_user
HANA_PASSWORD=your_password

# Optional - Schema Filtering
HANA_SCHEMA=              # Empty = all schemas, or specify single schema

# Optional - Security
HANA_ENCRYPT=true         # TLS encryption (recommended for on-prem)
HANA_SSL_VALIDATE_CERTIFICATE=true

# Optional - Safety Limits
HANA_ROW_LIMIT=1000       # Max rows per query result
HANA_MAX_RESULT_SIZE=5242880  # Max result size in bytes (5MB default)
HANA_QUERY_TIMEOUT=30000  # Query timeout in ms (30s default)
HANA_CONNECTION_TIMEOUT=5000  # Connection timeout in ms (5s default)
```

## MCP Tools to Implement

### 1. `list_schemas`
List all accessible schemas (or confirm configured schema).

```typescript
// Input: none
// Returns: Array of { schema_name, schema_owner }
// Respects HANA_SCHEMA config - if set, only returns that schema
```

**HANA Query:**
```sql
SELECT SCHEMA_NAME, SCHEMA_OWNER
FROM SYS.SCHEMAS
WHERE HAS_PRIVILEGES = 'TRUE'
ORDER BY SCHEMA_NAME
```

### 2. `list_tables`
List tables in a schema.

```typescript
// Input: { schema?: string }
// Returns: Array of { table_name, table_type, record_count }
```

**HANA Query:**
```sql
SELECT TABLE_NAME, TABLE_TYPE, RECORD_COUNT
FROM SYS.TABLES
WHERE SCHEMA_NAME = ?
ORDER BY TABLE_NAME
```

### 3. `list_views`
List views in a schema.

```typescript
// Input: { schema?: string }
// Returns: Array of { view_name, view_type }
```

**HANA Query:**
```sql
SELECT VIEW_NAME, VIEW_TYPE
FROM SYS.VIEWS
WHERE SCHEMA_NAME = ?
ORDER BY VIEW_NAME
```

### 4. `describe_table`
Get detailed column information for a table or view.

```typescript
// Input: { schema?: string, table: string }
// Returns: { columns, indexes, constraints }
```

**HANA Query:**
```sql
-- Columns
SELECT
  COLUMN_NAME,
  DATA_TYPE_NAME,
  LENGTH,
  SCALE,
  IS_NULLABLE,
  DEFAULT_VALUE,
  POSITION,
  COMMENTS
FROM SYS.TABLE_COLUMNS
WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
ORDER BY POSITION;

-- Primary Key
SELECT COLUMN_NAME, POSITION
FROM SYS.CONSTRAINTS
WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? AND IS_PRIMARY_KEY = 'TRUE'
ORDER BY POSITION;

-- Indexes
SELECT INDEX_NAME, INDEX_TYPE, CONSTRAINT
FROM SYS.INDEXES
WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?;
```

### 5. `execute_query`
Execute a read-only SQL query with safety controls.

```typescript
// Input: { query: string }
// Returns: { columns: string[], rows: any[], row_count: number, truncated: boolean }
```

**Safety Implementation:**
```typescript
// Blocked keywords - checked BEFORE execution
const BLOCKED_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER',
  'TRUNCATE', 'GRANT', 'REVOKE', 'MERGE', 'UPSERT',
  'CALL',  // Block stored procedure calls
  'EXEC', 'EXECUTE',
  'BEGIN', 'COMMIT', 'ROLLBACK',  // Transaction control
  'SET',  // Session variable changes
];

// Must start with SELECT or WITH (for CTEs)
const ALLOWED_PREFIXES = ['SELECT', 'WITH'];

function validateQuery(sql: string): void {
  const normalized = sql.toUpperCase().trim();

  // Check starts with allowed prefix
  if (!ALLOWED_PREFIXES.some(p => normalized.startsWith(p))) {
    throw new Error('Only SELECT queries are allowed');
  }

  // Check for blocked keywords
  for (const keyword of BLOCKED_KEYWORDS) {
    // Use word boundary matching to avoid false positives
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(sql)) {
      throw new Error(`Blocked keyword detected: ${keyword}`);
    }
  }

  // Check for multiple statements (semicolon followed by non-whitespace)
  if (/;\s*\S/.test(sql)) {
    throw new Error('Multiple statements not allowed');
  }
}
```

### 6. `get_table_sample`
Get sample data from a table.

```typescript
// Input: { schema?: string, table: string, limit?: number }
// Returns: Sample rows from the table (default 10 rows)
```

**HANA Query:**
```sql
SELECT TOP ? * FROM "{schema}"."{table}"
```

### 7. `explain_query`
Get query execution plan.

```typescript
// Input: { query: string }
// Returns: Execution plan details
```

**HANA Query:**
```sql
EXPLAIN PLAN FOR {query}
```

## Project Structure

```
sap-hana-mcp/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── src/
│   ├── index.ts              # Entry point, MCP server setup
│   ├── config.ts             # Configuration from env vars
│   ├── hana/
│   │   ├── client.ts         # Connection management (create/close per query)
│   │   ├── types.ts          # HANA-specific types
│   │   └── queries.ts        # Pre-built query templates
│   ├── tools/
│   │   ├── index.ts          # Tool registration
│   │   ├── list-schemas.ts
│   │   ├── list-tables.ts
│   │   ├── list-views.ts
│   │   ├── describe-table.ts
│   │   ├── execute-query.ts
│   │   ├── get-sample.ts
│   │   └── explain-query.ts
│   ├── security/
│   │   ├── query-validator.ts  # SQL validation (blocked keywords, single statement)
│   │   └── result-limiter.ts   # Row/size truncation
│   └── utils/
│       └── logger.ts
└── dist/                      # Compiled output
```

## Implementation Steps

### Phase 1: Project Setup
1. Initialize npm project with TypeScript
2. Configure SAP npm registry: `npm config set @sap:registry https://npm.sap.com`
3. Install dependencies:
   ```bash
   npm install @modelcontextprotocol/sdk zod dotenv
   npm install @sap/hana-client
   npm install -D typescript @types/node
   ```
4. Configure tsconfig.json
5. Set up npm scripts: `build`, `start`, `dev`

### Phase 2: Security Layer
1. Implement `query-validator.ts`:
   - Blocked keyword detection
   - Single statement enforcement
   - SELECT/WITH prefix validation
2. Implement `result-limiter.ts`:
   - Row count limiting
   - Result size truncation
3. Unit tests for security functions

### Phase 3: HANA Connection Layer
1. Implement connection factory (fresh connection per request)
2. Add connection timeout handling
3. Implement query timeout via HANA session variables
4. Handle connection errors gracefully
5. Connection recycling (close after each tool execution)

### Phase 4: Core Schema Tools
1. Implement `list_schemas` - uses SYS.SCHEMAS
2. Implement `list_tables` - uses SYS.TABLES
3. Implement `list_views` - uses SYS.VIEWS
4. Implement `describe_table` - uses SYS.TABLE_COLUMNS + SYS.INDEXES

### Phase 5: Query Execution Tools
1. Implement `execute_query`:
   - Validate query through security layer
   - Execute with timeout
   - Apply result limits
   - Return structured response
2. Implement `get_table_sample`
3. Implement `explain_query`

### Phase 6: MCP Server Integration
1. Create McpServer instance
2. Register all tools with zod schemas
3. Set up stdio transport
4. Add graceful shutdown handling

### Phase 7: Testing & Documentation
1. Manual testing with Claude Desktop
2. Test security edge cases (injection attempts)
3. Write README with:
   - Installation instructions
   - Configuration options
   - Claude Desktop setup
   - Security notes

## Claude Desktop Configuration

After building, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sap-hana": {
      "command": "node",
      "args": ["/path/to/sap-hana-mcp/dist/index.js"],
      "env": {
        "HANA_HOST": "your-host",
        "HANA_PORT": "30015",
        "HANA_USER": "your-user",
        "HANA_PASSWORD": "your-password",
        "HANA_SCHEMA": "",
        "HANA_ENCRYPT": "true",
        "HANA_ROW_LIMIT": "1000",
        "HANA_QUERY_TIMEOUT": "30000"
      }
    }
  }
}
```

## Security Considerations

### 1. Multi-Layer Read-Only Enforcement

| Layer | Implementation | Purpose |
|-------|----------------|---------|
| Keyword Blocking | Regex check for INSERT, UPDATE, DELETE, DROP, etc. | First line of defense |
| Statement Parsing | Block multiple statements (`;` followed by content) | Prevent injection |
| Prefix Validation | Only allow SELECT or WITH at start | Whitelist approach |
| DB User Privileges | Use HANA user with SELECT-only grants | Database-level protection |
| Connection Recycling | Fresh connection per query | Prevent session state attacks |

### 2. Resource Protection

| Control | Default | Purpose |
|---------|---------|---------|
| Row Limit | 1000 | Prevent memory exhaustion |
| Result Size | 5MB | Prevent large payload issues |
| Query Timeout | 30s | Prevent long-running queries |
| Connection Timeout | 5s | Fail fast on connection issues |

### 3. Credential Security
- Environment variables only (never in code)
- Support for encrypted connections (TLS)
- Recommend dedicated read-only HANA user

### 4. Known Attack Vectors Mitigated

| Attack | Mitigation |
|--------|------------|
| SQL Injection via multi-statement | Block `;` followed by content |
| Transaction manipulation | Block BEGIN, COMMIT, ROLLBACK |
| Privilege escalation | Block GRANT, SET, EXEC |
| Data modification | Block INSERT, UPDATE, DELETE, MERGE |
| Schema manipulation | Block CREATE, ALTER, DROP, TRUNCATE |

## SAP HANA System Views Reference

| View | Purpose |
|------|---------|
| `SYS.SCHEMAS` | List schemas with privileges |
| `SYS.TABLES` | List tables with record counts |
| `SYS.VIEWS` | List views |
| `SYS.TABLE_COLUMNS` | Column metadata |
| `SYS.VIEW_COLUMNS` | View column metadata |
| `SYS.INDEXES` | Index information |
| `SYS.CONSTRAINTS` | Constraint definitions (PK, FK, unique) |
| `SYS.PROCEDURES` | Stored procedures (for future reference) |

## Future Enhancements

1. **Write support**: Add mutation tools with explicit confirmation workflow
2. **Stored procedure calls**: Allow calling read-only procedures
3. **Calculation view support**: Query CDS/calculation views
4. **Connection pooling**: For high-frequency usage scenarios
5. **Query history/caching**: Performance optimization
6. **Multi-tenant support**: Multiple HANA connections

---

## References

- [MCP TypeScript SDK v1.x](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
- [MCP Specification](https://modelcontextprotocol.io)
- [@sap/hana-client npm](https://www.npmjs.com/package/@sap/hana-client)
- [SAP HANA System Views](https://help.sap.com/docs/SAP_HANA_PLATFORM/4fe29514fd584807ac9f2a04f6754767/20cbb10c75191014b47ba845bfe499fe.html)
- [Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp) - Reference implementation
- [SQL Injection in MCP Servers](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/) - Security research
