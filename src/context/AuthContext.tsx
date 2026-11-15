import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { config } from '../lib/config';
import { getSupabase } from '../lib/supabase';
import { friendlyError } from '../lib/api';
import { claimStoredReferral } from '../lib/referral';
import { getCaptchaToken } from '../lib/turnstile';
import type { Profile } from '../lib/types';

type Status = 'unconfigured' | 'loading' | 'ready' | 'error';

interface AuthState {
  status: Status;
  error: string | null;
  profile: Profile | null;
  /** Re-read the credit balance after a spend/earn. */
  setBalance: (balance: number) => void;
  retry: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

// Module-level singleton: React StrictMode runs effects twice in dev, and we must
// never create two anonymous identities for one browser.
let bootPromise: Promise<Profile> | null = null;

function looksLikeStaleSession(err: { code?: string; message?: string }): boolean {
  // PGRST301: JWT invalid/expired. 23503: FK violation => auth user no longer exists.
  return err.code === 'PGRST301' || err.code === '23503' || err.message === 'not_authenticated';
}

async function bootstrap(): Promise<Profile> {
  const sb = getSupabase();

  const signIn = async () => {
    // Cloudflare Turnstile (only when the build has a site key): one human check per NEW identity.
    const captchaToken = await getCaptchaToken();
    const { error } = await sb.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
    if (error) throw error;
  };

  const {
    data: { session },
    error: sessionError,
  } = await sb.auth.getSession();
  // A stored session whose refresh failed (e.g. offline) comes back as {session: null, error}.
  // Signing in anonymously here would overwrite the stored identity and orphan the user's
  // credits, so surface a retryable error instead. Only a genuinely absent session signs in.
  if (sessionError) throw sessionError;
  if (!session) await signIn();

  let res = await sb.rpc('ensure_profile');
  if (res.error && looksLikeStaleSession(res.error)) {
    // Stored session points at a deleted/invalid user: start a fresh anonymous identity once.
    await sb.auth.signOut({ scope: 'local' });
    await signIn();
    res = await sb.rpc('ensure_profile');
  }
  if (res.error) throw new Error(res.error.message);
  // Attribute this visit to the friend who invited us (no-op without a stored ?ref= code; never throws).
  // Not awaited: a slow or locked claim must never keep the app on the loading screen.
  void claimStoredReferral();
  return res.data as Profile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(config.configured ? 'loading' : 'unconfigured');
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!config.configured) return;
    let cancelled = false;
    setStatus('loading');
    setError(null);

    bootPromise ??= bootstrap();
    bootPromise
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        bootPromise = null; // allow retry
        if (cancelled) return;
        setError(friendlyError(e));
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const setBalance = useCallback((balance: number) => {
    setProfile((p) => (p ? { ...p, credit_balance: balance } : p));
  }, []);

  const retry = useCallback(() => {
    bootPromise = null;
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ status, error, profile, setBalance, retry }),
    [status, error, profile, setBalance, retry],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
