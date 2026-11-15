// The real safety net around the model: nothing the model returns is trusted until it passes here.
//  * structure is checked field by field (malformed output => null, never "best effort" guessing)
//  * every piece of evidence must be a VERBATIM quote that occurs in the tester's own text (anti-hallucination and
//    anti-injection: campaign text cannot fabricate tester experience, the model cannot invent qualifications)
//  * only campaign refs we sent are accepted; unknown/duplicate refs are ignored
//  * the recommendation policy is applied HERE, in code: a campaign is recommended only for verdict strong|good AND
//    at least one grounded quote AND a non-empty explanation. 'possible' (uncertain) is never promoted.
//  * model-written strings are stripped of URLs/markdown and length-capped (they are rendered as plain text).

import { cleanText, isRecord, LIMITS, normForQuote } from './util.ts';
import type { Analysis, AreaItem, EvidenceItem, MatchResult, Verdict } from './types.ts';

const VERDICTS: readonly string[] = ['strong', 'good', 'possible', 'weak', 'none'];
const LEVELS: readonly string[] = ['stated_hands_on', 'stated_exposure', 'interest_only'];

/**
 * Function words that cannot, on their own, be evidence of anything ("with", "the", "that"). There is NO minimum quote length:
 * a quote qualifies if it is verbatim, sits at word boundaries and contains at least one CONTENT word (so a short legitimate
 * item like "Python", "SQL" or "CRM" is accepted, while a stop word used as "evidence" is not). The list is English plus a few
 * Ukrainian/Russian function words; text in other languages is simply not stop-word filtered (grounding still applies).
 */
const STOPWORDS = new Set((
  'a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those i me my we our you your he she they them their ' +
  'do does did have has had not no so than then there here very just also can could will would should may might about into over under up down out off more most ' +
  'some any all each every many much such own other what which who whom when where why how too yet still ever never ' +
  'и в на с по для что как я мы он она это не но а или та і й у з до від про що як це але').split(' '));

