// Small pure helpers: hashing, text normalisation, bounds. No I/O.

/** Bump whenever prompts, schemas or validation rules change: it is part of every cache key, so old verdicts expire. */
export const POLICY_VERSION = 2;

export const LIMITS = {
  bioChars: 280,
  answerChars: 800,
  /** Minimum amount of tester-written text before it is worth a paid model call. */
  minProfileChars: 30,
  maxCampaigns: 30,
  campaignNameChars: 80,
  campaignDescriptionChars: 600,
  campaignTaskChars: 600,
  labelChars: 80,
  quoteChars: 200,
  explanationChars: 280,
  relevanceChars: 200,
  listItems: 12,
  maxRecommendations: 10,
  maxOutputTokensAnalysis: 4000,
  maxOutputTokensMatch: 8000,
  maxOutputTokensAssess: 3000,
} as const;

/** Control characters except tab (9) and line feed (10), DEL (127), and the Unicode line/paragraph separators. */
function isBadChar(code: number): boolean {
  return (code < 32 && code !== 9 && code !== 10) || code === 127 || code === 0x2028 || code === 0x2029;
}

/**
 * Unicode-normalise (NFKC: look-alike / full-width forms become plain letters), drop invisible FORMAT characters (zero-width
 * space/joiner, soft hyphen, bidi marks: a classic way to smuggle "ig<ZWSP>nore" past a filter while the model still reads it),
 * strip control characters (keep tab/newline), collapse runs of blank space, trim, cap length.
 */
export function cleanText(input: unknown, maxChars: number): string {
  if (typeof input !== 'string') return '';
  let out = '';
  for (const ch of input.normalize('NFKC')) {
    if (/\p{Cf}/u.test(ch)) continue;
    out += isBadChar(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  }
  const s = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > maxChars ? s.slice(0, maxChars).trim() : s;
}

/** Normalised form used ONLY to check that a quote really occurs in the tester's own text. */
export function normForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deterministic JSON (sorted keys) so equal content always hashes equally. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Thrown when consent is no longer active at the moment a model request was about to be sent: nothing is sent, nothing is stored. */
export class ConsentWithdrawn extends Error {
  constructor() {
    super('consent_withdrawn');
  }
}
