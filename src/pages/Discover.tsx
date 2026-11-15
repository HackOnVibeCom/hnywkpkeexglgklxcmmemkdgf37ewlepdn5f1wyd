import { fetchProfile, getMyStatus, getMyTesterProfile, listDiscoverCampaigns, settleAll } from '../lib/api';
import { timeAgo, timeLeft } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { useNow } from '../lib/useNow';
import { useAuth } from '../context/AuthContext';
import { Alert, Button, ButtonLink, EmptyState, PageHeader, Spinner } from '../components/ui';
import { CategoryBadges } from '../components/CategoryPicker';
import { categoryLabel } from '../lib/matching';
import { DAILY_REWARD_CAP, RESERVATION_MINUTES } from '../lib/limits';
import type { MatchedCampaign, MyStatus, TesterProfile } from '../lib/types';

interface DiscoverData {
  campaigns: MatchedCampaign[];
  status: MyStatus | null;
  /** My optional tester profile (null = none, or the backend predates matching). */
  tester: TesterProfile | null;
  /** false when the backend has no matching function yet: the plain feed is shown and no matching UI appears. */
  matching: boolean;
}

export function Discover() {
  const { profile, setBalance } = useAuth();
  const nowMs = useNow(30_000);

  const { data, error, loading, reload } = useLoad<DiscoverData>(async () => {
    // Housekeeping first: expire + refund dead campaigns so they never clutter the list. If anything was
    // settled (possibly our own request), re-read the authoritative balance.
    const settled = await settleAll();
    if (settled > 0) {
      fetchProfile()
        .then((p) => setBalance(p.credit_balance))
        .catch(() => undefined);
    }
    const [feed, status, tester] = await Promise.all([
      listDiscoverCampaigns(),
      getMyStatus().catch(() => null),
      getMyTesterProfile().catch(() => null),
    ]);
    return { campaigns: feed.campaigns, status, tester, matching: feed.matching };
  });

  const status = data?.status ?? null;
  const atCap = status !== null && status.rewards_24h >= status.daily_limit;
  const cap = status?.daily_limit ?? DAILY_REWARD_CAP;
  const myCategories = data?.tester?.categories ?? [];
  const recommendedCount = data?.campaigns.filter((c) => c.is_recommended).length ?? 0;

  return (
    <>
      <PageHeader
        title="Discover tasks"
        subtitle="Pick a task, try the product for 2–3 minutes, and earn 1 Test Credit when you submit honest feedback."
        action={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="mb-6">
          <Alert tone="error" title="Could not load tasks">
            {error}
          </Alert>
        </div>
      )}

      {status && (
        <div className="mb-6">
          {atCap ? (
            <Alert tone="warning" title={`Daily reward limit reached (${status.rewards_24h}/${cap})`}>
              To keep the exchange fair, each identity can earn credits for {cap} tests per rolling 24 hours.
              {status.next_reward_slot_at && <> Your next slot opens in {timeLeft(status.next_reward_slot_at, nowMs).replace(' left', '')}.</>}
            </Alert>
          ) : (
            <p className="text-sm text-slate-500">
              Rewarded tests in the last 24 h: <strong className="text-slate-700">{status.rewards_24h}</strong> of {cap}.
              Reserving a task holds it for you for {RESERVATION_MINUTES} minutes.
            </p>
          )}
        </div>
      )}

      {data?.matching && (
        <div className="mb-6" data-testid="matching-note">
          {myCategories.length > 0 ? (
            <p className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
              <strong>Targeted Tester Matching is on</strong> for {myCategories.map(categoryLabel).join(', ')}.{' '}
              {recommendedCount > 0
                ? `${recommendedCount} task${recommendedCount === 1 ? ' is' : 's are'} recommended for you and listed first; `
                : 'No task asked for your categories right now; '}
              every other open task is still below.{' '}
              <ButtonLink to="/profile" variant="ghost" className="!px-1 !py-0 underline">
                Edit profile
              </ButtonLink>
            </p>
          ) : (
            <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
              <strong className="text-slate-900">Want tasks that fit you?</strong> Add an optional tester profile and founders’
              requests for people like you are listed first. No account, nothing public.{' '}
              <ButtonLink to="/profile" variant="ghost" className="!px-1 !py-0 underline">
                Set up my tester profile
              </ButtonLink>
            </p>
          )}
        </div>
      )}

      {loading && !data && <Spinner label="Loading tasks…" />}

      {data && data.campaigns.length === 0 && (
        <EmptyState
          title="No open tasks right now"
          action={
            <ButtonLink to="/create">{(profile?.credit_balance ?? 0) > 0 ? 'Post the first one' : 'Request a test'}</ButtonLink>
          }
        >
          Every task here is posted by a real founder, so the list can be empty. Tasks you posted yourself, ones you
          have already tested, expired tasks and ones someone else is testing right now are never shown.
        </EmptyState>
      )}

      {data && data.campaigns.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {data.campaigns.map((c) => (
            <li
              key={c.campaign_id}
              data-recommended={c.is_recommended ? 'true' : 'false'}
              className={`flex flex-col rounded-xl border bg-white p-5 ${c.is_recommended ? 'border-indigo-300 ring-1 ring-indigo-200' : 'border-slate-200'}`}
            >
              {c.is_recommended && (
                <p className="mb-2">
                  <span
                    data-testid="recommended-badge"
                    className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2.5 py-0.5 text-xs font-semibold text-white"
                  >
                    <span aria-hidden>★</span> Recommended for you
                  </span>
                </p>
              )}
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 break-words font-semibold text-slate-900">{c.project_name}</h2>
                <span className="shrink-0 text-xs text-slate-500">{timeAgo(c.created_at)}</span>
              </div>
              {c.description && <p className="mt-1 line-clamp-2 break-words text-sm text-slate-500">{c.description}</p>}
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Your task</p>
              <p className="mt-1 line-clamp-4 flex-1 break-words text-sm text-slate-800">{c.task_description}</p>
              {data.matching && c.target_categories.length > 0 && (
                <div className="mt-3" data-testid="looking-for">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Looking for testers like</p>
                  <CategoryBadges ids={c.target_categories} highlight={c.match_categories} className="mt-1.5" />
                  {c.is_recommended && (
                    <p className="mt-1.5 text-xs text-indigo-800">
                      Why: your profile includes {c.match_categories.map(categoryLabel).join(', ')}.
                    </p>
                  )}
                </div>
              )}
              <div className="mt-5 flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-emerald-700">
                  {c.reserved_by_me ? (
                    <span className="text-indigo-700">In progress — yours</span>
                  ) : (
                    <>Earn 1 credit · ~3 min</>
                  )}
                  <span className="block text-xs font-normal text-slate-400">
                    {c.reserved_by_me && c.reservation_expires_at
                      ? `Reservation: ${timeLeft(c.reservation_expires_at, nowMs)}`
                      : `Task ${timeLeft(c.expires_at, nowMs)}`}
                  </span>
                </span>
                {atCap && !c.reserved_by_me ? (
                  <Button disabled>Limit reached</Button>
                ) : (
                  <ButtonLink to={`/test/${c.campaign_id}`}>{c.reserved_by_me ? 'Continue test' : 'Start test'}</ButtonLink>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