/** True if the quote has at least one content word: not a stop word and (3+ letters, or a digit, or an all-caps acronym). */
export function hasContentWord(quote: string): boolean {
  for (const raw of quote.split(/[^\p{L}\p{N}+#]+/u)) {
    if (!raw) continue;
    const t = raw.toLowerCase();
    if (STOPWORDS.has(t)) continue;
    if (t.length >= 3 || /\d/.test(t) || (raw.length === 2 && raw === raw.toUpperCase() && /\p{L}/u.test(raw))) return true;
  }
  return false;
}

/** Plain display text from model output: no links, e-mail addresses, phone numbers, bare domains or markdown; bounded. */
export function safeText(input: unknown, maxChars: number): string {
  let s = cleanText(input, maxChars * 2);
  s = s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links keep their label only
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '') // e-mail addresses
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\/\S*/gi, '') // any host/path ("bit.ly/x", "t.me/handle", "site.io/a")
    .replace(/\b[\w-]+\s*(?:\.|\(?dot\)?)\s*(?:com|net|org|ru|xyz|info|me|ly|gl|cc|tk|link|click|top|site|online|shop|store|app|dev|ua|su|biz|club)\b/gi, '') // "example dot com", "evil.ru", "short.ly"
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '') // phone-like digit runs
    .replace(/[`*_#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxChars ? s.slice(0, maxChars).trim() : s;
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** needle occurs in hay and is not glued to letters/digits on either side (no mid-word hits like "the" in "other"). */
function containsAtWordBoundary(hay: string, needle: string): boolean {
  let i = hay.indexOf(needle);
  while (i !== -1) {
    const startOk = !isWordChar(needle[0]) || !isWordChar(i === 0 ? undefined : hay[i - 1]);
    const endOk = !isWordChar(needle[needle.length - 1]) || !isWordChar(hay[i + needle.length]);
    if (startOk && endOk) return true;
    i = hay.indexOf(needle, i + 1);
  }
  return false;
}

/** The quote (as written by the tester) if it occurs verbatim, at word boundaries, in the given text and has a content word; else null. */
export function groundedQuote(q: unknown, corpusNorm: string): string | null {
  if (typeof q !== 'string') return null;
  const clean = cleanText(q, LIMITS.quoteChars * 2).replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  const n = normForQuote(clean);
  if (n === '' || n.length > LIMITS.quoteChars || !hasContentWord(clean)) return null;
  return containsAtWordBoundary(corpusNorm, n) ? clean : null;
}

/** Normalised text of every evidence quote in a (validated) analysis: the ONLY text a match quote may be taken from. */
export function analysisQuoteCorpus(a: Analysis): string {
  const quotes = [...a.experience_areas, ...a.tools_and_workflows, ...a.product_domains].flatMap((i) => i.evidence);
  return normForQuote(quotes.join('\n'));
}

function groundedQuotes(list: unknown, corpusNorm: string): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const q of list.slice(0, 6)) {
    const g = groundedQuote(q, corpusNorm);
    if (g && !out.includes(g)) out.push(g);
    if (out.length === 3) break;
  }
  return out;
}

function evidenceItems(list: unknown, corpusNorm: string): EvidenceItem[] | null {
  if (!Array.isArray(list)) return null;
  const out: EvidenceItem[] = [];
  for (const it of list.slice(0, LIMITS.listItems)) {
    if (!isRecord(it)) continue;
    const label = safeText(it.label, LIMITS.labelChars);
    const evidence = groundedQuotes(it.evidence, corpusNorm);
    if (label && evidence.length > 0) out.push({ label, evidence }); // no quote => not a supported claim => dropped
  }
  return out;
}

/** null = malformed (caller treats as a failed call and caches nothing). */
export function parseAnalysis(raw: unknown, corpusNorm: string): Analysis | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.summary !== 'string' || !Array.isArray(raw.experience_areas) || !Array.isArray(raw.tools_and_workflows)
      || !Array.isArray(raw.product_domains) || !Array.isArray(raw.missing_information)) return null;

  const areas: AreaItem[] = [];
  for (const it of raw.experience_areas.slice(0, LIMITS.listItems)) {
    if (!isRecord(it) || typeof it.level !== 'string' || !LEVELS.includes(it.level)) continue;
    const label = safeText(it.label, LIMITS.labelChars);
    const evidence = groundedQuotes(it.evidence, corpusNorm);
    if (label && evidence.length > 0) areas.push({ label, level: it.level as AreaItem['level'], evidence });
  }
  const tools = evidenceItems(raw.tools_and_workflows, corpusNorm);
  const domains = evidenceItems(raw.product_domains, corpusNorm);
  if (!tools || !domains) return null;

  const missing = raw.missing_information.filter((m): m is string => typeof m === 'string').slice(0, 8)
    .map((m) => safeText(m, LIMITS.labelChars)).filter(Boolean);
  // The summary is only kept when something concrete survived grounding (otherwise it could be pure invention).
  const grounded = areas.length + tools.length + domains.length > 0;
  return {
    summary: grounded ? safeText(raw.summary, 400) : '',
    experience_areas: areas,
    tools_and_workflows: tools,
    product_domains: domains,
    missing_information: missing,
  };
}

export const hasMatchableEvidence = (a: Analysis): boolean => a.experience_areas.length + a.tools_and_workflows.length + a.product_domains.length > 0;

const NONE: MatchResult = { verdict: 'none', recommended: false, explanation: '', evidence: [], unsupported_requirements: [] };

/**
 * Policy-checked results keyed by the refs we sent. null = the top-level structure is malformed.
 * Every ref we asked about gets an entry (missing / malformed / ungrounded => 'none', never recommended).
 * `quoteCorpusNorm` = analysisQuoteCorpus(analysis): a match quote must be verbatim, at word boundaries and contain a content
 * word, AND be text that the validated analysis already quoted from the tester, so campaign text cannot pick its own
 * "evidence". A batch where many campaigns are genuinely relevant is NOT penalised; steering text in a campaign is stopped
 * earlier by guard.ts (such campaigns are never sent to the model).
 */
export function parseMatches(raw: unknown, refs: readonly string[], quoteCorpusNorm: string): Map<string, MatchResult> | null {
  if (!isRecord(raw) || !Array.isArray(raw.matches)) return null;
  const wanted = new Set(refs);
  const seen = new Set<string>();
  const out = new Map<string, MatchResult>();

  for (const m of raw.matches.slice(0, LIMITS.maxCampaigns * 2)) {
    if (!isRecord(m) || typeof m.ref !== 'string' || !wanted.has(m.ref) || seen.has(m.ref)) continue;
    seen.add(m.ref);
    if (typeof m.verdict !== 'string' || !VERDICTS.includes(m.verdict)) { out.set(m.ref, NONE); continue; }
    const verdict = m.verdict as Verdict;
    const unsupported = Array.isArray(m.unsupported_requirements)
      ? m.unsupported_requirements.slice(0, 5).map((u) => safeText(u, LIMITS.labelChars * 2)).filter(Boolean)
      : [];

    const evidence: MatchResult['evidence'] = [];
    if (Array.isArray(m.evidence)) {
      for (const e of m.evidence.slice(0, 5)) {
        if (!isRecord(e)) continue;
        const quote = groundedQuote(e.quote, quoteCorpusNorm);
        const relevance = safeText(e.relevance, LIMITS.relevanceChars);
        if (quote && relevance) evidence.push({ quote, relevance });
        if (evidence.length === 3) break;
      }
    }
    const explanation = safeText(m.explanation, LIMITS.explanationChars);

    const recommended = (verdict === 'strong' || verdict === 'good') && evidence.length > 0 && explanation.length >= 10;
    out.set(m.ref, recommended
      ? { verdict, recommended: true, explanation, evidence, unsupported_requirements: unsupported }
      // A claimed strong/good without grounded evidence is NOT downgraded to a softer-but-shown verdict: it is dropped.
      : { ...NONE, verdict: verdict === 'strong' || verdict === 'good' ? 'none' : verdict, unsupported_requirements: [] });
  }
  for (const r of refs) if (!out.has(r)) out.set(r, NONE);
  return out;
}
