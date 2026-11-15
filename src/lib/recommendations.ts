import type { AiRecommendation, RecommendationsResponse } from './aiContract';

/**
 * The seam where the AI relevance-matching service plugs into Discover.
 *
 * This workstream does NOT implement ranking and calls NO AI service. Until the AI service exists the provider reports
 * `unavailable`, and Discover says exactly that (it never shows invented recommendations).
 *
 * Integration (see docs/AI_INTEGRATION_CONTRACT.md): the AI workstream replaces `fetchRecommendations` with a call to its own
 * server endpoint, sending the tester's Supabase access token as `Authorization: Bearer <jwt>` (the server derives the user id
 * from the verified token, never from the request body) and returning a `RecommendationsResponse`. Discover additionally
 * filters the result to campaigns the database says the tester can actually reserve, so a bad response can never surface an
 * ineligible targeted task as an actionable recommendation.
 */
export type RecommendationProvider = () => Promise<RecommendationsResponse>;

export const fetchRecommendations: RecommendationProvider = async () => ({ status: 'unavailable' });

/**
 * What Discover may actually show as "Recommended for you": only items of an `ok` response whose campaign the DATABASE says the
 * tester can act on (`eligibleIds` = the eligible rows of list_campaigns_v2). Unknown, ineligible and duplicate campaigns are
 * dropped, so a faulty or malicious response can never surface an ineligible targeted task as actionable. An empty array is the
 * honest "nothing relevant right now" state.
 */
export function actionableRecommendations(resp: RecommendationsResponse, eligibleIds: ReadonlySet<string>): AiRecommendation[] {
  if (resp.status !== 'ok' || !Array.isArray(resp.items)) return [];
  const seen = new Set<string>();
  const out: AiRecommendation[] = [];
  for (const r of resp.items) {
    if (!r || typeof r.campaign_id !== 'string' || !eligibleIds.has(r.campaign_id) || seen.has(r.campaign_id)) continue;
    seen.add(r.campaign_id);
    out.push({ campaign_id: r.campaign_id, reason: typeof r.reason === 'string' ? r.reason.slice(0, 280) : '', ...(typeof r.score === 'number' ? { score: r.score } : {}) });
  }
  return out;
}
