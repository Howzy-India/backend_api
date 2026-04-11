import { AuthTypes, Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { Pool, PoolClient, QueryResultRow } from "pg";

let _pool: Pool | null = null;
let _connector: Connector | null = null;

async function getPool(): Promise<Pool> {
  if (_pool) return _pool;

  _connector = new Connector();

  // Use IAM authentication — no password required when running inside Cloud Functions
  // (the runtime service account is auto-authenticated via ADC)
  const clientOpts = await _connector.getOptions({
    instanceConnectionName: process.env.CLOUD_SQL_INSTANCE!.trim(),
    ipType: IpAddressTypes.PUBLIC,
    authType: AuthTypes.IAM,
  });

  _pool = new Pool({
    ...clientOpts,
    database: process.env.DB_NAME?.trim(),
    // IAM user format: SA email without the .gserviceaccount.com suffix
    user: process.env.DB_USER?.trim(),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  _pool.on("error", (err) => {
    console.error("[db] Idle client error:", err.message);
  });

  // Idempotent migration: rename bhk_count INT → bhk_type TEXT in configurations
  try {
    const client = await _pool.connect();
    try {
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'configurations' AND column_name = 'bhk_count'
          ) THEN
            ALTER TABLE configurations RENAME COLUMN bhk_count TO bhk_type;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'configurations' AND column_name = 'bhk_type'
              AND data_type = 'integer'
          ) THEN
            ALTER TABLE configurations ALTER COLUMN bhk_type TYPE TEXT USING bhk_type::TEXT;
          END IF;
        END $$;
      `);
    } finally {
      client.release();
    }
  } catch (migErr) {
    console.error("[db] Migration warning:", migErr);
  }

  return _pool;
}

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const pool = await getPool();
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

// Run multiple queries atomically in a transaction
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
