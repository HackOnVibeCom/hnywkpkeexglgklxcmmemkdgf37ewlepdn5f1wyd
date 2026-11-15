import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

let client: SupabaseClient | null = null;

/** Lazily creates the browser client. Throws if the app is not configured. */
export function getSupabase(): SupabaseClient {
  if (!config.configured) throw new Error('Supabase is not configured');
  if (!client) {
    client = createClient(config.url, config.anonKey, {
      auth: {
        // The anonymous session token lives in this browser's storage. It is only
        // an identity handle — balances, tasks and feedback live in Postgres.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}
