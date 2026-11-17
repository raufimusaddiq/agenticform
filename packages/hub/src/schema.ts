import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Database } from "bun:sqlite"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  protocol_version INTEGER NOT NULL,
  harnesses TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  labels TEXT NOT NULL DEFAULT '{}',
  capacity_slots INTEGER NOT NULL DEFAULT 1,
  capacity_in_use INTEGER NOT NULL DEFAULT 0,
  inventory TEXT NOT NULL DEFAULT '[]',
  stale_observations INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_nonces (
  node_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, nonce)
);
CREATE INDEX IF NOT EXISTS request_nonces_expiry ON request_nonces(expires_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  harness TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  requires_json TEXT NOT NULL DEFAULT '[]',
  mcp_json TEXT NOT NULL DEFAULT '[]',
  labels_json TEXT NOT NULL DEFAULT '{}',
  git_backed INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  node_id TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  workspace_id TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  disconnected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_node ON runs(node_id);

CREATE TABLE IF NOT EXISTS runtime_assignments (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  runtime_type TEXT NOT NULL,
  runtime_session_id TEXT,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, generation)
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_id TEXT,
  leased_until INTEGER,
  result_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS commands_lease ON commands(node_id, status, created_at);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, key)
);
`

export const SCHEMA_VERSION = 1

/** Ordered migrations. Append a new entry and bump SCHEMA_VERSION for each change. */
export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: SCHEMA },
]

export function openDatabase(file: string): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  migrate(db)
  return db
}

/** Refuse a database written by a newer hub, then apply pending migrations (T008). */
export function migrate(db: Database): void {
  const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema version ${current} is newer than supported ${SCHEMA_VERSION}`)
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    const apply = db.transaction((): void => {
      db.exec(migration.sql)
      db.exec(`PRAGMA user_version = ${migration.version}`)
    })
    apply()
  }
}

export interface NodeRow {
  id: string
  name: string
  public_key: string
  status: string
  protocol_version: number
  harnesses: string
  capabilities: string
  labels: string
  capacity_slots: number
  capacity_in_use: number
  inventory: string
  stale_observations: number
  last_heartbeat_at: number | null
  created_at: number
}

export interface RunRow {
  id: string
  idempotency_key: string
  request_json: string
  harness: string
  prompt: string
  cwd: string
  requires_json: string
  mcp_json: string
  labels_json: string
  git_backed: number
  status: string
  node_id: string | null
  generation: number
  workspace_id: string
  result_json: string | null
  error_json: string | null
  disconnected_at: number | null
  created_at: number
  updated_at: number
}

export interface CommandRow {
  id: string
  run_id: string
  node_id: string
  type: string
  idempotency_key: string
  generation: number
  payload_json: string
  fingerprint: string
  status: string
  lease_id: string | null
  leased_until: number | null
  result_json: string | null
  error_json: string | null
  created_at: number
  updated_at: number
}

export interface EventRow {
  run_id: string
  seq: number
  key: string
  type: string
  at: string
  data_json: string
}
