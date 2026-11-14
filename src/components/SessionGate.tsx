import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';
import { CONFIG_REASON_TEXT, config } from '../lib/config';
import { Alert, Button, Spinner } from './ui';

/**
 * Wraps every screen that needs the database. There is intentionally no login
 * here: the session is created silently (Supabase Anonymous Auth). This gate only
 * shows (a) a spinner while that happens, (b) a clear setup notice if the
 * deployment has no Supabase credentials, or (c) a retryable error.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { status, error, retry } = useAuth();

  if (status === 'ready') return <>{children}</>;
  if (status === 'loading') return <Spinner label="Setting up your anonymous session…" />;

  if (status === 'unconfigured') {
    const reason = !config.configured ? CONFIG_REASON_TEXT[config.reason] : '';
    return (
      <div className="max-w-2xl space-y-4">
        <Alert tone="warning" title="Backend not configured">
          <p>{reason}</p>
          <p className="mt-2">
            This deployment has no Supabase connection, so tasks, credits and feedback cannot be loaded or saved. Nothing
            is mocked. The site owner needs to set <code className="rounded bg-amber-100 px-1">VITE_SUPABASE_URL</code> and{' '}
            <code className="rounded bg-amber-100 px-1">VITE_SUPABASE_ANON_KEY</code> and redeploy (see README → Setup).
          </p>
        </Alert>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Alert tone="error" title="Could not start your anonymous session">
        {error}
      </Alert>
      <Button variant="secondary" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
