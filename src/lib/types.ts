export type { TestingMode } from './matching';
import type { TestingMode } from './matching';

export interface Profile {
  id: string;
  credit_balance: number;
  created_at: string;
  /** Public referral code of this identity (absent until migration 5 is applied). */
  ref_code?: string;
}

export interface MyReferrals {
  code: string;
  cap: number;
  invited: number;
  /** Invitees who finished their first rewarded test. */
  converted: number;
  /** Rewards actually paid to me. */
  rewarded: number;
}

/** One row of the Discover feed (list_open_campaigns). Never contains the website URL or owner. */
export interface OpenCampaign {
  campaign_id: string;
  project_name: string;
  description: string | null;
  task_description: string;
  created_at: string;
  expires_at: string;
  /** I hold a live reservation on this task (so I can continue it). */
  reserved_by_me: boolean;
  reservation_expires_at: string | null;
}

/**
 * One row of the matched Discover feed (list_matched_campaigns): an OpenCampaign plus who the founder wanted.
 * match_categories = the founder's target categories that overlap MY categories (empty = not recommended).
 */
export type Fit = 'recommended' | 'eligible' | 'not_eligible';

export interface MatchedCampaign extends OpenCampaign {
  /** Open testing: PREFERRED categories (a recommendation hint). Targeted testing: REQUIRED categories. */
  target_categories: string[];
  match_categories: string[];
  is_recommended: boolean;
  /** Matching v2. Before migration 7 every campaign is treated as 'open' and eligible. */
  testing_mode: TestingMode;
  fit: Fit;
  eligible: boolean;
  ineligible_reason: string | null;
  missing_screening: string[];
}

/** get_campaign_eligibility: can I start this task, and if not, why (enforced server-side). */
export interface CampaignEligibility {
  campaign_id: string;
  testing_mode: TestingMode;
  required_categories: string[];
  eligible: boolean;
  /** open | eligible | in_progress | no_profile | category_mismatch | screening_required */
  reason: string;
  missing_screening: string[];
  overlap: string[];
  own_campaign: boolean;
}

export interface ScreeningQuestion {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
}

export interface Screening {
  category: string;
  version: number;
  /** How many of the question areas must report hands-on experience. */
  min_areas: number;
  qualified: boolean;
  max_attempts: number;
  attempts_left: number;
  questions: ScreeningQuestion[];
}

export interface ScreeningResult {
  passed: boolean;
  areas: number;
  min_areas: number;
  version: number;
  attempts_left: number;
}

export interface ScreeningStatus {
  category: string;
  version: number;
  qualified: boolean;
  qualified_at: string | null;
  attempts_left: number;
  next_attempt_at: string | null;
}

/** My OPTIONAL tester profile. Private: no other identity can read it. */
export interface TesterProfile {
  nickname: string;
  bio: string | null;
  categories: string[];
  updated_at: string;
}

export interface SaveTesterProfileInput {
  nickname: string;
  bio: string;
  categories: string[];
}

/** The Discover feed plus whether Targeted Tester Matching was available (false = old backend, plain feed). */
export interface DiscoverFeed {
  campaigns: MatchedCampaign[];
  matching: boolean;
  /** true when the backend supports Open vs Targeted testing (migration 7). */
  modes: boolean;
}

/** get_campaign_for_test. project_url is only present while the caller holds a live reservation. */
export interface CampaignForTest {
  campaign_id: string;
  project_name: string;
  project_url: string | null;
  description: string | null;
  task_description: string;
  created_at: string;
  expires_at: string;
  reserved_by_me: boolean;
  reserved_by_other: boolean;
  reservation_expires_at: string | null;
  /** Earliest moment feedback can be submitted (60 s after the first reservation). */
  min_submit_at: string | null;
  /** Server clock at the time of the call — use it to correct for client clock skew. */
  server_now: string;
}

export interface StartTestResult {
  campaign_id: string;
  reservation_expires_at: string;
  min_submit_at: string;
  server_now: string;
}

export interface MyStatus {
  server_now: string;
  rewards_24h: number;
  daily_limit: number;
  next_reward_slot_at: string | null;
  active_reservation: { campaign_id: string; expires_at: string } | null;
}

export interface CancelResult {
  status: 'cancelled' | 'expired';
  refunded: boolean;
  balance: number;
}

export type LedgerReason = 'starter' | 'test_reward' | 'campaign_spend' | 'campaign_refund' | 'referral_reward';

export interface LedgerEntry {
  id: number;
  delta: number;
  reason: LedgerReason;
  campaign_id: string | null;
  created_at: string;
}

export interface Submission {
  id: string;
  campaign_id: string;
  task_completed: boolean;
  friction: string;
  suggestion: string;
  ux_rating: number;
  share_consent: boolean;
  created_at: string;
}

export type CampaignStatus = 'open' | 'completed' | 'cancelled' | 'expired';

export interface MyCampaign {
  id: string;
  task_description: string;
  status: CampaignStatus;
  max_responses: number;
  response_count: number;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  closed_at: string | null;
  /** Preferred tester categories (absent / empty = anyone; also absent before migration 6 is applied). */
  target_categories?: string[];
  /** Matching v2 (absent before migration 7 = open). */
  testing_mode?: TestingMode;
  project: { name: string; url: string; description: string | null } | null;
  submissions: Submission[];
  /** A tester currently holds a live reservation (so Cancel is refused). Derived from RLS-visible rows. */
  being_tested: boolean;
}

export interface DashboardData {
  /** Real referral counts; null when unavailable (e.g. migration 5 not applied yet). */
  referrals?: MyReferrals | null;
  ledger: LedgerEntry[];
  testsCompleted: number;
  campaigns: MyCampaign[];
}

export interface SubmitTestInput {
  campaignId: string;
  taskCompleted: boolean;
  friction: string;
  suggestion: string;
  uxRating: number;
  shareConsent: boolean;
}

export interface SubmitTestResult {
  submission_id: string;
  credits_awarded: number;
  balance: number;
}

export interface CreateCampaignInput {
  name: string;
  url: string;
  description: string;
  task: string;
  /**
   * 'open' (default): categories are optional PREFERENCES (recommendation only).
   * 'targeted': categories are REQUIRED; only eligible testers can start the task.
   */
  mode?: TestingMode;
  targetCategories?: string[];
}
