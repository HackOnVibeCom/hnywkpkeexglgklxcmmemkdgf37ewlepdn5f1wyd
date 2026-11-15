import { getSupabase } from './supabase';
import { DAILY_REWARD_CAP, MIN_TEST_SECONDS, RESERVATION_MINUTES } from './limits';
import { CaptchaError } from './turnstile';
import type {
  CampaignEligibility,
  CampaignForTest,
  CancelResult,
  CreateCampaignInput,
  DashboardData,
  DiscoverFeed,
  LedgerEntry,
  MatchedCampaign,
  MyCampaign,
  MyReferrals,
  MyStatus,
  OpenCampaign,
  Profile,
  SaveTesterProfileInput,
  Screening,
  ScreeningResult,
  ScreeningStatus,
  StartTestResult,
  SubmitTestInput,
  SubmitTestResult,
  Submission,
  TesterProfile,
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
  invalid_nickname: 'Nickname must be 2–30 characters, without control characters.',
  invalid_bio: 'The short bio must be 280 characters or fewer, without control characters.',
  not_eligible: 'You are not eligible to start this task.',
  targeted_requires_categories: 'Targeted testing needs at least one tester category. Choose one, or switch to open testing.',
  invalid_mode: 'Choose open or targeted testing.',
  screening_not_required: 'This category has no screening: just add it to your tester profile.',
  screening_unavailable: 'This screening is not available right now. Please try again later.',
  already_screened: 'You have already completed this screening.',
  invalid_answers: 'Please answer every question. Choose "None of these" if nothing applies, and do not combine it with other choices.',
  matching_unavailable: 'Targeted Tester Matching is not available on this server yet. Everything else works as before.',
  invalid_categories: 'One of the selected categories is not valid. Reload the page and choose from the list.',
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

function captchaMessage(e: CaptchaError): string {
  const code = e.code ? ` (Cloudflare code ${e.code})` : '';
  switch (e.kind) {
    case 'config':
      return `The human check is not set up correctly for this website${code}. This is a site configuration problem, not something you did — please tell the site owner.`;
    case 'challenge':
      return `The human check could not be completed${code}. Cloudflare did not accept this browser session. Try again, use a regular (non-private) window, turn off a VPN or privacy extensions for this site, or try another browser or network.`;
    case 'timeout':
      return 'The human check timed out. Please try again.';
    default:
      return FRIENDLY.captcha_script_failed;
  }
}

export function friendlyError(e: unknown): string {
  if (e instanceof CaptchaError) return captchaMessage(e);
  if (e instanceof ApiError && e.code === 'too_fast') {
    const left = Number(e.detail);
    const wait = Number.isFinite(left) && left > 0 ? ` About ${Math.ceil(left)} more second${Math.ceil(left) === 1 ? '' : 's'}.` : '';
    return `Please spend at least ${MIN_TEST_SECONDS} seconds actually testing before you submit.${wait}`;
  }
  if (e instanceof ApiError && e.code === 'not_eligible') {
    if (e.detail === 'no_profile') return 'This task is for specific kinds of testers. Add a tester profile with a matching category first.';
    if (e.detail === 'category_mismatch') return 'Your tester profile does not match this task’s required categories.';
    if (e.detail === 'screening_required') return 'This task needs a completed screening for one of its categories first. You can take it on your tester profile page.';
  }
  if (e instanceof ApiError && e.code === 'screening_rate_limited') {
    const at = e.detail ? new Date(e.detail.replace(' ', 'T')) : null;
    const when = at && !Number.isNaN(at.getTime()) ? ` You can try again after ${at.toLocaleString()}.` : ' Please try again later.';
    return `You have used all 3 screening attempts for the last 24 hours.${when}`;
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

/** True when the backend simply does not have the function yet (migration not applied): PostgREST says so in the message. */
const isMissingFunction = (e: unknown) => e instanceof Error && /could not find the function|PGRST202|schema cache/i.test(e.message);

type V1Row = Omit<MatchedCampaign, 'testing_mode' | 'fit' | 'eligible' | 'ineligible_reason' | 'missing_screening'>;
const asOpen = (c: V1Row): MatchedCampaign => ({
  ...c,
  testing_mode: 'open',
  fit: c.is_recommended ? 'recommended' : 'eligible',
  eligible: true,
  ineligible_reason: null,
  missing_screening: [],
});

/**
 * Discover feed. Newest backend first (list_campaigns_v2: Open vs Targeted + eligibility), then Matching v1
 * (list_matched_campaigns), then the plain feed. Each step is only used when the previous function does not exist
 * yet (UI deployed before its database migration), so Discover never breaks on a missing function.
 */
export async function listDiscoverCampaigns(): Promise<DiscoverFeed> {
  try {
    const rows = await rpc<Omit<MatchedCampaign, 'is_recommended'>[]>('list_campaigns_v2');
    return { campaigns: rows.map((r) => ({ ...r, is_recommended: r.fit === 'recommended' })), matching: true, modes: true };
  } catch (e) {
    if (!isMissingFunction(e)) throw e;
  }
  try {
    const rows = await rpc<V1Row[]>('list_matched_campaigns');
    return { campaigns: rows.map(asOpen), matching: true, modes: false };
  } catch (e) {
    if (!isMissingFunction(e)) throw e;
    const plain = await listOpenCampaigns();
    return {
      campaigns: plain.map((c) => asOpen({ ...c, target_categories: [], match_categories: [], is_recommended: false })),
      matching: false,
      modes: false,
    };
  }
}

/** Eligibility of the caller for one task, or null when the backend predates Open/Targeted testing (= open). */
export async function getCampaignEligibility(campaignId: string): Promise<CampaignEligibility | null> {
  try {
    return await rpc<CampaignEligibility | null>('get_campaign_eligibility', { p_campaign_id: campaignId });
  } catch (e) {
    if (isMissingFunction(e)) return null;
    throw e;
  }
}

/** Screening questions of a professional category (server-held, versioned). */
export const getScreening = (category: string) => matchingRpc<Screening>('get_screening', { p_category: category });

export const submitScreening = (category: string, answers: Record<string, string[]>) =>
  matchingRpc<ScreeningResult>('submit_screening', { p_category: category, p_answers: answers });

/** My screening status per professional category; [] on a backend without screening. */
export async function getMyScreeningStatus(): Promise<ScreeningStatus[]> {
  try {
    return (await rpc<ScreeningStatus[]>('get_my_screening_status')) ?? [];
  } catch (e) {
    if (isMissingFunction(e)) return [];
    throw e;
  }
}

/** My optional tester profile, or null when I have not created one (or the backend predates matching). */
export async function getMyTesterProfile(): Promise<TesterProfile | null> {
  try {
    const rows = await rpc<TesterProfile[]>('get_my_tester_profile');
    return rows[0] ?? null;
  } catch (e) {
    if (isMissingFunction(e)) return null;
    throw e;
  }
}

/** Runs an RPC that only exists after migration 6; a missing function becomes one friendly, accurate message. */
async function matchingRpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await rpc<T>(fn, args);
  } catch (e) {
    if (isMissingFunction(e)) throw new ApiError('matching_unavailable', 'matching_unavailable');
    throw e;
  }
}

export async function saveTesterProfile(i: SaveTesterProfileInput): Promise<TesterProfile> {
  const rows = await matchingRpc<TesterProfile[]>('save_tester_profile', { p_nickname: i.nickname, p_bio: i.bio, p_categories: i.categories });
  return rows[0];
}

export const deleteTesterProfile = () => matchingRpc<boolean>('delete_my_tester_profile');

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

/**
 * Without target categories this is EXACTLY the original call (so nothing changes for anyone who does not use
 * targeting). With categories it uses create_targeted_campaign: validated first, then the same credit logic.
 */
export const createCampaign = (i: CreateCampaignInput) =>
  i.mode === 'targeted'
    ? matchingRpc<string>('create_campaign_v2', {
        p_name: i.name,
        p_url: i.url,
        p_description: i.description,
        p_task: i.task,
        p_mode: 'targeted',
        p_categories: i.targetCategories ?? [],
      })
    : i.targetCategories && i.targetCategories.length > 0
    ? matchingRpc<string>('create_targeted_campaign', {
        p_name: i.name,
        p_url: i.url,
        p_description: i.description,
        p_task: i.task,
        p_target_categories: i.targetCategories,
      })
    : rpc<string>('create_project_with_campaign', {
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

  const CAMPAIGN_COLS =
    'id,task_description,status,max_responses,response_count,created_at,expires_at,completed_at,closed_at,project:projects(name,url,description)';
  const fetchCampaigns = async () => {
    // Newest columns first; a backend without migration 7 (testing_mode) or 6 (target_categories) answers 42703
    // (undefined column): retry with fewer columns.
    for (const extra of [',target_categories,testing_mode', ',target_categories', '']) {
      const res = await sb.from('campaigns').select(`${CAMPAIGN_COLS}${extra}`).order('created_at', { ascending: false });
      if (!res.error || !(res.error.code === '42703' || /target_categories|testing_mode/.test(res.error.message))) return res;
    }
    return sb.from('campaigns').select(CAMPAIGN_COLS).order('created_at', { ascending: false });
  };

  const [ledgerRes, rewardCountRes, campaignsRes, reservationsRes] = await Promise.all([
    sb
      .from('credit_ledger')
      .select('id,delta,reason,campaign_id,created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    sb.from('credit_ledger').select('id', { count: 'exact', head: true }).eq('reason', 'test_reward'),
    fetchCampaigns(),
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
