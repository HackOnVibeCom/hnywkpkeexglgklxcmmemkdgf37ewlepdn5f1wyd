import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Decode a JWT payload's `role` claim without verifying it (we only need to recognise service_role). */
function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

/**
 * Fails the build if a Supabase secret / service_role key is about to be inlined into the
 * public bundle. (The app also refuses it at runtime, but by then it would already be shipped.)
 */
function forbidSecretKeys(mode: string): Plugin {
  return {
    name: 'peerprobe-forbid-secret-keys',
    buildStart() {
      const env = loadEnv(mode, process.cwd(), 'VITE_');
      for (const [name, value] of Object.entries(env)) {
        const v = value.trim();
        if (v.startsWith('sb_secret_') || jwtRole(v) === 'service_role') {
          this.error(
            `${name} contains a Supabase secret/service_role key. Only the public anon/publishable key may be exposed to the browser. Remove it, and rotate the key if it was ever committed.`,
          );
        }
      }
    },
  };
}

// Output goes to dist/ (Vite default) — the first folder the HackOnVibe
// deploy workflow looks for. Do not change outDir.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), forbidSecretKeys(mode)],
}));
