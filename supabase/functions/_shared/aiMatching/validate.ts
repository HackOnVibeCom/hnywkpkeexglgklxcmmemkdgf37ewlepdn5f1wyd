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

// ---------------------------------------------------------------------------------------------------------------------
// Evidence strength and explanation grounding (policy 3)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Concise skills / tools that are meaningful on their own ("SQL", "Docker", "React"). A single such word is real evidence; a single
 * ordinary word ("Steam", "games", "apps") is not: it needs supporting context. All-caps acronyms of 2-6 letters (SQL, CRM, SEO, API)
 * count as well. The list only needs to hold well-known names that are NOT all-caps; anything else must come with context.
 */
const TECH_TERMS = new Set((
  'sql postgres postgresql mysql sqlite mongodb redis docker kubernetes terraform ansible linux bash powershell git github gitlab python java javascript typescript ' +
  'react vue angular svelte nextjs node nodejs django flask fastapi rails laravel spring golang rust kotlin swift php ruby scala dart flutter ' +
  'aws azure gcp firebase supabase graphql grpc kafka nginx jenkins postman jira figma sketch photoshop illustrator blender unity unreal excel notion airtable ' +
  'zapier shopify wordpress salesforce hubspot quickbooks xero tableau looker pandas numpy pytorch tensorflow selenium cypress playwright pytest jest webpack vite c# c++ .net').split(' '));

/** Words that add no context to a quote ("Steam daily", "use Steam"): they do not count as supporting context. */
const FILLER = new Set(
  'use used using uses every day days daily often really lot lots bit little thing things stuff regularly always also like love usually sometimes'.split(' '));

