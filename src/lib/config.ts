// Reads and validates build-time Supabase settings.
//
// Both values are PUBLIC by design (they ship in the bundle; Row Level Security
// is what protects data). The one thing that must never appear here is a
// service_role / secret key, so we detect and refuse it.

export type AppConfig =
  | { configured: true; url: string; anonKey: string }
  | { configured: false; reason: 'missing' | 'placeholder' | 'bad_url' | 'secret_key' };

function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const role = (JSON.parse(json) as { role?: unknown }).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

function readConfig(): AppConfig {
  const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

  if (!url || !anonKey) return { configured: false, reason: 'missing' };
  if (/YOUR-/i.test(url) || /YOUR-/i.test(anonKey)) return { configured: false, reason: 'placeholder' };

  if (anonKey.startsWith('sb_secret_') || jwtRole(anonKey) === 'service_role') {
    return { configured: false, reason: 'secret_key' };
  }

  try {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
      return { configured: false, reason: 'bad_url' };
    }
  } catch {
    return { configured: false, reason: 'bad_url' };
  }

  return { configured: true, url: url.replace(/\/+$/, ''), anonKey };
}

export const config: AppConfig = readConfig();

export const CONFIG_REASON_TEXT: Record<Exclude<AppConfig, { configured: true }>['reason'], string> = {
  missing: 'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set.',
  placeholder: 'The Supabase environment values are still the placeholders from .env.example.',
  bad_url: 'VITE_SUPABASE_URL is not a valid https URL.',
  secret_key:
    'A secret / service_role key was found in VITE_SUPABASE_ANON_KEY. The app refuses to run with it — use the public anon/publishable key instead, and rotate the leaked one.',
};
