export interface Profile {
  id: string;
  credit_balance: number;
  created_at: string;
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

export type LedgerReason = 'starter' | 'test_reward' | 'campaign_spend' | 'campaign_refund';

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
  project: { name: string; url: string; description: string | null } | null;
  submissions: Submission[];
  /** A tester currently holds a live reservation (so Cancel is refused). Derived from RLS-visible rows. */
  being_tested: boolean;
}

export interface DashboardData {
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
}
