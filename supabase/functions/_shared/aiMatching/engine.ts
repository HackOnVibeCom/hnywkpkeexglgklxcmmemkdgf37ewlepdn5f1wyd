// Orchestrates one recommendation run. Pure: every side effect (DB, model, clock) comes in through `Deps`, so the whole
// policy is unit-testable with a mocked model.
//
//   AI recommends. The existing backend authorizes.
//   * candidates = the caller's own Discover feed (list_campaigns_v2 under THEIR JWT). Only rows the server marks
//     eligible=true are ever sent to the model or returned, so a Targeted campaign the tester cannot reserve can never
//     become a recommendation. Eligibility is re-read on every request; a cache hit never overrides it.
//   * the model only ranks/explains; it can neither grant access nor change credits, nor touch qualification.
//
//   Consent / erasure: every request first applies the profile workstream's erasure events, then re-reads consent. No
//   consent (or no subject_ref) => nothing is sent anywhere and everything derived is purged.
//
//   Matching uses the bio and the answers of ACTIVE categories only: a professional category that is still pending
//   assessment (or not qualified) does not count for matching, exactly as it does not count for targeted eligibility.
//
//   Cost: step 1 (profile -> structured experience) runs only when the profile changed; step 2 (campaigns -> verdicts) runs
//   only for campaigns that are new/changed for this profile, in ONE batched call. Cache keys contain the contract etag, the
//   policy version and the model name. A run that needs no call is free. Calls are admitted atomically through reserveRun.

import { AiError } from './openai.ts';
import { buildProfile } from './profile.ts';
import { looksLikeInstruction } from './guard.ts';
import { ANALYSIS_SCHEMA, ANALYSIS_SYSTEM, MATCH_SCHEMA, MATCH_SYSTEM, analysisUserMessage, matchUserMessage } from './prompts.ts';
import { CATEGORY_LABELS } from './categories.ts';
import { canonicalJson, cleanText, ConsentWithdrawn, LIMITS, POLICY_VERSION, sha256Hex } from './util.ts';
import { analysisQuoteCorpus, hasMatchableEvidence, parseAnalysis, parseMatches } from './validate.ts';
import type {
  Analysis, CachedMatch, CampaignForModel, Deps, FeedRow, MatchResult, ModelUsage, Recommendation, RecommendResponse, RecommendStatus,
} from './types.ts';

const NO_MATCH: MatchResult = { verdict: 'none', recommended: false, explanation: '', evidence: [], unsupported_requirements: [] };

function understanding(a: Analysis | null): RecommendResponse['understanding'] {
  if (!a || !hasMatchableEvidence(a)) return null;
  return { summary: a.summary, areas: a.experience_areas.map((x) => x.label).slice(0, 8) };
}

function forModel(row: FeedRow, ref: string): CampaignForModel {
  return {
    ref,
    name: cleanText(row.project_name, LIMITS.campaignNameChars),
    description: cleanText(row.description, LIMITS.campaignDescriptionChars),
    task: cleanText(row.task_description, LIMITS.campaignTaskChars),
    testing_mode: row.testing_mode === 'targeted' ? 'targeted' : 'open',
    audience: (row.target_categories ?? []).map((c) => CATEGORY_LABELS[c]).filter(Boolean),
  };
}

