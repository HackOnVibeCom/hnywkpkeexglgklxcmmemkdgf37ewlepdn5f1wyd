export interface Profile {
  id: string;
  credit_balance: number;
  created_at: string;
}

export interface OpenCampaign {
  campaign_id: string;
  project_name: string;
  description: string | null;
  task_description: string;
  created_at: string;
}

export interface CampaignForTest extends OpenCampaign {
  project_url: string;
}

export type LedgerReason = 'starter' | 'test_reward' | 'campaign_spend';

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

export type CampaignStatus = 'open' | 'completed' | 'cancelled';

export interface MyCampaign {
  id: string;
  task_description: string;
  status: CampaignStatus;
  max_responses: number;
  response_count: number;
  created_at: string;
  completed_at: string | null;
  project: { name: string; url: string; description: string | null } | null;
  submissions: Submission[];
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
