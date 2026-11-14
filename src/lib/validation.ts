// Client-side validation. Mirrors the SQL CHECKs / RPC validation exactly so users
// get instant feedback — but the database is the authority and re-validates everything.

export const LIMITS = {
  nameMin: 2,
  nameMax: 80,
  descriptionMax: 500,
  taskMin: 20,
  taskMax: 600,
  feedbackMin: 10,
  feedbackMax: 2000,
} as const;

// Same pattern as public.is_valid_public_url(): public http(s) URL, real DNS host,
// no IP literals / localhost / credentials / non-http schemes.
const PUBLIC_URL =
  /^https?:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(:[0-9]{1,5})?([/?#]\S*)?$/i;

export function isValidPublicUrl(url: string): boolean {
  const v = url.trim();
  return v.length <= 2048 && PUBLIC_URL.test(v);
}

export function lengthBetween(value: string, min: number, max: number): boolean {
  const n = value.trim().length;
  return n >= min && n <= max;
}
