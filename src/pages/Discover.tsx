import { fetchProfile, getMyStatus, listOpenCampaigns, settleAll } from '../lib/api';
import { timeAgo, timeLeft } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { useNow } from '../lib/useNow';
import { useAuth } from '../context/AuthContext';
import { Alert, Button, ButtonLink, EmptyState, PageHeader, Spinner } from '../components/ui';
import { DAILY_REWARD_CAP, RESERVATION_MINUTES } from '../lib/limits';
import type { MyStatus, OpenCampaign } from '../lib/types';

interface DiscoverData {
  campaigns: OpenCampaign[];
  status: MyStatus | null;
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
    const [campaigns, status] = await Promise.all([listOpenCampaigns(), getMyStatus().catch(() => null)]);
    return { campaigns, status };
  });

  const status = data?.status ?? null;
  const atCap = status !== null && status.rewards_24h >= status.daily_limit;
  const cap = status?.daily_limit ?? DAILY_REWARD_CAP;

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
            <li key={c.campaign_id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 break-words font-semibold text-slate-900">{c.project_name}</h2>
                <span className="shrink-0 text-xs text-slate-500">{timeAgo(c.created_at)}</span>
              </div>
              {c.description && <p className="mt-1 line-clamp-2 break-words text-sm text-slate-500">{c.description}</p>}
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Your task</p>
              <p className="mt-1 line-clamp-4 flex-1 break-words text-sm text-slate-800">{c.task_description}</p>
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
