import { listOpenCampaigns } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { useAuth } from '../context/AuthContext';
import { Alert, Button, ButtonLink, EmptyState, PageHeader, Spinner } from '../components/ui';

export function Discover() {
  const { profile } = useAuth();
  const { data, error, loading, reload } = useLoad(listOpenCampaigns);

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

      {loading && !data && <Spinner label="Loading tasks…" />}

      {data && data.length === 0 && (
        <EmptyState
          title="No open tasks right now"
          action={
            <ButtonLink to="/create">{(profile?.credit_balance ?? 0) > 0 ? 'Post the first one' : 'Request a test'}</ButtonLink>
          }
        >
          Every task here is posted by a real founder, so the list can be empty. Tasks you posted yourself and ones you
          have already tested are never shown.
        </EmptyState>
      )}

      {data && data.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {data.map((c) => (
            <li key={c.campaign_id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 break-words font-semibold text-slate-900">{c.project_name}</h2>
                <span className="shrink-0 text-xs text-slate-500">{timeAgo(c.created_at)}</span>
              </div>
              {c.description && <p className="mt-1 line-clamp-2 break-words text-sm text-slate-500">{c.description}</p>}
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Your task</p>
              <p className="mt-1 line-clamp-4 flex-1 break-words text-sm text-slate-800">{c.task_description}</p>
              <div className="mt-5 flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-emerald-700">Earn 1 credit · ~3 min</span>
                <ButtonLink to={`/test/${c.campaign_id}`}>Start test</ButtonLink>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
