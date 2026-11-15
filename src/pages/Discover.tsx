import { useState } from 'react';
import { fetchProfile, getMyExperience, getMyStatus, listDiscoverCampaigns, settleAll } from '../lib/api';
import { timeAgo, timeLeft } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { useNow } from '../lib/useNow';
import { useAuth } from '../context/AuthContext';
import { Alert, Button, ButtonLink, EmptyState, PageHeader, Spinner } from '../components/ui';
import { CategoryBadges } from '../components/CategoryPicker';
import { ModeBadge } from '../components/Eligibility';
import { categoryLabel, shortReason } from '../lib/matching';
import { DAILY_REWARD_CAP, RESERVATION_MINUTES } from '../lib/limits';
import { actionableRecommendations } from '../lib/recommendations';
import { fetchAiRecommendations } from '../lib/ai/aiApi';
import type { AiRecommendation, RecommendationsResponse } from '../lib/aiContract';
import { RecommendationDetails } from '../components/ai/RecommendationDetails';
import type { MatchedCampaign, MyExperience, MyStatus } from '../lib/types';

interface DiscoverData {
  campaigns: MatchedCampaign[];
  status: MyStatus | null;
  /** My experience profile (null = the backend predates migration 8: the previous list is shown, without tabs). */
  experience: MyExperience | null;
  /** false when the backend has no matching function yet: the plain feed is shown and no matching UI appears. */
  matching: boolean;
  /** true when the backend supports Open vs Targeted testing (migration 7). */
  modes: boolean;
  /** Personalized recommendations from the AI relevance service (unavailable until that service exists). */
  recommendations: RecommendationsResponse;
}

type View = 'recommended' | 'browse';

