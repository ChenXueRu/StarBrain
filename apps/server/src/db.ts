import { DatabaseSync } from 'node:sqlite'

// 依序套用；第 N 個項目會把 user_version 升到 N。已發佈的項目不可修改，只能在尾端新增
export const migrations: string[] = [
  `
  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE star_groups (
    id TEXT PRIMARY KEY,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
    name TEXT NOT NULL,
    description TEXT,
    parent_id TEXT REFERENCES star_groups(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE stars (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    goal TEXT,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    group_id TEXT REFERENCES star_groups(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE records (
    id TEXT PRIMARY KEY,
    star_id TEXT NOT NULL REFERENCES stars(id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL,
    problem TEXT NOT NULL,
    awareness TEXT,
    idea TEXT,
    mindset TEXT,
    thinking TEXT,
    viewpoint TEXT,
    conclusion TEXT,
    outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('success', 'failure', 'unknown')),
    mode TEXT NOT NULL DEFAULT 'active' CHECK (mode IN ('active', 'background')),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_records_star_id ON records(star_id);
  CREATE INDEX idx_records_occurred_at ON records(occurred_at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE ideas (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    done_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'hub')),
    source_ref TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_ideas_created_at ON ideas(created_at);
  `,
  `
  ALTER TABLE records ADD COLUMN client_ref TEXT;
  ALTER TABLE ideas ADD COLUMN client_ref TEXT;
  CREATE UNIQUE INDEX idx_records_client_ref ON records(client_ref);
  CREATE UNIQUE INDEX idx_ideas_client_ref ON ideas(client_ref);
  `,
]

export const SCHEMA_VERSION = migrations.length

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  try {
    migrate(db)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

function migrate(db: DatabaseSync) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const current = row.user_version
  if (current > SCHEMA_VERSION) {
    throw new Error(`資料庫版本 ${current} 比程式支援的版本 ${SCHEMA_VERSION} 新，請先更新 StarBrain`)
  }
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    transaction(db, () => {
      db.exec(migrations[version - 1])
      db.exec(`PRAGMA user_version = ${version}`)
    })
  }
}

// node:sqlite 沒有內建 transaction 包裝；失敗時整段回復
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 交易已被 SQLite 自動結束時，ROLLBACK 會失敗，可忽略
    }
    throw err
  }
}
