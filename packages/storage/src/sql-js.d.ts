declare module "sql.js" {
  export interface SqlJsStatement {
    bind(values?: unknown[] | Record<string, unknown>): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }

  export interface SqlJsDatabase {
    run(sql: string, params?: unknown[] | Record<string, unknown>): void;
    exec(sql: string, params?: unknown[] | Record<string, unknown>): Array<{
      columns: string[];
      values: unknown[][];
    }>;
    prepare(sql: string, params?: unknown[] | Record<string, unknown>): SqlJsStatement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsModule {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  }

  export interface SqlJsInitConfig {
    locateFile?: (file: string) => string;
  }

  const initSqlJs: (config?: SqlJsInitConfig) => Promise<SqlJsModule>;
  export default initSqlJs;
}
