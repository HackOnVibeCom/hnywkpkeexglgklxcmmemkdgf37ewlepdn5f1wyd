// Calls for AI matching. Own module (not src/lib/api.ts) so it does not collide with the profile/screening work.
//  * recommendations come from the `ai-match` Edge Function, which holds the OpenAI key. The browser only ever sends
//    {"action":"recommend"} plus its normal session token: it cannot choose a user, a prompt or a model;
//  * AI consent and the free-text answers are owned by the profile workstream: consent is written with ITS RPC
//    set_ai_consent(p_granted), and the derived-data erase with ours, delete_my_ai_data().
// Every failure degrades to "unavailable": the plain Discover list never depends on this module.

import { getSupabase } from '../supabase';
import type { AiRecommendResult, AiRecommendation, AiStatus } from './types';

const STATUSES: readonly AiStatus[] = ['ok', 'consent_required', 'insufficient_profile', 'rate_limited', 'busy', 'budget_reached', 'unavailable'];

export const UNAVAILABLE: AiRecommendResult = { status: 'unavailable', recommendations: [], evaluated: 0, from_cache: false, understanding: null };

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Opt in/out of AI processing (profile workstream's RPC; opting out is also enforced server-side by the function). */
export async function setAiConsentGranted(granted: boolean): Promise<void> {
  await rpc('set_ai_consent', { p_granted: granted });
  if (!granted) {
    // Best effort: the Edge Function purges again on its next call whenever consent is not granted.
    await rpc('delete_my_ai_data').catch(() => undefined);
  }
}

const str = (v: unknown): v is string => typeof v === 'string';

/** Defensive: never trust the shape of a network response, even from our own function. */
export function parseRecommendResult(data: unknown): AiRecommendResult {
  if (!data || typeof data !== 'object') return UNAVAILABLE;
  const d = data as Record<string, unknown>;
  const status = STATUSES.find((s) => s === d.status);
  if (!status || !Array.isArray(d.recommendations)) return UNAVAILABLE;
  const recommendations: AiRecommendation[] = [];
  for (const r of d.recommendations.slice(0, 10)) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    if (!str(x.campaign_id) || (x.verdict !== 'strong' && x.verdict !== 'good') || !str(x.explanation)) continue;
    recommendations.push({
      campaign_id: x.campaign_id,
      verdict: x.verdict,
      explanation: x.explanation,
      evidence: Array.isArray(x.evidence)
        ? x.evidence
            .filter((e): e is { quote: string; relevance: string } => !!e && typeof e === 'object' && str((e as Record<string, unknown>).quote) && str((e as Record<string, unknown>).relevance))
            .slice(0, 3)
        : [],
      unsupported_requirements: Array.isArray(x.unsupported_requirements) ? x.unsupported_requirements.filter(str).slice(0, 5) : [],
    });
  }
  const u = d.understanding as Record<string, unknown> | null | undefined;
  return {
    status,
    recommendations,
    evaluated: typeof d.evaluated === 'number' ? d.evaluated : 0,
    from_cache: d.from_cache === true,
    understanding: u && str(u.summary) && Array.isArray(u.areas) ? { summary: u.summary, areas: u.areas.filter(str).slice(0, 8) } : null,
  };
}

export async function fetchAiRecommendations(): Promise<AiRecommendResult> {
  try {
    const { data, error } = await getSupabase().functions.invoke('ai-match', { body: { action: 'recommend' } });
    if (error) return UNAVAILABLE;
    return parseRecommendResult(data);
  } catch {
    return UNAVAILABLE;
  }
}