export function Discover() {
  const { profile, setBalance } = useAuth();
  const nowMs = useNow(30_000);
  const [view, setView] = useState<View | null>(null);

  const { data, error, loading, reload } = useLoad<DiscoverData>(async () => {
    // Housekeeping first: expire + refund dead campaigns so they never clutter the list. If anything was
    // settled (possibly our own request), re-read the authoritative balance.
    const settled = await settleAll();
    if (settled > 0) {
      fetchProfile()
        .then((p) => setBalance(p.credit_balance))
        .catch(() => undefined);
    }
    const [feed, status, experience] = await Promise.all([listDiscoverCampaigns(), getMyStatus().catch(() => null), getMyExperience().catch(() => null)]);
    let recommendations: RecommendationsResponse = { status: 'unavailable' };
    if (experience) {
      if (!experience.participation_ready) recommendations = { status: 'profile_incomplete' };
      else if (!experience.ai_consent.granted) recommendations = { status: 'consent_required' };
      else recommendations = await fetchAiRecommendations().catch((): RecommendationsResponse => ({ status: 'unavailable' }));
    }
    return { campaigns: feed.campaigns, status, experience, matching: feed.matching, modes: feed.modes, recommendations };
  });

  const status = data?.status ?? null;
  const atCap = status !== null && status.rewards_24h >= status.daily_limit;
  const cap = status?.daily_limit ?? DAILY_REWARD_CAP;
  const exp = data?.experience ?? null;
  const eligible = data?.campaigns.filter((c) => c.fit !== 'not_eligible') ?? [];
  const notAvailable = data?.campaigns.filter((c) => c.fit === 'not_eligible') ?? [];
  const activeView: View = view ?? (data?.recommendations.status === 'ok' ? 'recommended' : 'browse');

  // Recommendations are shown only when the database says the tester can actually act on the campaign.
  const eligibleById = new Map(eligible.map((c) => [c.campaign_id, c]));
  const recItems = data ? actionableRecommendations(data.recommendations, new Set(eligibleById.keys())) : [];

  const cardProps = { modes: data?.modes ?? false, matching: data?.matching ?? false, nowMs, atCap };

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

      {exp && !exp.participation_ready && (
        <div className="mb-6" data-testid="profile-needed">
          <Alert tone="warning" title="Complete your tester profile to start testing">
            You can look around, but to take tests and earn credits you first answer four short questions about your experience for at least one category.{' '}
            <ButtonLink to="/profile" variant="ghost" className="!px-1 !py-0 underline" data-testid="complete-profile-link">
              Complete my profile
            </ButtonLink>
          </Alert>
        </div>
      )}

      {data?.modes && (
        <p className="mb-6 text-xs leading-relaxed text-slate-500" data-testid="modes-legend">
          <strong className="text-slate-700">Open testing:</strong> any tester with a complete profile can take the task. <strong className="text-slate-700">Targeted
          testing:</strong> the founder asked for testers in specific categories, and the server only lets matching testers start it (professional
          categories are assessed from your self-reported answers first).
          {notAvailable.length > 0 && (
            <>
              {' '}
              <span className="font-medium text-amber-900" data-testid="not-eligible-note">
                {notAvailable.length} task{notAvailable.length === 1 ? ' is' : 's are'} not available to you yet — open one to see why.
              </span>
            </>
          )}
        </p>
      )}

      {loading && !data && <Spinner label="Loading tasks…" />}

      {data && exp && (
        <div className="mb-5 flex gap-2 border-b border-slate-200" role="tablist" aria-label="Task views">
          {(
            [
              ['recommended', 'Recommended for you'],
              ['browse', `Browse all eligible tests (${eligible.length})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeView === id}
              data-testid={`tab-${id}`}
              onClick={() => setView(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${activeView === id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ---- Recommended for you (AI relevance service; this app only renders it) ---- */}
      {data && exp && activeView === 'recommended' && (
        <div data-testid="recommended-view">
          {data.recommendations.status === 'ok' && recItems.length > 0 && (
            <ul className="grid gap-4 sm:grid-cols-2">
              {recItems.map((r) => (
                <TaskCard key={r.campaign_id} c={eligibleById.get(r.campaign_id)!} why={r.reason} rec={r} {...cardProps} />
              ))}
            </ul>
          )}
          {data.recommendations.status === 'ok' && recItems.length === 0 && (
            <EmptyState
              title="No relevant recommendations right now"
              action={<Button onClick={() => setView('browse')}>Browse all eligible tests</Button>}
            >
              Nothing that is open to you looks genuinely relevant to your experience at the moment. We would rather show you nothing than pad the list; new
              tasks appear all the time.
            </EmptyState>
          )}
          {data.recommendations.status === 'unavailable' && (
            <EmptyState title="Personalized recommendations are not available yet" action={<Button onClick={() => setView('browse')}>Browse all eligible tests</Button>}>
              This view will list only tasks that are relevant to your experience once personalization is switched on. Until then nothing is recommended, and every
              task you are eligible for is in “Browse all eligible tests”.
            </EmptyState>
          )}
          {(data.recommendations.status === 'rate_limited' || data.recommendations.status === 'busy' || data.recommendations.status === 'budget_reached') && (
            <EmptyState title="Recommendations are paused for now" action={<Button onClick={() => setView('browse')}>Browse all eligible tests</Button>}>
              {data.recommendations.status === 'busy'
                ? 'Your previous request is still running. Refresh in a few seconds.'
                : data.recommendations.status === 'rate_limited'
                  ? 'You have used today’s AI recommendation allowance. It resets daily.'
                  : 'The AI service has reached its daily budget.'}{' '}
              Every task you are eligible for is in “Browse all eligible tests”.
            </EmptyState>
          )}
          {data.recommendations.status === 'consent_required' && (
            <EmptyState
              title="Turn on AI personalization to get recommendations"
              action={
                <ButtonLink to="/profile" data-testid="open-consent">
                  Open my profile settings
                </ButtonLink>
              }
            >
              Personalized recommendations need your permission to analyze your bio and answers. It is off by default and you can switch it off at any time. You can
              always browse all eligible tests without it.
            </EmptyState>
          )}
          {data.recommendations.status === 'profile_incomplete' && (
            <EmptyState
              title="Complete your tester profile first"
              action={
                <ButtonLink to="/profile" data-testid="open-profile">
                  Complete my profile
                </ButtonLink>
              }
            >
              {data.recommendations.detail === 'too_little_text'
                ? 'Recommendations are based on your written experience in categories that are already active. Add a little more about yourself (or wait for a professional category to be assessed), then check again.'
                : 'Recommendations are based on your written experience. Answer the four questions for at least one category to unlock them.'}
            </EmptyState>
          )}
        </div>
      )}

      {/* ---- Browse all eligible tests ---- */}
      {data && (!exp || activeView === 'browse') && (
        <div data-testid="browse-view">
          {data.campaigns.length === 0 && (
            <EmptyState
              title="No open tasks right now"
              action={<ButtonLink to="/create">{(profile?.credit_balance ?? 0) > 0 ? 'Post the first one' : 'Request a test'}</ButtonLink>}
            >
              Every task here is posted by a real founder, so the list can be empty. Tasks you posted yourself, ones you have already tested, expired tasks and ones
              someone else is testing right now are never shown.
            </EmptyState>
          )}
          {data.campaigns.length > 0 && eligible.length === 0 && exp && (
            <EmptyState title="Nothing you can take right now">
              {exp.participation_ready
                ? 'There are open tasks, but none is available to you at the moment (see below).'
                : 'Complete your tester profile to see the tasks you can take.'}
            </EmptyState>
          )}
          {(exp ? eligible : data.campaigns).length > 0 && (
            <ul className="grid gap-4 sm:grid-cols-2" data-testid="eligible-list">
              {(exp ? eligible : data.campaigns).map((c) => (
                <TaskCard key={c.campaign_id} c={c} {...cardProps} />
              ))}
            </ul>
          )}
          {exp && notAvailable.length > 0 && (
            <details className="mt-8" data-testid="not-available" open={eligible.length === 0}>
              <summary className="cursor-pointer text-sm font-semibold text-slate-700">Not available to you yet ({notAvailable.length})</summary>
              <p className="mt-2 text-xs text-slate-500">You can read these, but you cannot start them. Each card says why.</p>
              <ul className="mt-3 grid gap-4 sm:grid-cols-2">
                {notAvailable.map((c) => (
                  <TaskCard key={c.campaign_id} c={c} {...cardProps} />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </>
  );
}

function TaskCard({
  c,
  why,
  rec,
  modes,
  matching,
  nowMs,
  atCap,
}: {
  c: MatchedCampaign;
  /** shown when the AI service says why this task fits the tester */
  why?: string;
  /** the AI service's full recommendation (verdict, the tester's own words it relied on, what is not covered) */
  rec?: AiRecommendation;
  modes: boolean;
  matching: boolean;
  nowMs: number;
  atCap: boolean;
}) {
  return (
    <li
      data-match={c.is_recommended ? 'true' : 'false'}
      data-fit={c.fit}
      data-mode={c.testing_mode}
      className={`flex flex-col rounded-xl border p-5 ${c.fit === 'not_eligible' ? 'border-slate-200 bg-slate-50' : c.is_recommended ? 'border-indigo-300 bg-white ring-1 ring-indigo-200' : 'border-slate-200 bg-white'}`}
    >
      {(c.is_recommended || modes) && (
        <p className="mb-2 flex flex-wrap items-center gap-1.5">
          {c.is_recommended && (
            <span data-testid="match-badge" className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2.5 py-0.5 text-xs font-semibold text-white">
              <span aria-hidden>★</span> Matches your profile
            </span>
          )}
          {modes && <ModeBadge mode={c.testing_mode} />}
          {modes && c.fit === 'eligible' && c.testing_mode === 'targeted' && (
            <span data-testid="eligible-badge" className="inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-900">
              You’re eligible
            </span>
          )}
          {modes && c.fit === 'eligible' && c.testing_mode === 'open' && (
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
      {why && (
        <p className="mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-900" data-testid="rec-why">
          <strong>Why this fits you:</strong> {why}
        </p>
      )}
      {rec && <RecommendationDetails rec={rec} />}
      {matching && c.target_categories.length > 0 && (
        <div className="mt-3" data-testid="looking-for">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {c.testing_mode === 'targeted' ? 'Required testers (at least one)' : 'Looking for testers like'}
          </p>
          <CategoryBadges ids={c.target_categories} highlight={c.match_categories} className="mt-1.5" />
          {c.is_recommended && <p className="mt-1.5 text-xs text-indigo-800">Why: your active categories include {c.match_categories.map(categoryLabel).join(', ')}.</p>}
        </div>
      )}
      {c.fit === 'not_eligible' && (
        <p className="mt-3 text-xs text-amber-900" data-testid="why-not">
          {c.ineligible_reason === 'profile_incomplete' || c.ineligible_reason === 'no_profile'
            ? 'Why not: complete your tester profile (four short answers for at least one category) first.'
            : c.ineligible_reason === 'qualification_required' || c.ineligible_reason === 'screening_required'
              ? `Why not: ${c.missing_screening.map(categoryLabel).join(', ')} is not active yet (all four answers and, for professional categories, an assessment are needed).`
              : 'Why not: your tester profile does not include any of these categories.'}
        </p>
      )}
      <div className="mt-5 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-emerald-700">
          {c.reserved_by_me ? <span className="text-indigo-700">In progress — yours</span> : <>Earn 1 credit · ~3 min</>}
          <span className="block text-xs font-normal text-slate-400">
            {c.reserved_by_me && c.reservation_expires_at ? `Reservation: ${timeLeft(c.reservation_expires_at, nowMs)}` : `Task ${timeLeft(c.expires_at, nowMs)}`}
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
  );
}
