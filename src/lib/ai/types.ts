// Client-side types for AI matching. Kept out of src/lib/types.ts on purpose (that file is owned by the profile/screening
// work); this module is self-contained and only imports from its own folder.

export type AiStatus = 'ok' | 'consent_required' | 'insufficient_profile' | 'rate_limited' | 'busy' | 'budget_reached' | 'unavailable';

export interface AiRecommendation {
  campaign_id: string;
  verdict: 'strong' | 'good';
  /** Plain text written by the model, validated and stripped of links server-side. Render as text only. */
  explanation: string;
  /** Verbatim quotes from the tester's OWN text (verified server-side) + why each is relevant. */
  evidence: Array<{ quote: string; relevance: string }>;
  unsupported_requirements: string[];
}

export interface AiRecommendResult {
  status: AiStatus;
  recommendations: AiRecommendation[];
  evaluated: number;
  from_cache: boolean;
  understanding: { summary: string; areas: string[] } | null;
}
