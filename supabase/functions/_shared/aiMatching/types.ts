// Shared types for the AI matching engine. Erasable TypeScript only (no enums / parameter properties) so the same
// files run unchanged in Deno (Supabase Edge Functions) and in plain Node (unit tests).

export type CategoryId = 'tech_savvy' | 'founders_builders' | 'business_office' | 'students_learners' | 'everyday_nontechnical';

/** What the service-only RPC ai_get_profile_input returns. All of it is voluntary, self-reported text. */
export interface RawProfileInput {
  consent: boolean;
  has_profile: boolean;
  bio: string | null;
  categories: string[];
  /** The question/answer pairs exactly as the profile workstream's contract provides them (question text included). */
  answers: Array<{ category: string; question: string; answer: string }>;
}

/** The ONLY tester data that is ever sent to the model. No user id, no nickname, no token. */
export interface ProfileForModel {
  bio: string;
  categories: string[]; // human labels
  answers: Array<{ category: string; question: string; answer: string }>;
}

/** One row of public.list_campaigns_v2() (called with the CALLER's JWT, so eligibility is the server's verdict). */
export interface FeedRow {
  campaign_id: string;
  project_name: string;
  description: string | null;
  task_description: string;
  testing_mode: string;
  target_categories: string[];
  reserved_by_me: boolean;
  eligible: boolean;
  fit: string;
}

export interface CampaignForModel {
  ref: string; // opaque short handle (c1, c2, ...) - the model never sees UUIDs
  name: string;
  description: string;
  task: string;
  testing_mode: string;
  audience: string[]; // human category labels
}

export interface EvidenceItem {
  label: string;
  evidence: string[]; // verbatim quotes from the tester's own text (verified server-side)
}
export interface AreaItem extends EvidenceItem {
  level: 'stated_hands_on' | 'stated_exposure' | 'interest_only';
}

/** Structured experience representation (validated: every item is backed by a verbatim quote). */
export interface Analysis {
  summary: string;
  experience_areas: AreaItem[];
  tools_and_workflows: EvidenceItem[];
  product_domains: EvidenceItem[];
  missing_information: string[];
}

export type Verdict = 'strong' | 'good' | 'possible' | 'weak' | 'none';

/** Final, policy-checked decision for one (tester, campaign). Only strong / good are ever recommended. */
export interface MatchResult {
  verdict: Verdict;
  recommended: boolean;
  explanation: string;
  evidence: Array<{ quote: string; relevance: string }>;
  unsupported_requirements: string[];
}

export interface CachedMatch {
  campaign_id: string;
  profile_hash: string;
  campaign_hash: string;
  result: MatchResult;
}
export interface CacheState {
  analysis: { input_hash: string; analysis: Analysis } | null;
  matches: CachedMatch[];
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}
export interface ModelRequest {
  name: string; // schema name
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}
export interface ModelResponse {
  json: unknown;
  usage: ModelUsage;
}

export type ReserveResult = 'ok' | 'too_fast' | 'user_daily_cap' | 'global_cap';

export interface EngineConfig {
  model: string;
  userDailyCallCap: number;
  globalDailyCallCap: number;
  globalDailyTokenCap: number;
  minRunIntervalSeconds: number;
}

export interface Deps {
  config: EngineConfig;
  getProfileInput(): Promise<RawProfileInput>;
  /** Discover feed through the caller's own JWT: the server's eligibility verdict. */
  listCandidates(): Promise<FeedRow[]>;
  getCache(): Promise<CacheState>;
  putAnalysis(inputHash: string, analysis: Analysis): Promise<void>;
  putMatches(rows: CachedMatch[]): Promise<void>;
  reserveRun(calls: number): Promise<ReserveResult>;
  recordTokens(usage: ModelUsage): Promise<void>;
  callModel(req: ModelRequest): Promise<ModelResponse>;
  /** Erase everything this user's cache holds (called when consent is not granted). */
  purgeDerived(): Promise<void>;
  /** Optional operational log: a COARSE code only, never prompt text or user data. */
  log?(code: string): void;
}

export type RecommendStatus =
  | 'ok'
  | 'consent_required'
  | 'insufficient_profile'
  | 'rate_limited'
  | 'busy'
  | 'budget_reached'
  | 'unavailable';

export interface Recommendation {
  campaign_id: string;
  verdict: 'strong' | 'good';
  explanation: string;
  evidence: Array<{ quote: string; relevance: string }>;
  unsupported_requirements: string[];
}

export interface RecommendResponse {
  status: RecommendStatus;
  recommendations: Recommendation[];
  /** How many currently-eligible campaigns were considered (never the whole feed). */
  evaluated: number;
  /** true when no model call was needed (everything came from this user's own cache). */
  from_cache: boolean;
  /** Short, validated summary of what the AI understood from the tester's own words (null if none yet). */
  understanding: { summary: string; areas: string[] } | null;
}
