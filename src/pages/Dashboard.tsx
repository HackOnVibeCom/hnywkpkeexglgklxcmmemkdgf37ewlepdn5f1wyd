import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Button, ButtonLink, EmptyState, ExternalLink, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { fetchDashboard, fetchProfile } from '../lib/api';
import { hostOf, plural, timeAgo } from '../lib/format';
import type { CampaignStatus, LedgerReason, MyCampaign, Submission } from '../lib/types';
import { useLoad } from '../lib/useLoad';

const REASON_LABEL: Record<LedgerReason, string> = {
  starter: 'Starter credit',
  test_reward: 'Earned — completed a test',
  campaign_spend: 'Spent — requested a test',
};

const STATUS: Record<CampaignStatus, { label: string; cls: string }> = {
  open: { label: 'Waiting for a tester', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  completed: { label: 'Tested', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
};

function Stars({ value }: { value: number }) {
  return (
    <span aria-label={`${value} out of 5`} className="font-semibold text-slate-900">
      {value}/5
    </span>
  );
}

function FeedbackBlock({ s }: { s: Submission }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            s.task_completed ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
          }`}
        >
          {s.task_completed ? 'Completed the task' : 'Could not complete the task'}
        </span>
        <span className="text-slate-600">
          UX rating: <Stars value={s.ux_rating} />
        </span>
        <span className="text-xs text-slate-400">{timeAgo(s.created_at)}</span>
      </div>
      <dl className="mt-3 space-y-3">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Confusion / friction</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-slate-800">{s.friction}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Suggested improvement</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-slate-800">{s.suggestion}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-slate-500">
        {s.share_consent
          ? 'Tester allowed anonymous public quoting.'
          : 'Private — tester did not allow public sharing. Do not publish.'}
      </p>
    </div>
  );
}

function CampaignCard({ c }: { c: MyCampaign }) {
  const st = STATUS[c.status];
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words font-semibold text-slate-900">{c.project?.name ?? 'Project'}</h3>
          {c.project && (
            <p className="mt-0.5 break-all text-xs">
              <ExternalLink href={c.project.url}>{hostOf(c.project.url)}</ExternalLink>
            </p>
          )}
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${st.cls}`}>{st.label}</span>
      </div>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Task</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{c.task_description}</p>
      <p className="mt-2 text-xs text-slate-400">
        Requested {timeAgo(c.created_at)} · {c.response_count}/{c.max_responses} responses
      </p>

      <div className="mt-4">
        {c.submissions.length === 0 ? (
          <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
            No feedback yet. It will appear here when a real tester submits it.
          </p>
        ) : (
          <div className="space-y-3">
            {c.submissions.map((s) => (
              <FeedbackBlock key={s.id} s={s} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

export function Dashboard() {
  const { profile, setBalance } = useAuth();
  const location = useLocation();
  const justCreated = (location.state as { justCreated?: boolean } | null)?.justCreated === true;
  const { data, error, loading, reload } = useLoad(fetchDashboard);

  // Keep the header balance authoritative after any reload of this page.
  useEffect(() => {
    let cancelled = false;
    fetchProfile()
      .then((p) => !cancelled && setBalance(p.credit_balance))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [setBalance, data]);

  const balance = profile?.credit_balance ?? 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        action={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      {justCreated && (
        <div className="mb-6">
          <Alert tone="success" title="Test requested">
            Your task is live in Discover. Feedback appears below once a real tester submits it.
          </Alert>
        </div>
      )}

      <section aria-labelledby="bal" className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5 sm:col-span-1">
          <h2 id="bal" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Test Credits
          </h2>
          <p className="mt-2 text-4xl font-bold text-slate-900">{balance}</p>
          <p className="mt-1 text-xs text-slate-500">1 credit = 1 human test of your product</p>
        </div>
        <div className="flex flex-col justify-center gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:col-span-2">
          <p className="text-sm text-slate-600">
            {balance > 0
              ? 'You have a credit to spend — post a task for your product.'
              : 'Out of credits? Test someone else’s product to earn another.'}
          </p>
          <div className="flex flex-wrap gap-3">
            <ButtonLink to="/create" variant={balance > 0 ? 'primary' : 'secondary'}>
              Request a test
            </ButtonLink>
            <ButtonLink to="/discover" variant={balance > 0 ? 'secondary' : 'primary'}>
              Earn a credit
            </ButtonLink>
          </div>
        </div>
      </section>

      {error && (
        <div className="mt-6">
          <Alert tone="error" title="Could not load your dashboard">
            {error}
          </Alert>
        </div>
      )}
      {loading && !data && <Spinner label="Loading your results…" />}

      {data && (
        <>
          <section className="mt-12" aria-labelledby="mine">
            <h2 id="mine" className="text-xl font-bold tracking-tight text-slate-900">
              Your test requests & results
            </h2>
            <div className="mt-4">
              {data.campaigns.length === 0 ? (
                <EmptyState
                  title="You haven’t requested a test yet"
                  action={balance > 0 ? <ButtonLink to="/create">Request your first test</ButtonLink> : undefined}
                >
                  Results from real testers will show up here. Nothing is pre-filled or simulated.
                </EmptyState>
              ) : (
                <ul className="space-y-4">
                  {data.campaigns.map((c) => (
                    <CampaignCard key={c.id} c={c} />
                  ))}
                </ul>
              )}
            </div>
            <p className="mt-4 text-xs text-slate-500">
              AI summaries of recurring problems are not available yet. They will only be generated from real feedback
              once enough responses exist.
            </p>
          </section>

          <section className="mt-12" aria-labelledby="hist">
            <h2 id="hist" className="text-xl font-bold tracking-tight text-slate-900">
              Credit history
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              You have completed {plural(data.testsCompleted, 'test')} for others.
            </p>
            <ul className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
              {data.ledger.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="text-slate-800">{REASON_LABEL[l.reason]}</p>
                    <p className="text-xs text-slate-400">{timeAgo(l.created_at)}</p>
                  </div>
                  <span className={`font-semibold ${l.delta > 0 ? 'text-emerald-700' : 'text-slate-700'}`}>
                    {l.delta > 0 ? `+${l.delta}` : l.delta}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}
