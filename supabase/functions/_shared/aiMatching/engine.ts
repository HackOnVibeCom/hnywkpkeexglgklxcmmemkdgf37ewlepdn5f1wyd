// Orchestrates one recommendation run. Pure: every side effect (DB, model, clock) comes in through `Deps`, so the whole
// policy is unit-testable with a mocked model.
//
//   AI recommends. The existing backend authorizes:
//   * candidates = the caller's own Discover feed (list_campaigns_v2 under THEIR JWT). Only rows the server marks
//     eligible=true are ever sent to the model or returned, so a Targeted campaign the tester cannot reserve can never
//     become a recommendation. Eligibility is re-read on every request; a cache hit never overrides it.
//   * the model only ranks/explains; it can neither grant access nor change credits.
//
//   Cost: step 1 (profile -> structured experience) runs only when the profile changed (hash); step 2 (campaigns ->
//   verdicts) runs only for campaigns that are new/changed for this profile, in ONE batched call. A run that needs no
//   call is free. Both steps are admitted atomically through ai_reserve_run (per-user + global caps, min interval).

import { buildProfile } from './profile.ts';
import { ANALYSIS_SCHEMA, ANALYSIS_SYSTEM, MATCH_SCHEMA, MATCH_SYSTEM, analysisUserMessage, matchUserMessage } from './prompts.ts';
import { CATEGORY_LABELS } from './categories.ts';
import { canonicalJson, cleanText, LIMITS, POLICY_VERSION, sha256Hex } from './util.ts';
import { analysisQuoteCorpus, hasMatchableEvidence, parseAnalysis, parseMatches } from './validate.ts';
import { AiError } from './openai.ts';
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
  const empty = (status: RecommendStatus, extra: Partial<RecommendResponse> = {}): RecommendResponse => ({
    status, recommendations: [], evaluated: 0, from_cache: false, understanding: null, ...extra,
  });

  // 1. Consent + profile. No consent => the model is never called and no profile text is read beyond the flag.
  const raw = await deps.getProfileInput();
  if (!raw.consent) {
    // Consent is not granted (or was withdrawn elsewhere): the model is never called AND nothing derived is kept.
    await deps.purgeDerived().catch(() => deps.log?.('purge_failed'));
    return empty('consent_required');
  }
  const profile = buildProfile(raw);
  if (profile.textChars < LIMITS.minProfileChars) return empty('insufficient_profile');

  // 2. Candidates: server-authoritative eligibility. Ineligible / in-progress campaigns are dropped BEFORE the model.
  const feed = await deps.listCandidates();
  const eligible = feed.filter((r) => r.eligible === true && r.reserved_by_me !== true).slice(0, LIMITS.maxCampaigns);
  const byRef = new Map<string, FeedRow>();
  const campaigns: Array<{ row: FeedRow; model: CampaignForModel; hash: string }> = [];
  for (const [i, row] of eligible.entries()) {
    const ref = `c${i + 1}`;
    byRef.set(ref, row);
    const m = forModel(row, ref);
    // Hash covers everything the model sees EXCEPT the transient ref, so reordering does not invalidate the cache.
    const { ref: _ref, ...content } = m;
    // POLICY_VERSION + model are part of the key: a prompt/validation fix or a model change expires old verdicts.
    campaigns.push({ row, model: m, hash: await sha256Hex(canonicalJson({ v: POLICY_VERSION, model: deps.config.model, content })) });
  }

  // 3. Cache lookup (this user's own rows only: the cache RPC is keyed by the verified user id).
  const profileHash = await sha256Hex(canonicalJson({ v: POLICY_VERSION, model: deps.config.model, profile: profile.forModel }));
  const cache = await deps.getCache();
  let analysis: Analysis | null = cache.analysis && cache.analysis.input_hash === profileHash ? cache.analysis.analysis : null;
  const verdicts = new Map<string, MatchResult>(); // campaign_id -> result
  const missing: typeof campaigns = [];
  for (const c of campaigns) {
    const hit = cache.matches.find((m) => m.campaign_id === c.row.campaign_id && m.profile_hash === profileHash && m.campaign_hash === c.hash);
    if (hit) verdicts.set(c.row.campaign_id, hit.result); else missing.push(c);
  }

  const build = (status: RecommendStatus, fromCache: boolean): RecommendResponse => {
    const recs: Recommendation[] = [];
    for (const c of campaigns) {
      const r = verdicts.get(c.row.campaign_id);
      if (r && r.recommended && (r.verdict === 'strong' || r.verdict === 'good')) {
        recs.push({ campaign_id: c.row.campaign_id, verdict: r.verdict, explanation: r.explanation, evidence: r.evidence, unsupported_requirements: r.unsupported_requirements });
      }
    }
    // strong before good; within a verdict keep the server's feed order (stable, no invented score)
    recs.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'strong' ? -1 : 1));
    return { status, recommendations: recs.slice(0, LIMITS.maxRecommendations), evaluated: campaigns.length, from_cache: fromCache, understanding: understanding(analysis) };
  };

  if (missing.length === 0) return build('ok', true);

  // 4a. A cached analysis with nothing grounded in it can never match anything: no model call, no allowance used.
  if (analysis && !hasMatchableEvidence(analysis)) {
    const none: CachedMatch[] = missing.map((c) => ({ campaign_id: c.row.campaign_id, profile_hash: profileHash, campaign_hash: c.hash, result: NO_MATCH }));
    for (const f of none) verdicts.set(f.campaign_id, f.result);
    await deps.putMatches(none).catch(() => deps.log?.('cache_write_failed'));
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

  try {
    // 5. Step 1 - understand the tester (only when the profile changed).
    if (!analysis) {
      const res = await deps.callModel({
        name: 'tester_experience', system: ANALYSIS_SYSTEM, user: analysisUserMessage(profile.forModel),
        schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: LIMITS.maxOutputTokensAnalysis,
      });
      spent.input_tokens += res.usage.input_tokens; spent.output_tokens += res.usage.output_tokens;
      const parsed = parseAnalysis(res.json, profile.corpusNorm);
      if (!parsed) { deps.log?.('analysis_malformed'); await track(); return build('unavailable', false); }
      analysis = parsed;
      await deps.putAnalysis(profileHash, parsed);
    }

    // 6. Step 2 - one batched call for every campaign without a valid verdict. Nothing grounded => nothing to match.
    const fresh: CachedMatch[] = [];
    if (!hasMatchableEvidence(analysis)) {
      for (const c of missing) fresh.push({ campaign_id: c.row.campaign_id, profile_hash: profileHash, campaign_hash: c.hash, result: NO_MATCH });
    } else {
      const refs = missing.map((c) => c.model.ref);
      const res = await deps.callModel({
        name: 'campaign_matches', system: MATCH_SYSTEM, user: matchUserMessage(analysis, missing.map((c) => c.model)),
        schema: MATCH_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: LIMITS.maxOutputTokensMatch,
      });
      spent.input_tokens += res.usage.input_tokens; spent.output_tokens += res.usage.output_tokens;
      const parsed = parseMatches(res.json, refs, analysisQuoteCorpus(analysis));
      if (!parsed) { deps.log?.('matches_malformed'); await track(); return build('unavailable', false); }
      for (const c of missing) {
        fresh.push({ campaign_id: c.row.campaign_id, profile_hash: profileHash, campaign_hash: c.hash, result: parsed.get(c.model.ref) ?? NO_MATCH });
      }
    }
    for (const f of fresh) verdicts.set(f.campaign_id, f.result);
    await deps.putMatches(fresh).catch(() => deps.log?.('cache_write_failed')); // a cache-write failure must not hide a good answer
    await track();
    return build('ok', false);
  } catch (e) {
    deps.log?.(e instanceof AiError ? `model_${e.code}` : 'run_failed');
    await track();
    return build('unavailable', false); // OpenAI down / timeout / refusal / our own bug: the plain Discover list is unaffected
  }
}
