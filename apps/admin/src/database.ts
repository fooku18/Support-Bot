import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { settingsSchema } from './settings-schema.js';

export type SettingsDatabaseConfig = { path: string } | { connectionString: string };
export type Row = Record<string, unknown>;
type Parameter = string | number | null;
type Result = { rows: Row[]; changes: number };
type Query = (sql: string, ...parameters: Parameter[]) => Promise<Result>;
type Transaction = { query: Query; afterCommit: Array<() => void> };

// Schema changes, compiled policy and command receipts share a write boundary.
async function beginSettingsTransaction(client: pg.Client | pg.PoolClient): Promise<void> {
  // Statements after lock acquisition must see the previous owner's commit.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query('SELECT pg_advisory_xact_lock(17280, 18040)');
}

function postgresQuery(client: pg.Pool | pg.PoolClient): Query {
  return async (sql, ...parameters) => {
    // Store queries are static SQL and use question marks only for parameters.
    let index = 0;
    const result = await client.query<Row>(
      sql.replace(/\?/g, () => `$${++index}`),
      parameters,
    );
    return { rows: result.rows, changes: result.rowCount ?? 0 };
  };
}

export class SettingsDatabase {
  readonly loginFailureId: 'id' | 'rowid';
  private readonly sqlite?: DatabaseSync;
  private readonly postgres?: pg.Pool;
  private readonly transactionContext = new AsyncLocalStorage<Transaction>();
  private readonly queryOutsideTransaction: Query;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(config: SettingsDatabaseConfig) {
    if ('connectionString' in config) {
      this.loginFailureId = 'id';
      this.postgres = new pg.Pool({
        connectionString: config.connectionString,
        connectionTimeoutMillis: 5_000,
        types: {
          getTypeParser(oid, format) {
            if (oid !== pg.types.builtins.INT8 || format === 'binary')
              return pg.types.getTypeParser(oid, format);
            return (value: string) => {
              const number = Number(value);
              if (!Number.isSafeInteger(number)) throw new Error('settings integer out of range');
              return number;
            };
          },
        },
      });
      this.postgres.on('error', (error) => {
        console.error(`idle settings database connection failed: ${error.name}`);
      });
      this.queryOutsideTransaction = postgresQuery(this.postgres);
    } else {
      this.loginFailureId = 'rowid';
      if (config.path !== ':memory:') mkdirSync(path.dirname(config.path), { recursive: true });
      const sqlite = new DatabaseSync(config.path);
      try {
        sqlite.exec(
          'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 500; PRAGMA foreign_keys = ON;',
        );
        sqlite.exec(settingsSchema('sqlite'));
      } catch (error) {
        sqlite.close();
        throw error;
      }
      this.sqlite = sqlite;
      this.queryOutsideTransaction = async (sql, ...parameters) => {
        const statement = sqlite.prepare(sql);
        if (statement.columns().length) {
          const rows = statement.all(...parameters);
          return { rows, changes: rows.length };
        }
        return { rows: [], changes: Number(statement.run(...parameters).changes) };
      };
    }
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const current = this.pending.then(run);
    this.pending = current.catch(() => undefined);
    return current;
  }

  query(sql: string, ...parameters: Parameter[]): Promise<Result> {
    const transaction = this.transactionContext.getStore();
    if (transaction) return transaction.query(sql, ...parameters);
    if (this.sqlite) return this.serialize(() => this.queryOutsideTransaction(sql, ...parameters));
    return this.queryOutsideTransaction(sql, ...parameters);
  }

  afterCommit(effect: () => void): void {
    const transaction = this.transactionContext.getStore();
    if (transaction) transaction.afterCommit.push(effect);
    else queueMicrotask(effect);
  }

  async transaction<T>(change: () => T | Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return change();
    const sqlite = this.sqlite;
    if (sqlite) {
      return this.serialize(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        const transaction: Transaction = { query: this.queryOutsideTransaction, afterCommit: [] };
        let result: T;
        try {
          result = await this.transactionContext.run(transaction, change);
          sqlite.exec('COMMIT');
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
        for (const effect of transaction.afterCommit) queueMicrotask(effect);
        return result;
      });
    }
    const client = await this.postgres!.connect();
    let discard = false;
    const transaction: Transaction = { query: postgresQuery(client), afterCommit: [] };
    try {
      await beginSettingsTransaction(client);
      const result = await this.transactionContext.run(transaction, change);
      await client.query('COMMIT');
      for (const effect of transaction.afterCommit) queueMicrotask(effect);
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async close(): Promise<void> {
    if (this.sqlite) await this.serialize(async () => this.sqlite!.close());
    else await this.postgres!.end();
  }
}

/** Run as the schema owner before starting the settings service. */
export async function provisionSettingsDatabase(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await beginSettingsTransaction(client);
    await client.query(settingsSchema('postgres'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
