import { useEffect, useRef, useState } from 'react';
import type { AssessmentResponse, AssessmentResult } from '../../lib/aiContract';
import { requestAssessment } from '../../lib/ai/aiApi';
import { AI_ENABLED } from '../../lib/ai/flag';
import { categoryLabel } from '../../lib/matching';
import type { MyExperience } from '../../lib/types';
import { Alert, Button } from '../ui';

const PRINCIPLES = [
  'We look for concrete, plausible experience in your own words.',
  'You do not need a degree, a job title, an employer, years of experience or advanced expertise. Small and informal experience counts.',
  'Please only write what is true. If you have little experience, say so: you can still take open tasks and use the other categories.',
  'This is an assessment of your self-reported answers, not a verification of any credential.',
];

/** Wait this long before retrying ONCE when the server says a previous check is still running (its throttle is 15 s). */
const BUSY_RETRY_MS = 16_000;

type RowState = 'processing' | 'pending' | 'qualified' | 'needs_clarification' | 'not_qualified';

const ROW_LABEL: Record<RowState, string> = {
  processing: 'Processing…',
  pending: 'Pending',
  qualified: 'Qualified (self-reported)',
  needs_clarification: 'Needs clarification',
  not_qualified: 'Not qualified yet',
};

/**
 * Assessment of the professional categories, shown on the Profile page. The browser only ASKS: the server reads the answers,
 * decides, and records the decision through the database's one allowed function. Nothing here can set a status.
 *
 * When does a check start?
 *  - AUTOMATICALLY, only right after the tester saved four answers of a professional category (or switched AI processing on while
 *    categories were waiting): the page passes a new `autoToken` for exactly that event. A page load or refresh never starts one.
 *  - on request ("Check again"), e.g. after a temporary failure.
 * The server enforces consent (it re-checks before every model request), per-user and global limits, and does not repeat a paid
 * request for answers it has already assessed.
 */
