// Shared types for the AI engine (matching + professional assessment). Erasable TypeScript only (no enums / parameter
// properties) so the same files run unchanged in Deno (Supabase Edge Functions) and in plain Node (unit tests).

export type CategoryId = 'tech_savvy' | 'founders_builders' | 'business_office' | 'students_learners' | 'everyday_nontechnical';
export type ProfessionalCategory = 'tech_savvy' | 'founders_builders' | 'business_office';

// ---------------------------------------------------------------------------------------------------------------------
// Input mapped from the profile workstream's contract (service_get_ai_profile, v1) by contract.ts.
// ---------------------------------------------------------------------------------------------------------------------

/** What matching may know about a tester. All of it is voluntary, self-reported text. */
export interface RawProfileInput {
  consent: boolean;
  /** Opaque id that may leave the server; every cached row is bound to it. null without consent. */
  subject_ref: string | null;
  /** Contract cache key: changes iff consent, subject_ref, bio, categories, answers or decisions change. */
  etag: string | null;
  /** At least one selected category has its four answers. Required to reserve ANY task. */
  participation_ready: boolean;
  has_profile: boolean;
  bio: string | null;
  /** Selected categories. */
  categories: string[];
  /** Question/answer pairs of ACTIVE categories only (general: complete; professional: complete AND qualified). */
  answers: Array<{ category: string; question: string; answer: string }>;
}

export interface AssessmentTarget {
  category: ProfessionalCategory;
  question_version: number;
  answers_hash: string;
  answers: Array<{ question_id: string; question: string; answer: string }>;
}

export interface AssessmentInput {
  consent: boolean;
  subject_ref: string | null;
  bio: string | null;
  /** Professional categories in state pending_assessment with all four answers readable. */
  targets: AssessmentTarget[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------------------------

/** The ONLY tester data that is ever sent to the model for matching. No user id, no nickname, no token, no subject_ref. */
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

/** Dependencies both services share. */
export interface CommonDeps {
  config: EngineConfig;
  /** Apply the profile workstream's erasure events to everything this service keeps (called at the start of every request). */
  applyErasures(): Promise<void>;
  /** Erase everything derived for this user (consent not granted). */
  purgeDerived(): Promise<void>;
  reserveRun(calls: number): Promise<ReserveResult>;
  /** Is AI consent granted RIGHT NOW for exactly this subject_ref? Asked immediately before EVERY model request. */
  consentActive(subjectRef: string): Promise<boolean>;
  recordTokens(usage: ModelUsage): Promise<void>;
  callModel(req: ModelRequest): Promise<ModelResponse>;
  /** Optional operational log: a COARSE code only, never prompt text or user data. */
  log?(code: string): void;
}

export interface Deps extends CommonDeps {
  getProfileInput(): Promise<RawProfileInput>;
  /** Discover feed through the caller's own JWT: the server's eligibility verdict. */
  listCandidates(): Promise<FeedRow[]>;
  getCache(subjectRef: string): Promise<CacheState>;
  putAnalysis(subjectRef: string, inputHash: string, analysis: Analysis): Promise<void>;
  putMatches(subjectRef: string, rows: CachedMatch[]): Promise<void>;
}

export type RecommendStatus =
  | 'ok'
  | 'consent_required'
  | 'profile_incomplete'
  | 'rate_limited'
  | 'busy'
  | 'budget_reached'
  | 'unavailable';

/** Item of the browser contract (RecommendationsResponse.items): `reason` is the contract field; the rest are optional extras. */
export interface Recommendation {
  campaign_id: string;
  reason: string;
  verdict: 'strong' | 'good';
  evidence: Array<{ quote: string; relevance: string }>;
  unsupported_requirements: string[];
}

export interface RecommendResponse {
  status: RecommendStatus;
  items: Recommendation[];
  generated_at: string;
  /** The contract etag the result was computed for ('' when none). */
  profile_etag: string;
  /** Extra detail for the UI when status is profile_incomplete. */
  detail?: 'not_participation_ready' | 'too_little_text';
  /** How many currently-eligible campaigns were considered (never the whole feed). */
  evaluated: number;
  /** true when no model call was needed (everything came from this user's own cache). */
  from_cache: boolean;
  /** Short, validated summary of what the AI understood from the tester's own words (null if none yet). */
  understanding: { summary: string; areas: string[] } | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Professional assessment
// ---------------------------------------------------------------------------------------------------------------------

export type AssessOutcome = 'qualified' | 'not_qualified' | 'needs_clarification' | 'pending';

export interface AssessResult {
  category: ProfessionalCategory;
  outcome: AssessOutcome;
  /** Fixed, human-written text (never model text): self-reported, not verified. */
  message: string;
  /** Short, sanitized follow-up prompts for needs_clarification. */
  clarification_questions: string[];
  /** The public, category-specific criteria the assessment uses. */
  criteria: string[];
}

export type AssessStatus = 'ok' | 'consent_required' | 'rate_limited' | 'busy' | 'budget_reached' | 'unavailable';

export interface AssessResponse {
  status: AssessStatus;
  results: AssessResult[];
  generated_at: string;
}

export interface RecordQualificationArgs {
  category: ProfessionalCategory;
  question_version: number;
  answers_hash: string;
  status: 'qualified' | 'not_qualified';
  assessment: { model: string; rubric_version: string; summary: string; confidence: number };
}

export interface AssessNote {
  category: string;
  answers_hash: string;
  payload: { clarification_questions: string[]; key?: string; question_version?: number };
}

export interface AssessDeps extends CommonDeps {
  getAssessmentInput(): Promise<AssessmentInput>;
  getNotes(subjectRef: string): Promise<AssessNote[]>;
  putNote(subjectRef: string, category: ProfessionalCategory, answersHash: string, payload: AssessNote['payload']): Promise<void>;
  /** The ONLY write path for a professional-category decision (service_record_qualification). May throw stale_assessment / consent_required. */
  recordQualification(args: RecordQualificationArgs): Promise<void>;
}
