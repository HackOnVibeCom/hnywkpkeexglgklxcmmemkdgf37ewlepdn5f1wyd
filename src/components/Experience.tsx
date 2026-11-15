import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Spinner } from './ui';
import { Field } from './form';
import { deleteMyExperience, friendlyError, getExperienceQuestions, saveExperienceAnswers, setAiConsent } from '../lib/api';
import { ANSWER_MAX, ANSWER_SAVES_PER_DAY, ASSESSMENT_NOTE, categoryLabel, experienceBadge, validateAnswers, type ExperienceBadge } from '../lib/matching';
import type { ExperienceCategory } from '../lib/types';
import { useLoad } from '../lib/useLoad';

/** Small coloured status pill for a category (Active / Pending assessment / Incomplete / Not qualified yet). */
export function StatusPill({ category, testId }: { category: ExperienceCategory; testId?: string }) {
  const b: ExperienceBadge | null = experienceBadge(category);
  if (!b) return null;
  const tone =
    b.kind === 'active'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
      : b.kind === 'pending'
        ? 'border-amber-300 bg-amber-50 text-amber-900'
        : b.kind === 'warn'
          ? 'border-red-200 bg-red-50 text-red-900'
          : 'border-slate-300 bg-slate-50 text-slate-800';
  return (
    <span data-testid={testId} data-kind={b.kind} data-state={category.state} className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
      {b.text}
    </span>
  );
}

/**
 * The four open-ended questions of ONE category. The questions, the validation and the rate limit live on the server; this
 * component renders them and gives instant feedback. Answers are private to the signed-in identity.
 */
