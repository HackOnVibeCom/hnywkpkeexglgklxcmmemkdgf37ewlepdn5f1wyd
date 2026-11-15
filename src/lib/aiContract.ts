// UXBarter <-> AI services: the STABLE data contract (version 1).
//
// Owner of the data and of this file: the profile / qualification workstream. Consumer: the AI relevance-matching and
// professional-assessment services (a server-side component; real OpenAI calls are made ONLY there, never in the browser).
// Full written contract, security rules and an end-to-end example: docs/AI_INTEGRATION_CONTRACT.md.
//
// Types only (erasable TypeScript, no imports, no secrets): safe to import from the browser bundle and from a server.
// Changing a field's meaning or removing one = a new CONTRACT_VERSION and a new SQL function name; adding an optional
// field is backward compatible.

export const AI_CONTRACT_VERSION = 1 as const;

export type AiCategoryId = 'tech_savvy' | 'founders_builders' | 'business_office' | 'students_learners' | 'everyday_nontechnical';
export type AiCategoryKind = 'professional' | 'general';

/**
 * inactive            not in the tester's profile
 * incomplete          in the profile, the four answers for the CURRENT question version are missing / outdated
 * active              general: answers complete.  professional: answers complete AND a valid qualification decision
 * pending_assessment  professional, answers complete, no valid decision yet  <- the assessment queue
 * not_qualified       professional, a decision of "not_qualified" for exactly these answers
 */
export type AiCategoryState = 'inactive' | 'incomplete' | 'active' | 'pending_assessment' | 'not_qualified';

export interface AiAnswer {
  /** q1..q4, stable within a question version */
  question_id: 'q1' | 'q2' | 'q3' | 'q4';
  /** the exact question text that was answered (belongs to answers_version) */
  question: string;
  /** the tester's own words, 15-800 characters, whitespace-normalised. SENSITIVE: never log, never forward without consent */
  answer: string;
}

export interface AiQualification {
  status: 'qualified' | 'not_qualified';
  /** always ai_assessment: decided by the assessment service for these exact answers. (Passes of the retired multiple-choice screening never count.) */
  source: 'ai_assessment';
  decided_at: string;
}

export interface AiCategoryProfile {
  category: AiCategoryId;
  kind: AiCategoryKind;
  selected: boolean;
  state: AiCategoryState;
  /** the CURRENT question version for this category */
  question_version: number;
  /** the version the stored answers belong to (null when none) */
  answers_version: number | null;
  answers_complete: boolean;
  /** sha256 of (answers_version + the four answers). A decision is valid only for this exact hash. null when no answers */
  answers_hash: string | null;
  answers_updated_at: string | null;
  /** null unless consent is granted AND answers_complete */
  answers: AiAnswer[] | null;
  /** the VALID decision for these answers, or null */
  qualification: AiQualification | null;
}

/** Result of public.service_get_ai_profile(user_id). Server-only (service_role). */
export interface AiProfileV1 {
  contract_version: typeof AI_CONTRACT_VERSION;
  /**
   * Opaque random identifier: the ONLY identifier that may be sent to a third party (e.g. OpenAI `user`/metadata).
   * null unless consent is granted. Rotates when consent is granted again after a withdrawal.
   */
  subject_ref: string | null;
  consent: { ai_processing: boolean; policy_version: number; updated_at: string | null };
  /** null when the tester has no profile. bio is null unless consent is granted. The nickname is never part of the contract. */
  profile: { bio: string | null; categories: AiCategoryId[]; updated_at: string } | null;
  /** always five entries, canonical order */
  categories: AiCategoryProfile[];
  /** categories that currently count for matching / targeted eligibility */
  active_categories: AiCategoryId[];
  /** may reserve any task: at least one selected category has complete answers */
  participation_ready: boolean;
  /** max of every timestamp above */
  updated_at: string | null;
  /** sha256 cache key: changes iff consent, bio, categories, answers or decisions change. Use it for caching / invalidation. */
  etag: string;
}

/** Row of public.service_list_pending_assessments(limit): the work queue (consented, professional, answers complete, no valid decision). No answers inside. */
export interface PendingAssessment {
  user_id: string;
  subject_ref: string;
  category: Extract<AiCategoryId, 'tech_savvy' | 'founders_builders' | 'business_office'>;
  question_version: number;
  answers_hash: string;
  answers_updated_at: string;
}

