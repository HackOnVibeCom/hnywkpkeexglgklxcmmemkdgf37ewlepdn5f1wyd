// Cloudflare Turnstile for the ONE place an attacker can mass-produce identities: anonymous sign-in.
//
// * Opt-in by build env: with no VITE_TURNSTILE_SITE_KEY nothing is loaded and sign-in works exactly as
//   before (so the app keeps working until Supabase's CAPTCHA protection is switched on).
// * The site key is PUBLIC by design. The Turnstile SECRET lives only in the Supabase dashboard
//   (Authentication -> Attack Protection), never in this repo or the browser bundle.
// * Only first visits pay the cost: a returning browser already has a session and never calls this.
// * `appearance: 'interaction-only'`: the widget stays invisible unless Cloudflare needs the visitor to click.

const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();

export const captchaEnabled = SITE_KEY.length > 0;

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      appearance?: 'always' | 'execute' | 'interaction-only';
      callback: (token: string) => void;
      'error-callback': (code?: string) => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TIMEOUT_MS = 60_000;
const SCRIPT_TIMEOUT_MS = 20_000;

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
      reject(new Error('captcha_script_failed'));
    }, SCRIPT_TIMEOUT_MS);
    s.onload = () => {
      clearTimeout(stall);
      resolve();
    };
    s.onerror = () => {
      clearTimeout(stall);
      scriptPromise = null; // allow a retry
      reject(new Error('captcha_script_failed'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Resolves with a one-time token to pass to `signInAnonymously({ options: { captchaToken } })`, or with
 * `undefined` when Turnstile is not configured for this build.
 */
export async function getCaptchaToken(): Promise<string | undefined> {
  if (!captchaEnabled) return undefined;
  await loadScript();
  const api = window.turnstile;
  if (!api) throw new Error('captcha_script_failed');

  return new Promise<string>((resolve, reject) => {
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'turnstile-host');
    host.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:50';
    document.body.appendChild(host);

    let widgetId: string | undefined;
    let settled = false;
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
    const timer = setTimeout(() => finish(() => reject(new Error('captcha_timeout'))), TIMEOUT_MS);

    let early: string | undefined; // the callback can fire synchronously, before render() returns
    widgetId = api.render(host, {
      sitekey: SITE_KEY,
      appearance: 'interaction-only',
      callback: (token) => {
        if (widgetId === undefined) early = token;
        else finish(() => resolve(token));
      },
      'error-callback': () => finish(() => reject(new Error('captcha_failed'))),
    });
    if (early !== undefined) finish(() => resolve(early as string));
  });
}
