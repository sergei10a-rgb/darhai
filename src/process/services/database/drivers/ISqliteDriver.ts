// src/process/services/database/drivers/ISqliteDriver.ts

export interface IStatement {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface ISqliteDriver {
  prepare(sql: string): IStatement;
  exec(sql: string): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
  close(): void;
  /**
   * Load a native SQLite loadable extension from an absolute path (e.g.
   * sqlite-vec's `vec0`). Optional: drivers that cannot load extensions (or a
   * runtime where extensions are disabled) should throw so callers can fall
   * back to a non-vector code path. Present on drivers that support it.
   */
  loadExtension?(path: string): void;
}
