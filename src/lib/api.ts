import { getSupabase } from './supabase';
import type {
  CampaignForTest,
  CreateCampaignInput,
  DashboardData,
  LedgerEntry,
  MyCampaign,
  OpenCampaign,
  Profile,
  SubmitTestInput,
  SubmitTestResult,
  Submission,
} from './types';

/** Error carrying the machine-readable code raised by our SQL RPCs (e.g. "insufficient_credits"). */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const FRIENDLY: Record<string, string> = {
  not_authenticated: 'Your anonymous session is not ready yet. Reload the page and try again.',
  profile_missing: 'Your account is still being set up. Reload the page and try again.',
  invalid_name: 'Project name must be 2–80 characters.',
  invalid_url: 'Enter a public website URL starting with http:// or https:// (no localhost or IP addresses).',
  invalid_description: 'Description must be 500 characters or fewer.',
  invalid_task: 'The task must be 20–600 characters so a tester knows exactly what to do.',
  invalid_feedback: 'Please answer every question — the two text answers need at least 10 characters.',
  invalid_rating: 'Choose a rating from 1 to 5.',
  insufficient_credits: 'You need 1 credit to request a test. Test someone else’s product to earn one.',
  campaign_not_found: 'This task no longer exists.',
  campaign_closed: 'Someone else just completed this task first, so it is closed. No credit was spent or earned — pick another task.',
  own_campaign: 'You cannot test your own project.',
  already_tested: 'You already tested this task.',
};

export function friendlyError(e: unknown): string {
  if (e instanceof ApiError && e.code && FRIENDLY[e.code]) return FRIENDLY[e.code];
  const msg = e instanceof Error ? e.message : String(e);
  if (/anonymous sign-ins are disabled/i.test(msg)) {
    return 'Anonymous sign-ins are disabled in the Supabase project. Enable them under Authentication → Sign In / Providers → Allow anonymous sign-ins.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  return msg || 'Something went wrong. Please try again.';
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) throw new ApiError(error.message, error.message);
  return data as T;
}

// NOTE: explicit column lists — tester_id is deliberately not granted to clients,
// so `select *` on test_submissions would be rejected by Postgres.
const SUBMISSION_COLS =
  'id,campaign_id,task_completed,friction,suggestion,ux_rating,share_consent,created_at';

export const ensureProfile = () => rpc<Profile>('ensure_profile');

export async function fetchProfile(): Promise<Profile> {
  const { data, error } = await getSupabase().from('profiles').select('id,credit_balance,created_at').single();
  if (error) throw new ApiError(error.message, error.code);
  return data as Profile;
}

export const listOpenCampaigns = () => rpc<OpenCampaign[]>('list_open_campaigns');

export async function getCampaignForTest(campaignId: string): Promise<CampaignForTest | null> {
  const rows = await rpc<CampaignForTest[]>('get_campaign_for_test', { p_campaign_id: campaignId });
  return rows[0] ?? null;
}

export const createCampaign = (i: CreateCampaignInput) =>
  rpc<string>('create_project_with_campaign', {
    p_name: i.name,
    p_url: i.url,
    p_description: i.description,
    p_task: i.task,
  });

export const submitTest = (i: SubmitTestInput) =>
  rpc<SubmitTestResult>('submit_test', {
    p_campaign_id: i.campaignId,
    p_task_completed: i.taskCompleted,
    p_friction: i.friction,
    p_suggestion: i.suggestion,
    p_ux_rating: i.uxRating,
    p_share_consent: i.shareConsent,
  });

export async function fetchDashboard(): Promise<DashboardData> {
  const sb = getSupabase();

  const [ledgerRes, rewardCountRes, campaignsRes] = await Promise.all([
    sb
      .from('credit_ledger')
      .select('id,delta,reason,campaign_id,created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    sb.from('credit_ledger').select('id', { count: 'exact', head: true }).eq('reason', 'test_reward'),
    sb
      .from('campaigns')
      .select(
        'id,task_description,status,max_responses,response_count,created_at,completed_at,project:projects(name,url,description)',
      )
      .order('created_at', { ascending: false }),
  ]);

  for (const r of [ledgerRes, rewardCountRes, campaignsRes]) {
    if (r.error) throw new ApiError(r.error.message, r.error.code);
  }

  const rawCampaigns = (campaignsRes.data ?? []) as unknown as Omit<MyCampaign, 'submissions'>[];
  const ids = rawCampaigns.map((c) => c.id);

  let submissions: Submission[] = [];
  if (ids.length > 0) {
    const { data, error } = await sb
      .from('test_submissions')
      .select(SUBMISSION_COLS)
      .in('campaign_id', ids)
      .order('created_at', { ascending: false });
    if (error) throw new ApiError(error.message, error.code);
    submissions = (data ?? []) as Submission[];
  }

  return {
    ledger: (ledgerRes.data ?? []) as LedgerEntry[],
    testsCompleted: rewardCountRes.count ?? 0,
    campaigns: rawCampaigns.map((c) => ({
      ...c,
      submissions: submissions.filter((s) => s.campaign_id === c.id),
    })),
  };
}
