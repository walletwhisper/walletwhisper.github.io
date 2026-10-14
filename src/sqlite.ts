import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase, SqlJsStatic, SqlValue, Statement as SqlJsStatement } from 'sql.js';

/**
 * SQLite running in WebAssembly (sql.js), so WalletWhisper needs no server: the database lives
 * in the browser's memory and is saved to the browser's own storage (see client/src/local).
 *
 * This wraps sql.js in the small synchronous API the engine uses (prepare/run/get/all, exec,
 * pragma, transaction), so the same engine code runs in the browser and in the tests (Node).
 */

let SQL: SqlJsStatic | null = null;

/** Load the SQLite WebAssembly module once. In the browser, pass the URL of sql-wasm.wasm. */
export async function initSqlite(wasmUrl?: string): Promise<void> {
  if (SQL) return;
  SQL = await initSqlJs(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
}

/** A value to bind: string, number, bigint, Uint8Array or null (undefined → null, boolean → 0/1). */
type Param = unknown;
export interface RunResult { changes: number; lastInsertRowid: number }

export interface Statement {
  run(...params: Param[]): RunResult;
  get(...params: Param[]): unknown;
  all(...params: Param[]): unknown[];
}

const bindable = (params: Param[]): SqlValue[] =>
  params.map(p => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p) as SqlValue);

export class Db {
  private raw: SqlJsDatabase;
  /** Compiled statements, reused until the database is exported (which closes them). */
  private cache = new Map<string, SqlJsStatement>();
  private depth = 0;
  readonly memory = true;

  constructor(data?: Uint8Array) {
    if (!SQL) throw new Error('SQLite is not loaded yet (call initSqlite first)');
    this.raw = new SQL.Database(data);
  }

  private compiled(sql: string): SqlJsStatement {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  prepare(sql: string): Statement {
    const rows = (params: Param[], limit = Infinity) => {
      const stmt = this.compiled(sql);
      const out: Record<string, SqlValue>[] = [];
      try {
        stmt.bind(bindable(params));
        while (out.length < limit && stmt.step()) out.push(stmt.getAsObject());
      } finally {
        stmt.reset();
      }
      return out;
    };
    return {
      run: (...params) => {
        const stmt = this.compiled(sql);
        stmt.bind(bindable(params));
        try { while (stmt.step()) { /* drain */ } } finally { stmt.reset(); }
        return { changes: this.raw.getRowsModified(), lastInsertRowid: this.scalar('SELECT last_insert_rowid()') as number };
      },
      get: (...params) => rows(params, 1)[0],
      all: (...params) => rows(params),
    };
  }

  private scalar(sql: string): SqlValue {
    return this.raw.exec(sql)[0]?.values[0]?.[0] ?? null;
  }

  /** Run one or more statements with no parameters. */
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** `pragma('user_version', { simple: true })` returns the value; `pragma('foreign_keys = ON')` sets one. */
  pragma(text: string, opts?: { simple?: boolean }): unknown {
    const res = this.raw.exec(`PRAGMA ${text}`)[0];
    if (opts?.simple) return res?.values[0]?.[0];
    return (res?.values ?? []).map(v => Object.fromEntries(res!.columns.map((c, i) => [c, v[i]])));
  }

  /** Like better-sqlite3: returns a function that runs `fn` in a transaction (nested calls use savepoints). */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      const name = `sp${this.depth}`;
      this.raw.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (err) {
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw err;
      }
    };
  }

  /** The whole database as bytes (a normal SQLite file). */
  export(): Uint8Array {
    for (const stmt of this.cache.values()) stmt.free();
    this.cache.clear();
    const bytes = this.raw.export(); // sql.js closes and reopens the database, which resets pragmas
    this.raw.exec('PRAGMA foreign_keys = ON');
    return bytes;
  }

  close(): void {
    for (const stmt of this.cache.values()) stmt.free();
    this.cache.clear();
    this.raw.close();
  }
}
