import { getSupabase } from './supabase';
import { DAILY_REWARD_CAP, MIN_TEST_SECONDS, RESERVATION_MINUTES } from './limits';
import type {
  CampaignForTest,
  CancelResult,
  CreateCampaignInput,
  DashboardData,
  LedgerEntry,
  MyCampaign,
  MyReferrals,
  MyStatus,
  OpenCampaign,
  Profile,
  StartTestResult,
  SubmitTestInput,
  SubmitTestResult,
  Submission,
} from './types';

/** Error carrying the machine-readable code raised by our SQL RPCs (e.g. "insufficient_credits"). */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    /** Extra data raised with the error (e.g. seconds left for too_fast, blocking campaign id). */
    public readonly detail?: string,
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
  campaign_closed: 'This task is no longer open (it was completed, cancelled or expired). No credit was spent or earned — pick another task.',
  own_campaign: 'You cannot test your own project.',
  already_tested: 'Your feedback for this task was already recorded and your credit was awarded — nothing more to do here.',
  campaign_expired: 'This task has expired and can no longer be started.',
  campaign_reserved: 'Another tester is working on this task right now. Please try again in a few minutes, or pick another task.',
  reservation_exists: 'You already have a test in progress. Finish it (or let it time out) before starting another one.',
  reservation_required: 'Reserve this task first, then submit your feedback.',
  reservation_expired: `Your ${RESERVATION_MINUTES}-minute reservation ran out. Your answers are still here — reserve the task again to submit them.`,
  reservation_limit: 'You have already reserved this task three times. Please pick another task.',
  daily_limit: `You have reached today’s limit of ${DAILY_REWARD_CAP} rewarded tests (rolling 24 hours). You can start testing again when the oldest one is more than 24 hours old.`,
  refund_not_found: 'Could not refund this request. Nothing was changed — please contact support.',
  captcha_script_failed: 'Could not load the human check (Cloudflare Turnstile). Disable content blockers for this site, check your connection, and try again.',
  captcha_failed: 'The human check failed. Please try again.',
  captcha_timeout: 'The human check timed out. Please try again.',
};

export function friendlyError(e: unknown): string {
  if (e instanceof ApiError && e.code === 'too_fast') {
    const left = Number(e.detail);
    const wait = Number.isFinite(left) && left > 0 ? ` About ${Math.ceil(left)} more second${Math.ceil(left) === 1 ? '' : 's'}.` : '';
    return `Please spend at least ${MIN_TEST_SECONDS} seconds actually testing before you submit.${wait}`;
  }
  if (e instanceof ApiError && e.code && FRIENDLY[e.code]) return FRIENDLY[e.code];
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && FRIENDLY[e.message]) return FRIENDLY[e.message];
  if (/captcha/i.test(msg)) return 'The human check was not accepted. Please reload the page and try again.';
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
  if (error) throw new ApiError(error.message, error.message, error.details ?? undefined);
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

export const getMyStatus = () => rpc<MyStatus>('get_my_status');

export const startTest = (campaignId: string) => rpc<StartTestResult>('start_test', { p_campaign_id: campaignId });

export const cancelCampaign = (campaignId: string) => rpc<CancelResult>('cancel_campaign', { p_campaign_id: campaignId });

export const getMyReferrals = () => rpc<MyReferrals>('get_my_referrals');

/** Pays referrers whose invitee finished a first test. Same contract as settleExpiredCampaigns: never throws. */
export async function settleReferralRewards(): Promise<number> {
  try {
    return (await rpc<number>('settle_referral_rewards')) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Expires + refunds campaigns past their deadline that nobody is testing. Idempotent and bounded
 * server-side; any signed-in client may call it. Returns how many campaigns were settled.
 * Failures are deliberately swallowed: settlement is housekeeping and must never block a page.
 */
export async function settleExpiredCampaigns(): Promise<number> {
  try {
    return (await rpc<number>('settle_expired_campaigns')) ?? 0;
  } catch {
    return 0;
  }
}

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

/** Housekeeping on page load: expire+refund overdue campaigns and pay due referral rewards. Returns how many things changed. */
export async function settleAll(): Promise<number> {
  const [a, b] = await Promise.all([settleExpiredCampaigns(), settleReferralRewards()]);
  return a + b;
}

export async function fetchDashboard(): Promise<DashboardData> {
  const sb = getSupabase();

  const [ledgerRes, rewardCountRes, campaignsRes, reservationsRes] = await Promise.all([
    sb
      .from('credit_ledger')
      .select('id,delta,reason,campaign_id,created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    sb.from('credit_ledger').select('id', { count: 'exact', head: true }).eq('reason', 'test_reward'),
    sb
      .from('campaigns')
      .select(
        'id,task_description,status,max_responses,response_count,created_at,expires_at,completed_at,closed_at,project:projects(name,url,description)',
      )
      .order('created_at', { ascending: false }),
    // Founders may see THAT a test is in progress (never who): tester_id is not granted.
    sb.from('test_reservations').select('campaign_id,expires_at,consumed_at').is('consumed_at', null),
  ]);

  for (const r of [ledgerRes, rewardCountRes, campaignsRes, reservationsRes]) {
    if (r.error) throw new ApiError(r.error.message, r.error.code);
  }

  const rawCampaigns = (campaignsRes.data ?? []) as unknown as Omit<MyCampaign, 'submissions' | 'being_tested'>[];
  const nowMs = Date.now();
  const beingTested = new Set(
    ((reservationsRes.data ?? []) as { campaign_id: string; expires_at: string }[])
      .filter((r) => Date.parse(r.expires_at) > nowMs)
      .map((r) => r.campaign_id),
  );
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
      being_tested: beingTested.has(c.id),
    })),
  };
}
