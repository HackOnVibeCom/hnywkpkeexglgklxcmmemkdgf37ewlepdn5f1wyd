export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Shows just the host of a URL (for compact display); falls back to the raw string. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "6 days left" / "3 h left" / "12 min left" / "expired" for a deadline. */
export function timeLeft(iso: string, nowMs: number = Date.now()): string {
  const s = Math.floor((Date.parse(iso) - nowMs) / 1000);
  if (s <= 0) return 'expired';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(m, 1)} min left`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h left`;
  return `${Math.floor(h / 24)} days left`;
}

/** 83 -> "1:23" */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