export async function recommend(deps: Deps): Promise<RecommendResponse> {
  const empty = (status: RecommendStatus, etag = '', detail?: RecommendResponse['detail']): RecommendResponse => ({
    status, items: [], generated_at: new Date().toISOString(), profile_etag: etag, ...(detail ? { detail } : {}), evaluated: 0, from_cache: false, understanding: null,
  });

  // 0. Erasure events first (contract section 10): forget what must be forgotten before anything is served.
  await deps.applyErasures().catch(() => deps.log?.('erasure_sweep_failed'));

  // 1. Consent + profile. No consent => the model is never called AND nothing derived is kept.
  const raw = await deps.getProfileInput();
  if (!raw.consent || !raw.subject_ref) {
    await deps.purgeDerived().catch(() => deps.log?.('purge_failed'));
    return empty('consent_required');
  }
  const subjectRef = raw.subject_ref;
  const etag = raw.etag ?? '';
  if (!raw.participation_ready) return empty('profile_incomplete', etag, 'not_participation_ready');
  const profile = buildProfile(raw);
  if (profile.textChars < LIMITS.minProfileChars) return empty('profile_incomplete', etag, 'too_little_text');

  // 2. Candidates: server-authoritative eligibility. Ineligible / in-progress campaigns are dropped BEFORE the model.
  const feed = await deps.listCandidates();
  const eligible = feed.filter((r) => r.eligible === true && r.reserved_by_me !== true).slice(0, LIMITS.maxCampaigns);
  const campaigns: Array<{ row: FeedRow; model: CampaignForModel; hash: string; suspicious: boolean }> = [];
  for (const [i, row] of eligible.entries()) {
    const m = forModel(row, `c${i + 1}`);
    // Hash covers everything the model sees EXCEPT the transient ref, so reordering does not invalidate the cache.
    const { ref: _ref, ...content } = m;
    // POLICY_VERSION + model are part of the key: a prompt/validation fix or a model change expires old verdicts.
    campaigns.push({
      row, model: m, hash: await sha256Hex(canonicalJson({ v: POLICY_VERSION, model: deps.config.model, content })),
      // Campaign text that tries to instruct the model is never evaluated (and so can never be steered): it stays browsable.
      suspicious: looksLikeInstruction(`${m.name}\n${m.description}\n${m.task}`),
    });
  }

  // 3. Cache lookup (rows of this tester's CURRENT subject_ref only; keys include the contract etag).
  const profileHash = await sha256Hex(canonicalJson({ v: POLICY_VERSION, model: deps.config.model, etag, profile: profile.forModel }));
  const cache = await deps.getCache(subjectRef);
  let analysis: Analysis | null = cache.analysis && cache.analysis.input_hash === profileHash ? cache.analysis.analysis : null;
  const verdicts = new Map<string, MatchResult>(); // campaign_id -> result
  const missing: typeof campaigns = [];
  for (const c of campaigns) {
    const hit = cache.matches.find((m) => m.campaign_id === c.row.campaign_id && m.profile_hash === profileHash && m.campaign_hash === c.hash);
    if (hit) verdicts.set(c.row.campaign_id, hit.result);
    else if (c.suspicious) verdicts.set(c.row.campaign_id, NO_MATCH); // no model call, nothing to cache beyond this request
    else missing.push(c);
  }

  const build = (status: RecommendStatus, fromCache: boolean): RecommendResponse => {
    const items: Recommendation[] = [];
    for (const c of campaigns) {
      const r = verdicts.get(c.row.campaign_id);
      if (r && r.recommended && (r.verdict === 'strong' || r.verdict === 'good')) {
        items.push({ campaign_id: c.row.campaign_id, reason: r.explanation, verdict: r.verdict, evidence: r.evidence, unsupported_requirements: r.unsupported_requirements });
      }
    }
    // strong before good; within a verdict keep the server's feed order (stable, no invented score)
    items.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'strong' ? -1 : 1));
    return {
      status, items: items.slice(0, LIMITS.maxRecommendations), generated_at: new Date().toISOString(), profile_etag: etag,
      evaluated: campaigns.length, from_cache: fromCache, understanding: understanding(analysis),
    };
  };

  if (missing.length === 0) return build('ok', true);

  // 4a. A cached analysis with nothing grounded in it can never match anything: no model call, no allowance used.
  if (analysis && !hasMatchableEvidence(analysis)) {
    const none: CachedMatch[] = missing.map((c) => ({ campaign_id: c.row.campaign_id, profile_hash: profileHash, campaign_hash: c.hash, result: NO_MATCH }));
    for (const f of none) verdicts.set(f.campaign_id, f.result);
    await deps.putMatches(subjectRef, none).catch(() => deps.log?.('cache_write_failed'));
    return build('ok', true);
  }

  // 4b. Admit the run atomically (caps + throttle) BEFORE spending anything.
  const calls = (analysis ? 0 : 1) + 1;
  const admitted = await deps.reserveRun(calls);
  if (admitted !== 'ok') {
    return build(admitted === 'too_fast' ? 'busy' : admitted === 'user_daily_cap' ? 'rate_limited' : 'budget_reached', false);
  }

  const spent: ModelUsage = { input_tokens: 0, output_tokens: 0 };
  const track = async () => { if (spent.input_tokens + spent.output_tokens > 0) await deps.recordTokens(spent).catch(() => undefined); };
  // Consent is re-read immediately before EVERY model request (not only when the run started). A withdrawal in between means the
  // request is not sent; a failed check fails closed (nothing is sent). Results of a call already in flight are never stored
  // after a withdrawal either: the ai_put_* functions refuse without active consent for this exact subject_ref.
  const call = async (req: Parameters<Deps['callModel']>[0]) => {
    if (!(await deps.consentActive(subjectRef))) throw new ConsentWithdrawn();
    return deps.callModel(req);
  };

  try {
    // 5. Step 1 - understand the tester (only when the profile changed).
    if (!analysis) {
      const res = await call({
        name: 'tester_experience', system: ANALYSIS_SYSTEM, user: analysisUserMessage(profile.forModel),
        schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: LIMITS.maxOutputTokensAnalysis,
      });
      spent.input_tokens += res.usage.input_tokens; spent.output_tokens += res.usage.output_tokens;
      const parsed = parseAnalysis(res.json, profile.corpusNorm);
      if (!parsed) { deps.log?.('analysis_malformed'); await track(); return build('unavailable', false); }
      analysis = parsed;
      await deps.putAnalysis(subjectRef, profileHash, parsed);
    }

    // 6. Step 2 - one batched call for every campaign without a valid verdict. Nothing grounded => nothing to match.
    const fresh: CachedMatch[] = [];
    if (!hasMatchableEvidence(analysis)) {
      for (const c of missing) fresh.push({ campaign_id: c.row.campaign_id, profile_hash: profileHash, campaign_hash: c.hash, result: NO_MATCH });
    } else {
      const refs = missing.map((c) => c.model.ref);
      const res = await call({
        name: 'campaign_matches', system: MATCH_SYSTEM, user: matchUserMessage(analysis, missing.map((c) => c.model)),
        schema: MATCH_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: LIMITS.maxOutputTokensMatch,
      });
      spent.input_tokens += res.usage.input_tokens; spent.output_tokens += res.usage.output_tokens;
      const texts = new Map(missing.map((c) => [c.model.ref, `${c.model.name} ${c.model.description} ${c.model.task}`] as const));
      const parsed = parseMatches(res.json, refs, analysisQuoteCorpus(analysis), texts);
      if (!parsed) { deps.log?.('matches_malformed'); await track(); return build('unavailable', false); }
      for (const c of missing) {
        fresh.push({ campaign_id: c.row.campaign_id, profile_hash: profileHash, campaign_hash: c.hash, result: parsed.get(c.model.ref) ?? NO_MATCH });
      }
    }
    for (const f of fresh) verdicts.set(f.campaign_id, f.result);
    await deps.putMatches(subjectRef, fresh).catch(() => deps.log?.('cache_write_failed')); // a cache-write failure must not hide a good answer
    await track();
    return build('ok', false);
  } catch (e) {
    await track();
    if (e instanceof ConsentWithdrawn) {
      deps.log?.('consent_withdrawn_midrun');
      await deps.purgeDerived().catch(() => deps.log?.('purge_failed'));
      return empty('consent_required');
    }
    deps.log?.(e instanceof AiError ? `model_${e.code}` : 'run_failed');
    return build('unavailable', false); // OpenAI down / timeout / refusal / our own bug: the plain Discover list is unaffected
  }
}
