// Browser calls for the AI service. Own module so it never collides with the profile/qualification workstream's api.ts.
//  * both actions go to the `ai-match` Edge Function, which holds the OpenAI key and the service-role key. The browser only ever
//    sends {"action":"recommend"} or {"action":"assess"} plus its normal session token: it cannot choose a user, a prompt, a
//    model, a category or a qualification decision;
//  * AI consent and the free-text answers are owned by the profile workstream (set_ai_consent / save_experience_answers in
//    src/lib/api.ts); the immediate erase of AI-DERIVED data is delete_my_ai_data() (ours);
//  * every failure degrades to "unavailable": the plain Discover list and the profile page never depend on this module.

import type { AiRecommendation, AssessmentResponse, AssessmentResult, RecommendationsResponse } from '../aiContract';
import { getSupabase } from '../supabase';
import { AI_ENABLED } from './flag';

const UNAVAILABLE: RecommendationsResponse = { status: 'unavailable' };
const NON_OK = ['unavailable', 'consent_required', 'rate_limited', 'busy', 'budget_reached'] as const;
const ASSESS_STATUS = ['ok', 'consent_required', 'rate_limited', 'busy', 'budget_reached', 'unavailable'] as const;
const OUTCOMES = ['qualified', 'not_qualified', 'needs_clarification', 'pending'] as const;
const PRO = ['tech_savvy', 'founders_builders', 'business_office'] as const;

const str = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function invoke(action: 'recommend' | 'assess'): Promise<unknown> {
  const { data, error } = await getSupabase().functions.invoke('ai-match', { body: { action } });
  if (error) throw new Error('ai-match failed');
  return data;
}

/** Defensive: never trust the shape of a network response, even from our own function. */
export function parseRecommendations(data: unknown): RecommendationsResponse {
  if (!isObj(data)) return UNAVAILABLE;
  const status = data.status;
  if (status === 'profile_incomplete') {
    return data.detail === 'not_participation_ready' || data.detail === 'too_little_text' ? { status, detail: data.detail } : { status };
  }
  if ((NON_OK as readonly unknown[]).includes(status)) return { status: status as (typeof NON_OK)[number] };
  if (status !== 'ok' || !Array.isArray(data.items)) return UNAVAILABLE;

  const items: AiRecommendation[] = [];
  for (const r of data.items.slice(0, 10)) {
    if (!isObj(r) || !str(r.campaign_id) || !str(r.reason)) continue;
    const evidence = Array.isArray(r.evidence)
      ? r.evidence.filter((e): e is { quote: string; relevance: string } => isObj(e) && str(e.quote) && str(e.relevance)).slice(0, 3)
      : [];
    items.push({
      campaign_id: r.campaign_id,
      reason: r.reason,
      ...(r.verdict === 'strong' || r.verdict === 'good' ? { verdict: r.verdict } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(Array.isArray(r.unsupported_requirements) ? { unsupported_requirements: r.unsupported_requirements.filter(str).slice(0, 5) } : {}),
    });
  }
  const u = data.understanding;
  return {
    status: 'ok',
    generated_at: str(data.generated_at) ? data.generated_at : '',
    profile_etag: str(data.profile_etag) ? data.profile_etag : '',
    items,
    understanding: isObj(u) && str(u.summary) && Array.isArray(u.areas) ? { summary: u.summary, areas: u.areas.filter(str).slice(0, 8) } : null,
  };
}

export function parseAssessment(data: unknown): AssessmentResponse {
  if (!isObj(data) || !(ASSESS_STATUS as readonly unknown[]).includes(data.status) || !Array.isArray(data.results)) return { status: 'unavailable', results: [] };
  const results: AssessmentResult[] = [];
  for (const r of data.results.slice(0, 3)) {
    if (!isObj(r) || !(PRO as readonly unknown[]).includes(r.category) || !(OUTCOMES as readonly unknown[]).includes(r.outcome) || !str(r.message)) continue;
    results.push({
      category: r.category as AssessmentResult['category'],
      outcome: r.outcome as AssessmentResult['outcome'],
      message: r.message,
      clarification_questions: Array.isArray(r.clarification_questions) ? r.clarification_questions.filter(str).slice(0, 3) : [],
      criteria: Array.isArray(r.criteria) ? r.criteria.filter(str).slice(0, 6) : [],
    });
  }
  return { status: data.status as AssessmentResponse['status'], results };
}

/** Provider for Discover's "Recommended for you" view (src/lib/recommendations.ts). With the build flag off nothing is requested. */
export async function fetchAiRecommendations(): Promise<RecommendationsResponse> {
  if (!AI_ENABLED) return UNAVAILABLE;
  try {
    return parseRecommendations(await invoke('recommend'));
  } catch {
    return UNAVAILABLE;
  }
}

/** Ask the server to assess MY pending professional categories. The server records any decision; this only returns what happened. */
export async function requestAssessment(): Promise<AssessmentResponse> {
  if (!AI_ENABLED) return { status: 'unavailable', results: [] };
  try {
    return parseAssessment(await invoke('assess'));
  } catch {
    return { status: 'unavailable', results: [] };
  }
}

/**
 * Erase what the AI derived about me (analysis, verdicts, clarification notes) right now. Best effort and a no-op unless the AI
 * build flag is on: the server also erases through the contract's erasure events and whenever it sees no consent.
 * It never touches qualification decisions (see docs/AI_MATCHING.md "Consent withdrawal").
 */
export async function deleteMyAiData(): Promise<void> {
  if (!AI_ENABLED) return;
  try {
    await getSupabase().rpc('delete_my_ai_data');
  } catch {
    /* the server-side erasure events are the safety net */
  }
}
