import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

import { env } from "./env";

export const pool = new Pool({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

export async function healthCheck(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("select 1");
    return true;
  } finally {
    client.release();
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
