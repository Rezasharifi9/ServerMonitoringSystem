// The project's Node 20 type package predates the built-in SQLite module.
declare module "node:sqlite" {
  type Value = string | number | bigint | Uint8Array | null;
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      get(...args: Value[]): Record<string, Value> | undefined;
      all(...args: Value[]): Record<string, Value>[];
      run(...args: Value[]): { changes: number | bigint };
    };
  }
}
