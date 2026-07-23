import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { CachePlugin } from "./cache-plugin.js";

export interface SqliteCacheOptions {
  /**
   * Table name. Lets several independent caches share one database file — each
   * subsystem picks its own table. Defaults to `"cache"`.
   */
  table?: string;
}

/**
 * Generic SQLite-backed cache (via `better-sqlite3`, already in the dependency
 * tree). Stores each value as one `(key, value)` row, with `value` JSON-encoded.
 * Nothing here is tool-specific — see `./index.ts` for the tool-result consumer.
 *
 * WAL mode lets concurrent callers read while one writes. Both reads and writes
 * are **fail-open**: any error (open, query, parse) degrades to a miss (get) or
 * a silent no-op (set) so the cache can never break its caller.
 *
 * @typeParam V - the stored value type (defaults to `unknown`).
 */
export class SqliteCachePlugin<V = unknown> implements CachePlugin<V> {
  private readonly dbPath: string;
  private readonly table: string;
  private conn?: {
    db: Database.Database;
    get: Database.Statement;
    set: Database.Statement;
    del: Database.Statement;
  };

  constructor(dbPath: string, options: SqliteCacheOptions = {}) {
    this.dbPath = dbPath;
    // Table name is an internal identifier; keep it to a safe charset.
    this.table = (options.table ?? "cache").replace(/[^A-Za-z0-9_]/g, "_");
  }

  /** Open the DB (once), apply pragmas, ensure the table, and prepare statements. */
  private ready() {
    if (!this.conn) {
      mkdirSync(path.dirname(this.dbPath), { recursive: true });
      const db = new Database(this.dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );`,
      );
      this.conn = {
        db,
        get: db.prepare(`SELECT value FROM ${this.table} WHERE key = ?`),
        set: db.prepare(
          `INSERT OR REPLACE INTO ${this.table} (key, value) VALUES (?, ?)`,
        ),
        del: db.prepare(`DELETE FROM ${this.table} WHERE key = ?`),
      };
    }
    return this.conn;
  }

  async get(key: string): Promise<V | undefined> {
    try {
      const row = this.ready().get.get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as V) : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: V): Promise<void> {
    try {
      this.ready().set.run(key, JSON.stringify(value));
    } catch {
      // Fail-open: a failed write just means the next call recomputes the value.
    }
  }

  async delete(key: string): Promise<void> {
    try {
      this.ready().del.run(key);
    } catch {
      // ignore
    }
  }

  async clear(): Promise<void> {
    try {
      this.ready().db.exec(`DELETE FROM ${this.table}`);
    } catch {
      // ignore
    }
  }

  /** Close the underlying handle. Mainly for tests; the process can also just exit. */
  close(): void {
    try {
      this.conn?.db.close();
    } finally {
      this.conn = undefined;
    }
  }
}
