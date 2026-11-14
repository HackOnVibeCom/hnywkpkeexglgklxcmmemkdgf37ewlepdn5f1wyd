// Cloudflare Turnstile for the ONE place an attacker can mass-produce identities: anonymous sign-in.
//
// * Opt-in by build env: with no VITE_TURNSTILE_SITE_KEY nothing is loaded and sign-in works exactly as
//   before (so the app keeps working until Supabase's CAPTCHA protection is switched on).
// * The site key is PUBLIC by design. The Turnstile SECRET lives only in the Supabase dashboard
//   (Authentication -> Attack Protection), never in this repo or the browser bundle.
// * Only first visits pay the cost: a returning browser already has a session and never calls this.
// * `appearance: 'interaction-only'`: the widget stays invisible unless Cloudflare needs the visitor to click.
//
// Errors: Cloudflare reports a numeric code to `error-callback`. 1xxxxx/4xxxxx codes (invalid sitekey, hostname
// not allowed, ...) are CONFIGURATION errors and fail immediately. Other codes (e.g. 300xxx/600xxx "generic
// challenge failure") are retried a couple of times with `turnstile.reset()` before giving up; the final error
// carries the code so it can be shown to the visitor and reported to the site owner.

const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();

export const captchaEnabled = SITE_KEY.length > 0;

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      appearance?: 'always' | 'execute' | 'interaction-only';
      retry?: 'auto' | 'never';
      callback: (token: string) => void;
      'error-callback': (code?: string) => boolean | void;
      'timeout-callback'?: () => void;
    },
  ) => string;
  reset?: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export type CaptchaFailure = 'script' | 'config' | 'challenge' | 'timeout';

/** A human-check failure. `code` is Cloudflare's own error code (when it gave one). */
export class CaptchaError extends Error {
  constructor(
    public readonly kind: CaptchaFailure,
    public readonly code?: string,
  ) {
    super(kind === 'script' ? 'captcha_script_failed' : kind === 'timeout' ? 'captcha_timeout' : 'captcha_failed');
    this.name = 'CaptchaError';
  }
}

/** Codes that retrying cannot fix: wrong/disabled sitekey, hostname not allowed, bad clock, ... */
export function isConfigErrorCode(code: string | undefined): boolean {
  return !!code && /^(110100|110110|110200|200100|400)/.test(code);
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TIMEOUT_MS = 120_000; // a visitor may need to read and tick the box
const SCRIPT_TIMEOUT_MS = 20_000;
const MAX_CHALLENGE_ERRORS = 3; // initial failure + 2 automatic retries
const RETRY_DELAY_MS = 1_500;

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    // Some content blockers stall the request without ever firing onerror: do not hang the app forever.
    const stall = setTimeout(() => {
      scriptPromise = null; // allow a retry
      s.remove();
      reject(new CaptchaError('script'));
    }, SCRIPT_TIMEOUT_MS);
    s.onload = () => {
      clearTimeout(stall);
      resolve();
    };
    s.onerror = () => {
      clearTimeout(stall);
      scriptPromise = null; // allow a retry
      reject(new CaptchaError('script'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Resolves with a one-time token to pass to `signInAnonymously({ options: { captchaToken } })`, or with
 * `undefined` when Turnstile is not configured for this build. Rejects with a {@link CaptchaError}.
 */
export async function getCaptchaToken(): Promise<string | undefined> {
  if (!captchaEnabled) return undefined;
  await loadScript();
  const api = window.turnstile;
  if (!api) throw new CaptchaError('script');

  return new Promise<string>((resolve, reject) => {
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'turnstile-host');
    host.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:50';
    document.body.appendChild(host);

    let widgetId: string | undefined;
    let settled = false;
    let errors = 0;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (widgetId) api.remove(widgetId);
      } catch {
        /* widget already gone */
      }
      host.remove();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new CaptchaError('timeout'))), TIMEOUT_MS);

    /** Handles error-callback and timeout-callback. Returns true when we deal with it ourselves. */
    const onProblem = (code?: string): boolean => {
      if (settled) return true;
      if (isConfigErrorCode(code)) {
        finish(() => reject(new CaptchaError('config', code)));
        return true;
      }
      errors += 1;
      if (errors >= MAX_CHALLENGE_ERRORS || !api.reset) {
        finish(() => reject(new CaptchaError('challenge', code)));
        return true;
      }
      // Transient "generic challenge failure": give the challenge another go, keeping the widget on screen.
      setTimeout(() => {
        if (settled || widgetId === undefined) return;
        try {
          api.reset?.(widgetId);
        } catch {
          finish(() => reject(new CaptchaError('challenge', code)));
        }
      }, RETRY_DELAY_MS);
      return true;
    };

    let early: string | undefined; // the callback can fire synchronously, before render() returns
    widgetId = api.render(host, {
      sitekey: SITE_KEY,
      appearance: 'interaction-only',
      retry: 'never', // we drive retries ourselves so the error code is never lost
      callback: (token) => {
        if (widgetId === undefined) early = token;
        else finish(() => resolve(token));
      },
      'error-callback': (code) => onProblem(code),
      'timeout-callback': () => {
        onProblem('timeout');
      },
    });
    if (early !== undefined) finish(() => resolve(early as string));
  });
}
