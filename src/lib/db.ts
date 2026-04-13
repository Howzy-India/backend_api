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

  // Idempotent migration: ensure configurations.bhk_count INT exists
  // Handles legacy states where column was renamed to bhk_type
  try {
    const client = await _pool.connect();
    try {
      await client.query(`
        DO $$
        BEGIN
          -- If renamed to bhk_type, rename back to bhk_count
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'configurations' AND column_name = 'bhk_type'
          ) THEN
            ALTER TABLE configurations RENAME COLUMN bhk_type TO bhk_count;
          END IF;
          -- If bhk_count is TEXT (from prior migration), cast back to INT
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'configurations' AND column_name = 'bhk_count'
              AND data_type = 'text'
          ) THEN
            ALTER TABLE configurations ALTER COLUMN bhk_count TYPE INT USING bhk_count::INT;
          END IF;
          -- If neither exists, add bhk_count INT
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'configurations' AND column_name = 'bhk_count'
          ) THEN
            ALTER TABLE configurations ADD COLUMN bhk_count INT;
          END IF;
          -- Ensure project_amenities has unique constraint for ON CONFLICT support
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_schema = 'public' AND table_name = 'project_amenities'
              AND constraint_type = 'UNIQUE'
          ) THEN
            ALTER TABLE project_amenities ADD CONSTRAINT project_amenities_project_id_amenity_key UNIQUE (project_id, amenity);
          END IF;
          -- Add rejection_reason column for project approval workflow
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'rejection_reason'
          ) THEN
            ALTER TABLE projects ADD COLUMN rejection_reason TEXT;
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
