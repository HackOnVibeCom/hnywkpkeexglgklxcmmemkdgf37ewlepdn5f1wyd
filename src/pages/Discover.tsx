import { fetchProfile, getMyStatus, getMyTesterProfile, listDiscoverCampaigns, settleAll } from '../lib/api';
import { timeAgo, timeLeft } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { useNow } from '../lib/useNow';
import { useAuth } from '../context/AuthContext';
import { Alert, Button, ButtonLink, EmptyState, PageHeader, Spinner } from '../components/ui';
import { CategoryBadges } from '../components/CategoryPicker';
import { ModeBadge } from '../components/Eligibility';
import { AiRecommendations, BrowseAllHeading } from '../components/ai/AiRecommendations';
import { categoryLabel, shortReason } from '../lib/matching';
import { DAILY_REWARD_CAP, RESERVATION_MINUTES } from '../lib/limits';
import type { MatchedCampaign, MyStatus, TesterProfile } from '../lib/types';

interface DiscoverData {
  campaigns: MatchedCampaign[];
  status: MyStatus | null;
  /** My optional tester profile (null = none, or the backend predates matching). */
  tester: TesterProfile | null;
  /** false when the backend has no matching function yet: the plain feed is shown and no matching UI appears. */
  matching: boolean;
  /** true when the backend supports Open vs Targeted testing (migration 7). */
  modes: boolean;
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
    return { campaigns: feed.campaigns, status, tester, matching: feed.matching, modes: feed.modes };
  });

  const status = data?.status ?? null;
  const atCap = status !== null && status.rewards_24h >= status.daily_limit;
  const cap = status?.daily_limit ?? DAILY_REWARD_CAP;
  const myCategories = data?.tester?.categories ?? [];
  const recommendedCount = data?.campaigns.filter((c) => c.is_recommended).length ?? 0;
  const notEligibleCount = data?.campaigns.filter((c) => c.fit === 'not_eligible').length ?? 0;

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
              every other task is still listed below.{' '}
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

      {data?.modes && (
        <p className="mb-6 text-xs leading-relaxed text-slate-500" data-testid="modes-legend">
          <strong className="text-slate-700">Open testing:</strong> any tester can take the task. <strong className="text-slate-700">Targeted
          testing:</strong> the founder asked for testers in specific categories, and the server only lets matching testers start it
          (Tech-Savvy, Founders &amp; Product Builders and Business &amp; Office testers complete a short self-reported screening first).
          {notEligibleCount > 0 && (
            <>
              {' '}
              <span className="font-medium text-amber-900" data-testid="not-eligible-note">
                {notEligibleCount} task{notEligibleCount === 1 ? ' is' : 's are'} not available to you yet — open one to see why.
              </span>
            </>
          )}
        </p>
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

      {/* AI-personalised block: additive and optional. Eligibility is decided server-side; the list below is unchanged. */}
      {data && <AiRecommendations campaigns={data.campaigns} atCap={atCap} />}

      {data && data.campaigns.length > 0 && <BrowseAllHeading note={data.modes && notEligibleCount > 0} />}

      {data && data.campaigns.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {data.campaigns.map((c) => (
            <li
              key={c.campaign_id}
              data-recommended={c.is_recommended ? 'true' : 'false'}
              data-fit={c.fit}
              data-mode={c.testing_mode}
              className={`flex flex-col rounded-xl border p-5 ${
                c.fit === 'not_eligible'
                  ? 'border-slate-200 bg-slate-50'
                  : c.is_recommended
                    ? 'border-indigo-300 bg-white ring-1 ring-indigo-200'
                    : 'border-slate-200 bg-white'
              }`}
            >
              {(c.is_recommended || data.modes) && (
                <p className="mb-2 flex flex-wrap items-center gap-1.5">
                  {c.is_recommended && (
                    <span
                      data-testid="recommended-badge"
                      className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2.5 py-0.5 text-xs font-semibold text-white"
                    >
                      <span aria-hidden>★</span> Recommended for you
                    </span>
                  )}
                  {data.modes && <ModeBadge mode={c.testing_mode} />}
                  {data.modes && c.fit === 'eligible' && c.testing_mode === 'targeted' && (
                    <span data-testid="eligible-badge" className="inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-900">
                      You’re eligible
                    </span>
                  )}
                  {data.modes && c.fit === 'eligible' && c.testing_mode === 'open' && (
                    <span data-testid="eligible-badge" className="inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-900">
                      Eligible
                    </span>
                  )}
                  {c.fit === 'not_eligible' && (
                    <span data-testid="not-eligible-badge" className="inline-flex rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                      Not eligible: {shortReason(c.ineligible_reason)}
                    </span>
                  )}
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
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {c.testing_mode === 'targeted' ? 'Required testers (at least one)' : 'Looking for testers like'}
                  </p>
                  <CategoryBadges ids={c.target_categories} highlight={c.match_categories} className="mt-1.5" />
                  {c.is_recommended && (
                    <p className="mt-1.5 text-xs text-indigo-800">
                      Why: your profile includes {c.match_categories.map(categoryLabel).join(', ')}.
                    </p>
                  )}
                  {c.fit === 'not_eligible' && (
                    <p className="mt-1.5 text-xs text-amber-900" data-testid="why-not">
                      {c.ineligible_reason === 'screening_required'
                        ? `Why not: ${c.missing_screening.map(categoryLabel).join(', ')} needs a quick screening first.`
                        : c.ineligible_reason === 'no_profile'
                          ? 'Why not: you have no tester profile yet.'
                          : 'Why not: your tester profile does not include any of these categories.'}
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
                {c.fit === 'not_eligible' ? (
                  <ButtonLink to={`/test/${c.campaign_id}`} variant="secondary">
                    See requirements
                  </ButtonLink>
                ) : atCap && !c.reserved_by_me ? (
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