export function AssessmentPanel({ exp, onChanged, autoToken = 0 }: { exp: MyExperience; onChanged: () => void; autoToken?: number }) {
  const [processing, setProcessing] = useState(false);
  const [resp, setResp] = useState<AssessmentResponse | null>(null);
  const running = useRef(false);
  const queued = useRef(false);
  const retried = useRef(false);
  const timer = useRef<number | null>(null);
  const alive = useRef(true);
  const latest = useRef({ granted: exp.ai_consent.granted, onChanged });
  latest.current = { granted: exp.ai_consent.granted, onChanged };

  const pending = exp.categories.filter((c) => c.selected && c.requires_assessment && c.state === 'pending_assessment');

  async function run(auto: boolean): Promise<void> {
    if (!AI_ENABLED || !latest.current.granted) return;
    if (running.current) {
      queued.current = true; // one more check after the current one (answers may have changed meanwhile)
      return;
    }
    running.current = true;
    setProcessing(true);
    setResp(null);
    try {
      const r = await requestAssessment();
      if (!alive.current) return;
      setResp(r);
      if (r.results.some((x) => x.outcome === 'qualified' || x.outcome === 'not_qualified')) latest.current.onChanged();
      if (auto && r.status === 'busy' && !retried.current) {
        retried.current = true;
        timer.current = window.setTimeout(() => void run(true), BUSY_RETRY_MS);
      }
    } finally {
      running.current = false;
      if (alive.current) setProcessing(false);
      if (queued.current && alive.current) {
        queued.current = false;
        retried.current = false;
        void run(true);
      }
    }
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  // A new token = "the tester just saved professional answers / just allowed AI". Never fires on mount (token 0). When the token
  // arrives before the page has reloaded the new consent state (switching AI on), it waits for `granted` and then fires ONCE.
  const handled = useRef(0);
  const granted = exp.ai_consent.granted;
  useEffect(() => {
    if (autoToken > handled.current && granted) {
      handled.current = autoToken;
      retried.current = false;
      void run(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoToken, granted]);

  // Keep showing the latest result even after the category stopped being pending (a recorded decision reloads the page state):
  // the tester must see what happened and why.
  if (!AI_ENABLED || !exp.ai_consent.granted || (pending.length === 0 && !resp && !processing)) return null;

  const rows: Array<{ category: string; state: RowState; result: AssessmentResult | null }> = [];
  const seen = new Set<string>();
  for (const c of pending) {
    const result = resp?.results.find((x) => x.category === c.category) ?? null;
    seen.add(c.category);
    rows.push({ category: c.category, state: processing ? 'processing' : result && result.outcome !== 'pending' ? result.outcome : 'pending', result });
  }
  for (const r of resp?.results ?? []) {
    if (!seen.has(r.category)) rows.push({ category: r.category, state: r.outcome === 'pending' ? 'pending' : r.outcome, result: r });
  }

  const notice =
    resp?.status === 'rate_limited'
      ? 'You have used today’s AI allowance. Your categories stay pending; try again tomorrow.'
      : resp?.status === 'busy'
        ? 'A previous check is still running. We will try once more in a few seconds; you can also press “Check again”.'
        : resp?.status === 'unavailable' || resp?.status === 'budget_reached'
          ? 'The assessment is not available right now. Your categories stay pending and you can still take open tasks.'
          : resp?.status === 'consent_required'
            ? 'AI processing is off. Turn it on below to have your answers assessed.'
            : null;

  return (
    <section className="mt-10 max-w-2xl rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="assess-h" data-testid="assessment-panel">
      <h2 id="assess-h" className="text-lg font-bold tracking-tight text-slate-900">
        Check my professional answers
      </h2>
      {pending.length > 0 && (
        <>
          <p className="mt-2 text-sm text-slate-600" data-testid="assessment-intro">
            {pending.map((c) => categoryLabel(c.category)).join(', ')} {pending.length === 1 ? 'is' : 'are'} waiting for an assessment of your written answers. Because you
            allowed AI processing, this starts automatically when you save your answers. Until then you can still take every open task.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600" data-testid="assessment-principles">
            {PRINCIPLES.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="mt-4">
            <Button variant="secondary" onClick={() => void run(false)} disabled={processing} data-testid="assess-run">
              {processing ? 'Checking…' : 'Check again'}
            </Button>
          </div>
        </>
      )}
      <div aria-live="polite" data-testid="assess-status">
        {notice && (
          <div className="mt-4" data-testid="assess-notice">
            <Alert tone="info">{notice}</Alert>
          </div>
        )}
        {rows.length > 0 && (
          <ul className="mt-4 space-y-3" data-testid="assess-results">
            {rows.map((r) => (
              <ResultRow key={r.category} category={r.category} state={r.state} result={r.result} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ResultRow({ category, state, result }: { category: string; state: RowState; result: AssessmentResult | null }) {
  const tone =
    state === 'qualified'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
      : state === 'not_qualified'
        ? 'border-slate-300 bg-slate-50 text-slate-800'
        : state === 'processing'
          ? 'border-indigo-200 bg-indigo-50 text-indigo-900'
          : 'border-amber-300 bg-amber-50 text-amber-900';
  return (
    <li className={`rounded-lg border p-3 text-sm ${tone}`} data-testid={`assess-${category}`} data-outcome={result?.outcome ?? state} data-state={state}>
      <p className="font-semibold">
        {categoryLabel(category)}: <span data-testid={`assess-state-${category}`}>{ROW_LABEL[state]}</span>
      </p>
      {state === 'processing' && <p className="mt-1 text-xs">Checking your written answers now. This usually takes a few seconds.</p>}
      {state === 'pending' && !result && <p className="mt-1 text-xs">Waiting to be checked. Your answers are saved.</p>}
      {result && state !== 'processing' && <p className="mt-1 text-xs">{result.message}</p>}
      {result && state === 'needs_clarification' && result.clarification_questions.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs" data-testid="assess-clarify">
          {result.clarification_questions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      )}
      {result && result.criteria.length > 0 && state !== 'qualified' && state !== 'processing' && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer font-medium">What we look for</summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {result.criteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