export function ExperiencePanel({ category, onSaved, onClose }: { category: string; onSaved: (c: ExperienceCategory) => void; onClose?: () => void }) {
  const { data, error, loading } = useLoad(() => getExperienceQuestions(category), category);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ExperienceCategory | null>(null);

  useEffect(() => {
    if (data) setAnswers({ ...(data.answers ?? {}) });
  }, [data]);

  const label = categoryLabel(category);
  const ids = data?.questions.map((q) => q.id) ?? [];
  const v = validateAnswers(ids, answers);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setServerError(null);
    setTouched(true);
    if (!v.ok) return;
    setBusy(true);
    try {
      const res = await saveExperienceAnswers(category, answers);
      setSaved(res);
      onSaved(res);
    } catch (e) {
      setServerError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 sm:p-5" aria-label={`${label} — four questions`} data-testid={`experience-${category}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-slate-900">{label} — four short questions</h3>
        {onClose && (
          <Button type="button" variant="ghost" className="!py-1" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Answer in your own words, in a sentence or two each: what you have actually done, used and enjoy testing. There are no right answers, nothing is
        graded as a test, and nobody is assumed to be a beginner. <strong>Please leave out sensitive personal details</strong> (health, religion, politics, age,
        ethnicity), employer names and passwords. Your answers are private to you; they are never shown to founders or other testers.
      </p>
      {data?.requires_assessment ? (
        <p className="mt-2 text-sm text-slate-600" data-testid="assessment-note">
          This is a professional category: after you save, it stays <strong>pending</strong> until your answers have been assessed (with your permission, see
          “AI personalization” below). {ASSESSMENT_NOTE}
        </p>
      ) : (
        <p className="mt-2 text-sm text-slate-600" data-testid="general-note">
          Once all four answers are saved, this category becomes <strong>active</strong> straight away: no skills exam, no credentials.
        </p>
      )}

      {loading && !data && <Spinner label="Loading questions…" />}
      {error && !data && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {data?.outdated && (
        <div className="mt-3" data-testid="outdated-note">
          <Alert tone="warning" title="The questions were updated">
            Your earlier answers are shown below. Please review them and save again so they match the new questions.
          </Alert>
        </div>
      )}

      {data && (
        <form onSubmit={onSubmit} noValidate className="mt-4 space-y-5">
          {data.questions.map((q, i) => {
            const err = touched ? v.errors[q.id] : undefined;
            return (
              <Field key={q.id} label={`${i + 1}. ${q.prompt}`} hint={q.hint ?? undefined} error={err} counter={{ value: answers[q.id] ?? '', max: ANSWER_MAX }}>
                {({ id, describedBy, invalid, className }) => (
                  <textarea
                    id={id}
                    className={className}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    rows={3}
                    value={answers[q.id] ?? ''}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    data-testid={`answer-${q.id}`}
                  />
                )}
              </Field>
            );
          })}
          {touched && v.duplicate && <Alert tone="error">Your four answers must be different from each other.</Alert>}
          {serverError && <Alert tone="error">{serverError}</Alert>}
          {saved && (
            <div data-testid="experience-saved">
              {saved.state === 'active' && <Alert tone="success" title="Saved — this category is now active">You can take tests, and tasks that asked for {label} will match you.</Alert>}
              {saved.state === 'pending_assessment' && (
                <Alert tone="success" title="Saved — pending assessment">
                  Your answers are saved and count towards completing your profile, so you can already take open tests.{' '}
                  {saved.reason === 'consent_required'
                    ? 'To have this professional category assessed, allow AI processing below.'
                    : 'This professional category becomes active when the assessment is done; until then it does not qualify you for targeted tasks.'}
                </Alert>
              )}
              {saved.state === 'incomplete' && <Alert tone="warning" title="Saved, but this category is not in your profile">Tick it in your tester profile above and save the profile to use it.</Alert>}
              {saved.state === 'inactive' && <Alert tone="warning" title="Saved, but this category is not in your profile">Tick {label} in “Which kinds of tester are you?” and save your profile to use these answers.</Alert>}
              {saved.state === 'not_qualified' && <Alert tone="warning" title="Saved — not qualified yet">You can edit your answers to be assessed again.</Alert>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy} data-testid="save-answers">
              {busy ? 'Saving…' : data.answers ? 'Save changes' : 'Save my answers'}
            </Button>
            <span className="text-xs text-slate-500">
              {data.saves_left} of {ANSWER_SAVES_PER_DAY} saves left in this 24-hour window.
            </span>
          </div>
        </form>
      )}
    </section>
  );
}

/** Explicit, revocable opt-in to AI processing. Nothing is sent to an AI service unless this is on. */
export function ConsentCard({ granted, onChanged }: { granted: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function toggle(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await setAiConsent(next);
      onChanged();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-10 max-w-2xl rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="ai-consent-h" data-testid="ai-consent">
      <h2 id="ai-consent-h" className="text-lg font-bold tracking-tight text-slate-900">
        AI personalization (optional)
      </h2>
      <p className="mt-2 text-sm text-slate-600">
        If you allow it, UXBarter may use an AI service to read your short bio, your selected categories and your written answers, in order to (1) recommend
        tests that are genuinely relevant to you and (2) assess professional categories. It is <strong>off by default</strong>: nothing is sent anywhere until you
        turn it on, and you can turn it off at any time. Your nickname and account id are never sent, and founders and other testers never see your answers.
        Without it you can still take every test you are eligible for; professional categories simply stay pending.
      </p>
      <p className="mt-2 text-xs text-slate-500" data-testid="ai-consent-policy">
        Turning it off stops all AI processing and erases the analysis and recommendations the AI derived about you. A qualification result you already received
        (it records only “qualified” or “not qualified”, never your answers) stays in place so you keep access to what you earned; to remove it, delete your answers
        below. If you change an answer while AI processing is off, that professional category waits as pending until you turn it on again.
      </p>
      <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm font-medium text-slate-900">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
          checked={granted}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
          data-testid="ai-consent-toggle"
        />
        <span>I allow UXBarter to process my bio and answers with an AI service for these two purposes.</span>
      </label>
      <p className="mt-2 text-xs text-slate-500" data-testid="ai-consent-state">
        {granted ? 'AI processing is ON for your profile.' : 'AI processing is OFF. Nothing about you is shared with an AI service.'}
      </p>
      {err && (
        <div className="mt-3">
          <Alert tone="error">{err}</Alert>
        </div>
      )}
    </section>
  );
}

/** Delete all my experience answers (and the assessment decisions made about them). */
export function DeleteExperience({ hasAnswers, onDeleted }: { hasAnswers: boolean; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setErr(null);
    try {
      await deleteMyExperience();
      setDone(true);
      setConfirm(false);
      onDeleted();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-6 max-w-2xl text-sm" data-testid="delete-experience">
      {!confirm ? (
        <Button type="button" variant="secondary" disabled={!hasAnswers || busy} onClick={() => setConfirm(true)} data-testid="delete-experience-btn">
          Delete my written answers
        </Button>
      ) : (
        <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm deleting my written answers">
          <span className="text-slate-700">Delete all four-question answers and any assessment of them? Your categories stay, but you will need to answer again to take tests.</span>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void run()} data-testid="confirm-delete-experience">
            Yes, delete
          </Button>
          <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>
            Keep them
          </Button>
        </span>
      )}
      {done && (
        <p className="mt-2 text-emerald-800" data-testid="experience-deleted">
          Your written answers were deleted.
        </p>
      )}
      {err && (
        <div className="mt-2">
          <Alert tone="error">{err}</Alert>
        </div>
      )}
    </div>
  );
}