/** Content tokens of a quote, lower-cased, with the original casing kept to recognise acronyms. */
function contentTokens(quote: string): Array<{ t: string; acronym: boolean }> {
  const out: Array<{ t: string; acronym: boolean }> = [];
  for (const raw of quote.split(/[^\p{L}\p{N}+#]+/u)) {
    if (!raw) continue;
    const t = raw.toLowerCase();
    if (STOPWORDS.has(t) || FILLER.has(t)) continue;
    const acronym = raw.length >= 2 && raw.length <= 6 && raw === raw.toUpperCase() && /\p{L}/u.test(raw);
    if (t.length >= 3 || /\d/.test(t) || acronym) out.push({ t, acronym });
  }
  return out;
}

export type EvidenceStrength = 'context' | 'tech' | 'isolated';

/**
 * context  = two or more meaningful words (a phrase that says something: "I built a REST API", "Excel for invoices")
 * tech     = ONE word, but a concise technical skill/tool or an acronym (SQL, Docker, React, CRM)
 * isolated = one ordinary word ("Steam", "games"): not sufficient evidence on its own
 */
export function evidenceStrength(quote: string): EvidenceStrength {
  const toks = contentTokens(quote);
  if (toks.length >= 2) return 'context';
  if (toks.length === 1 && (TECH_TERMS.has(toks[0].t) || toks[0].acronym)) return 'tech';
  return 'isolated';
}
const POINTS: Record<EvidenceStrength, number> = { context: 2, tech: 1, isolated: 0 };

// Generic vocabulary that appears in almost every explanation and says nothing about WHO supplied it.
const EXPLANATION_NEUTRAL = new Set(
  ('report reports reported experience experiences tester testing test tests task tasks product products relevant relevance match matches matching direct directly ' +
   'hands-on hands closely clearly specific using used works work workflow tool tools app apps people user users help useful good strong fits fit').split(' '));
const stem = (t: string): string => (t.length > 5 ? t.slice(0, 5) : t);
const stems = (s: string): Set<string> => new Set(contentTokens(s).map((x) => x.t).filter((t) => t.length >= 4 && !EXPLANATION_NEUTRAL.has(t)).map(stem));

/**
 * Is this explanation about the TESTER'S reported experience, rather than a paraphrase of the campaign?
 *  1. it shares at least one meaningful word with the evidence quotes (what the tester actually wrote);
 *  2. a named technical term appears in it only if the tester's own text contains it (a tool that only the campaign mentions
 *     cannot be credited to the tester);
 *  3. it is not mostly words that occur only in the campaign text (more than twice as many campaign-only words as tester words).
 * `testerCorpusNorm` = normalised quotes of the validated analysis; `campaignText` = name + description + task.
 */
export function explanationGrounded(explanation: string, evidenceQuotes: readonly string[], testerCorpusNorm: string, campaignText: string): boolean {
  const exp = stems(explanation);
  const ev = stems(evidenceQuotes.join(' '));
  if (![...exp].some((x) => ev.has(x))) return false;
  const tester = stems(testerCorpusNorm);
  const campaign = stems(campaignText);
  const testerNorm = testerCorpusNorm;
  for (const tk of contentTokens(explanation)) {
    if (TECH_TERMS.has(tk.t) && campaignText.toLowerCase().includes(tk.t) && !containsAtWordBoundary(testerNorm, tk.t)) return false;
  }
  let a = 0;
  let b = 0;
  for (const x of exp) {
    if (tester.has(x)) a++;
    else if (campaign.has(x)) b++;
  }
  return !(b > 2 * a);
}

/** Deterministic, safe explanation used when the model's own text is not grounded in what the tester wrote. */
function fallbackExplanation(quote: string): string {
  return safeText(`You wrote: "${quote}". That is the part of your own reported experience that relates to what this task needs.`, LIMITS.explanationChars);
}

const NONE: MatchResult = { verdict: 'none', recommended: false, explanation: '', evidence: [], unsupported_requirements: [] };

/**
 * Policy-checked results keyed by the refs we sent. null = the top-level structure is malformed.
 * Every ref we asked about gets an entry (missing / malformed / ungrounded => 'none', never recommended).
 * `quoteCorpusNorm` = analysisQuoteCorpus(analysis): a match quote must be verbatim, at word boundaries and contain a content
 * word, AND be text that the validated analysis already quoted from the tester, so campaign text cannot pick its own
 * "evidence". A batch where many campaigns are genuinely relevant is NOT penalised; steering text in a campaign is stopped
 * earlier by guard.ts (such campaigns are never sent to the model).
 */
export function parseMatches(raw: unknown, refs: readonly string[], quoteCorpusNorm: string, campaignTexts?: ReadonlyMap<string, string>): Map<string, MatchResult> | null {
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
        // One isolated ordinary word ("Steam") is not evidence by itself; a concise skill ("SQL", "Docker") or a phrase is.
        if (quote && relevance && evidenceStrength(quote) !== 'isolated') evidence.push({ quote, relevance });
        if (evidence.length === 3) break;
      }
    }
    let explanation = safeText(m.explanation, LIMITS.explanationChars);

    const recommended = (verdict === 'strong' || verdict === 'good') && evidence.length > 0 && explanation.length >= 10;
    if (recommended) {
      // The explanation must be about the TESTER's reported experience; otherwise a safe sentence built from their own quote is shown.
      const best = evidence.find((x) => evidenceStrength(x.quote) === 'context') ?? evidence[0];
      const campaignText = campaignTexts?.get(m.ref);
      if (campaignText !== undefined && !explanationGrounded(explanation, evidence.map((x) => x.quote), quoteCorpusNorm, campaignText)) explanation = fallbackExplanation(best.quote);
      // "strong" needs real weight: a phrase (2 points) or two concise skills (1 + 1). A single skill name alone is only "good".
    }
    const weight = evidence.reduce((n, x) => n + POINTS[evidenceStrength(x.quote)], 0);
    const finalVerdict: Verdict = verdict === 'strong' && weight < 2 ? 'good' : verdict;
    out.set(m.ref, recommended
      ? { verdict: finalVerdict, recommended: true, explanation, evidence, unsupported_requirements: unsupported }
      // A claimed strong/good without grounded evidence is NOT downgraded to a softer-but-shown verdict: it is dropped.
      : { ...NONE, verdict: verdict === 'strong' || verdict === 'good' ? 'none' : verdict, unsupported_requirements: [] });
  }
  for (const r of refs) if (!out.has(r)) out.set(r, NONE);
  return out;
}
