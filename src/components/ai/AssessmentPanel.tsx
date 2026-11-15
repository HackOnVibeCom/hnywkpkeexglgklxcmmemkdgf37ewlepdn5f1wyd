import { useState } from 'react';
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

/**
 * "Check my answers" for professional categories that are waiting for an assessment. The browser only ASKS: the server reads
 * the answers, decides, and records the decision through the database's one allowed function. Nothing here can set a status.
 * Shown only when the AI build flag is on, consent is granted and at least one professional category is pending.
 */
export function AssessmentPanel({ exp, onChanged }: { exp: MyExperience; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<AssessmentResponse | null>(null);
  const pending = exp.categories.filter((c) => c.selected && c.requires_assessment && c.state === 'pending_assessment');
  // Keep showing the latest result even after the category stopped being pending (a recorded decision reloads the page state):
  // the tester must see what happened and why.
  if (!AI_ENABLED || !exp.ai_consent.granted || (pending.length === 0 && !resp)) return null;

  async function run() {
    setBusy(true);
    try {
      const r = await requestAssessment();
      setResp(r);
      if (r.results.some((x) => x.outcome === 'qualified' || x.outcome === 'not_qualified')) onChanged();
    } finally {
      setBusy(false);
    }
  }

  const notice =
    resp?.status === 'rate_limited'
      ? 'You have used today’s AI allowance. Your categories stay pending; try again tomorrow.'
      : resp?.status === 'busy'
        ? 'A previous check is still running. Give it a few seconds and try again.'
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
          <p className="mt-2 text-sm text-slate-600">
            {pending.map((c) => categoryLabel(c.category)).join(', ')} {pending.length === 1 ? 'is' : 'are'} waiting for an assessment of your written answers. Until then you can
            still take every open task.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600" data-testid="assessment-principles">
            {PRINCIPLES.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="mt-4">
            <Button onClick={run} disabled={busy} data-testid="assess-run">
              {busy ? 'Checking…' : 'Check my answers now'}
            </Button>
          </div>
        </>
      )}
      {notice && (
        <div className="mt-4" data-testid="assess-notice">
          <Alert tone="info">{notice}</Alert>
        </div>
      )}
      {resp && resp.results.length > 0 && (
        <ul className="mt-4 space-y-3" data-testid="assess-results">
          {resp.results.map((r) => (
            <ResultRow key={r.category} r={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResultRow({ r }: { r: AssessmentResult }) {
  const tone =
    r.outcome === 'qualified'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
      : r.outcome === 'not_qualified'
        ? 'border-slate-300 bg-slate-50 text-slate-800'
        : 'border-amber-300 bg-amber-50 text-amber-900';
  const label =
    r.outcome === 'qualified' ? 'Active (self-reported)' : r.outcome === 'not_qualified' ? 'Not active yet' : r.outcome === 'needs_clarification' ? 'More detail needed' : 'Still pending';
  return (
    <li className={`rounded-lg border p-3 text-sm ${tone}`} data-testid={`assess-${r.category}`} data-outcome={r.outcome}>
      <p className="font-semibold">
        {categoryLabel(r.category)}: {label}
      </p>
      <p className="mt-1 text-xs">{r.message}</p>
      {r.outcome === 'needs_clarification' && r.clarification_questions.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs" data-testid="assess-clarify">
          {r.clarification_questions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      )}
      {r.criteria.length > 0 && r.outcome !== 'qualified' && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer font-medium">What we look for</summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {r.criteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