/** Arguments of public.service_record_qualification(...). Refused (stale_assessment) unless version + hash match the CURRENT stored answers. */
export interface RecordQualificationArgs {
  p_user_id: string;
  p_category: PendingAssessment['category'];
  p_question_version: number;
  p_answers_hash: string;
  p_status: 'qualified' | 'not_qualified';
  /** optional, <= 4 KB, ONLY these keys. Must never contain the tester's answers or bio. */
  p_assessment?: { model?: string; rubric_version?: string; summary?: string; confidence?: number } | null;
}

/** Row of public.service_list_eligible_campaigns(user_id): campaigns the tester can ACT on (same rule the database enforces). */
export interface EligibleCampaign {
  campaign_id: string;
  project_name: string;
  description: string | null;
  task_description: string;
  created_at: string;
  expires_at: string;
  testing_mode: 'open' | 'targeted';
  target_categories: AiCategoryId[];
  /** required categories that are ACTIVE for this tester */
  match_categories: AiCategoryId[];
  reserved_by_me: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Browser <-> recommendation service (the AI service owns the ranking; the browser only renders it).
// ---------------------------------------------------------------------------------------------------------------

export interface AiRecommendation {
  campaign_id: string;
  /** why this campaign fits THIS tester, in plain language, shown to the tester (a paraphrase; verbatim quotes go in `evidence`) */
  reason: string;
  /** 0..1, optional and NEVER produced by the AI service (no numeric score exists: relevance is evidence-based); the UI never shows it as a promise */
  score?: number;
  // ---- optional extras produced by the AI service (the UI renders them when present) ----
  verdict?: 'strong' | 'good';
  /** verbatim quotes from the tester's OWN text, verified server-side, each with one sentence on why it is relevant */
  evidence?: { quote: string; relevance: string }[];
  /** what the campaign seems to need that the tester's profile does not clearly show */
  unsupported_requirements?: string[];
}

/**
 * ok                 `items` are the genuinely relevant, ACTIVELY ELIGIBLE campaigns (may be empty: an honest empty state)
 * unavailable        the service is not reachable / not deployed / switched off: the UI says so and offers "Browse all eligible tests"
 * consent_required   the tester has not allowed AI processing
 * profile_incomplete the tester has not completed an experience category yet (participation_ready is false), or has too little
 *                    text in ACTIVE categories (see `detail`)
 * rate_limited       the tester used today's AI allowance            busy  a previous request is still running
 * budget_reached     the service-wide daily budget is used up
 * (The last three were added by the AI service; each is a "not available right now" state for Discover.)
 */
export type RecommendationsResponse =
  | { status: 'ok'; generated_at: string; profile_etag: string; items: AiRecommendation[]; understanding?: { summary: string; areas: string[] } | null }
  | { status: 'profile_incomplete'; detail?: 'not_participation_ready' | 'too_little_text' }
  | { status: 'unavailable' | 'consent_required' | 'rate_limited' | 'busy' | 'budget_reached' };

// ---------------------------------------------------------------------------------------------------------------------
// Browser <-> assessment endpoint (same Edge Function, {"action":"assess"}). The browser can only ASK for the caller's own
// pending professional categories to be assessed; the decision itself is written by the server through
// service_record_qualification and can never be supplied by the browser.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * qualified            recorded: the category is now active (based on self-reported answers, not verified credentials)
 * not_qualified        recorded: no hands-on experience visible yet; the tester can still take open tasks, and may add true detail
 * needs_clarification  NOT recorded: the category stays pending; `clarification_questions` are neutral prompts
 * pending              could not be checked right now (error / limit); stays pending
 */
export type AssessmentOutcome = 'qualified' | 'not_qualified' | 'needs_clarification' | 'pending';

export interface AssessmentResult {
  category: Extract<AiCategoryId, 'tech_savvy' | 'founders_builders' | 'business_office'>;
  outcome: AssessmentOutcome;
  /** fixed, human-written text (never model text) */
  message: string;
  clarification_questions: string[];
  /** the public criteria this category is assessed against */
  criteria: string[];
}

export interface AssessmentResponse {
  status: 'ok' | 'consent_required' | 'rate_limited' | 'busy' | 'budget_reached' | 'unavailable';
  results: AssessmentResult[];
  generated_at?: string;
}
