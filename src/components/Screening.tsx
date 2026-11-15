import { useState, type FormEvent } from 'react';
import { Alert, Button, Spinner } from './ui';
import { friendlyError, getScreening, submitScreening } from '../lib/api';
import { categoryLabel, SCREENED_LABEL } from '../lib/matching';
import type { Screening, ScreeningResult } from '../lib/types';
import { useLoad } from '../lib/useLoad';

/**
 * Self-reported experience screening for ONE professional category. The questions, the pass rule and the attempt
 * limit all live on the server; this component only renders them. Wording is deliberate: "self-reported", never
 * "verified" - nothing here checks a credential.
 */
export function ScreeningPanel({ category, onDone, onClose }: { category: string; onDone: () => void; onClose?: () => void }) {
  const { data, error, loading, reload } = useLoad<Screening>(() => getScreening(category), category);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScreeningResult | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const label = categoryLabel(category);

  function toggle(qid: string, optId: string) {
    setAnswers((prev) => {
      const cur = new Set(prev[qid] ?? []);
      if (optId === 'none') {
        return { ...prev, [qid]: cur.has('none') ? [] : ['none'] };
      }
      cur.delete('none');
      if (cur.has(optId)) cur.delete(optId);
      else cur.add(optId);
      return { ...prev, [qid]: [...cur] };
    });
  }

  const complete = !!data && data.questions.every((q) => (answers[q.id]?.length ?? 0) > 0);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (!data || !complete) return;
    setBusy(true);
    setServerError(null);
    try {
      const r = await submitScreening(category, answers);
      setResult(r);
      if (r.passed) onDone();
      else reload();
    } catch (e) {
      setServerError(friendlyError(e));
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-indigo-200 bg-white p-5" aria-label={`${label} screening`} data-testid={`screening-${category}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="font-semibold text-slate-900">{label} — quick experience screening</h3>
        {onClose && (
          <Button type="button" variant="ghost" className="!py-1" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-600">
        A few short questions about what you have actually done. It is <strong>self-reported</strong>: UXBarter does not verify
        any credential, and your individual answers are not stored — only that you completed the screening. It takes about a
        minute.
      </p>

      {loading && !data && <Spinner label="Loading questions…" />}
      {error && !data && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {data?.qualified && !result && (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900" data-testid="screened-label">
          ✓ {SCREENED_LABEL}
        </p>
      )}

      {result?.passed && (
        <div className="mt-4">
          <Alert tone="success" title={SCREENED_LABEL}>
            Thank you — you reported hands-on experience in {result.areas} of the areas (at least {result.min_areas} needed). You can now take
            targeted tasks that ask for {label}.
          </Alert>
        </div>
      )}

      {data && !data.qualified && !result?.passed && (
        <>
          {result && !result.passed && (
            <div className="mt-4" data-testid="screening-not-passed">
              <Alert tone="warning" title="Screening not completed">
                You reported hands-on experience in {result.areas} area{result.areas === 1 ? '' : 's'}; at least {result.min_areas} are needed.
                {result.attempts_left > 0
                  ? ` You can try again — ${result.attempts_left} attempt${result.attempts_left === 1 ? '' : 's'} left in this 24-hour window.`
                  : ' You have used all attempts for the last 24 hours; you can try again later.'}
              </Alert>
            </div>
          )}
          {data.attempts_left === 0 ? (
            <div className="mt-4">
              <Alert tone="warning">You have used all {data.max_attempts} screening attempts for the last 24 hours. Please try again later.</Alert>
            </div>
          ) : (
            <form onSubmit={onSubmit} noValidate className="mt-4 space-y-5">
              {data.questions.map((q, i) => (
                <fieldset key={q.id} data-testid={`q-${q.id}`}>
                  <legend className="text-sm font-semibold text-slate-900">
                    {i + 1}. {q.prompt}
                  </legend>
                  <div className="mt-2 space-y-1.5">
                    {q.options.map((o) => {
                      const on = (answers[q.id] ?? []).includes(o.id);
                      return (
                        <label
                          key={o.id}
                          className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm ${on ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-white hover:bg-slate-50'}`}
                        >
                          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600" checked={on} onChange={() => toggle(q.id, o.id)} data-testid={`opt-${q.id}-${o.id}`} />
                          <span className="min-w-0 break-words text-slate-800">{o.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
              {serverError && <Alert tone="error">{serverError}</Alert>}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={!complete || busy} data-testid="screening-submit">
                  {busy ? 'Checking…' : 'Submit screening'}
                </Button>
                <span className="text-xs text-slate-500">
                  Answer every question ("None of these" counts). At least {data.min_areas} areas with hands-on experience are needed ·{' '}
                  {data.attempts_left} attempt{data.attempts_left === 1 ? '' : 's'} left per 24 hours.
                </span>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
