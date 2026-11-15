// Referral links: https://<site>/?ref=<code>
//
// The code is remembered in localStorage (per browser) until the visitor has an identity, then claimed once
// via the claim_referral RPC. The server enforces every rule (new users only, no self/mutual referrals, one
// referrer per invitee, reward only after the invitee's first real test, capped); this file is just plumbing.
import { getSupabase } from './supabase';

const KEY = 'pp:ref';
const CODE_RE = /^[a-z0-9]{6,16}$/;

function readStored(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && CODE_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Call once, before React renders: stores ?ref=CODE (first link wins) and removes it from the address bar. */
export function captureReferralFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get('ref');
    if (raw === null) return;
    const code = raw.trim().toLowerCase();
    if (CODE_RE.test(code) && !readStored()) localStorage.setItem(KEY, code);
    url.searchParams.delete('ref');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* storage or history API unavailable: the visit simply is not attributed */
  }
}

/** True while a captured code is waiting to be claimed (used to explain the invitation on the landing page). */
export function hasPendingReferral(): boolean {
  return readStored() !== null;
}

/**
 * Claims the stored code, if any. Only forgets the code after the server gave a definitive answer, so a
 * network blip does not lose the attribution. Never throws: a referral problem must not break the app.
 */
export async function claimStoredReferral(): Promise<void> {
  const code = readStored();
  if (!code) return;
  try {
    const { error } = await getSupabase().rpc('claim_referral', { p_code: code });
    if (!error) localStorage.removeItem(KEY);
  } catch {
    /* keep the code and try again on the next visit */
  }
}

/** The shareable link for an identity's own code. Falls back to the plain site URL when there is no code yet. */
export function referralLink(code: string | undefined | null): string {
  const origin = window.location.origin;
  return code ? `${origin}/?ref=${encodeURIComponent(code)}` : origin;
}
