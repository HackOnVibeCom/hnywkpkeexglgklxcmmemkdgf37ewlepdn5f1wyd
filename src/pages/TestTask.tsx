import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { Field } from '../components/form';
import { Alert, Button, ButtonLink, EmptyState, ExternalLink, Spinner } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { ApiError, fetchProfile, friendlyError, getCampaignForTest, startTest, submitTest } from '../lib/api';
import { clock, hostOf } from '../lib/format';
import { MIN_TEST_SECONDS, RESERVATION_MINUTES } from '../lib/limits';
import type { SubmitTestResult } from '../lib/types';
import { useLoad } from '../lib/useLoad';
import { useNow } from '../lib/useNow';
import { LIMITS, lengthBetween } from '../lib/validation';

const RATING_LABELS = ['Very poor', 'Poor', 'OK', 'Good', 'Excellent'];

interface Errors {
  completed?: string;
  friction?: string;
  suggestion?: string;
  rating?: string;
}

interface Draft {
  completed: boolean | null;
  friction: string;
  suggestion: string;
  rating: number | null;
  shareConsent: boolean;
}

// Typed answers survive reloads, lapsed reservations and server errors (sessionStorage = this tab only).
const draftKey = (campaignId: string) => `pp:draft:${campaignId}`;

function loadDraft(campaignId: string): Partial<Draft> {
  try {
    const raw = sessionStorage.getItem(draftKey(campaignId));
    return raw ? (JSON.parse(raw) as Partial<Draft>) : {};
  } catch {
    return {};
  }
}

function saveDraft(campaignId: string, d: Draft | null): void {
  try {
    if (d === null) sessionStorage.removeItem(draftKey(campaignId));
    else sessionStorage.setItem(draftKey(campaignId), JSON.stringify(d));
  } catch {
    /* storage unavailable (private mode / blocked): the in-memory state still works */
  }
}

/** Codes after which the task is gone for this user: the saved draft can never be submitted, so drop it. */
const DRAFT_DEAD_CODES = new Set(['campaign_closed', 'campaign_not_found', 'already_tested', 'campaign_expired']);

/** Error codes after which the server state changed under us — re-read it. */
const RESYNC_CODES = new Set(['reservation_expired', 'reservation_required', 'campaign_closed', 'campaign_expired', 'campaign_reserved']);

export function TestTask() {
  const { campaignId = '' } = useParams();
  const { setBalance } = useAuth();
  const { data: campaign, error: loadError, loading, reload } = useLoad(() => getCampaignForTest(campaignId), campaignId);
  const nowMs = useNow();

  const [draft0] = useState(() => loadDraft(campaignId));
  const [completed, setCompleted] = useState<boolean | null>(typeof draft0.completed === 'boolean' ? draft0.completed : null);
  const [friction, setFriction] = useState(typeof draft0.friction === 'string' ? draft0.friction : '');
  const [suggestion, setSuggestion] = useState(typeof draft0.suggestion === 'string' ? draft0.suggestion : '');
  const [rating, setRating] = useState<number | null>(typeof draft0.rating === 'number' ? draft0.rating : null);
  const [shareConsent, setShareConsent] = useState(draft0.shareConsent === true);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitTestResult | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState(0);

  // Correct for client clock skew using the server time that came with the data.
  useEffect(() => {
    if (campaign) setClockOffset(Date.parse(campaign.server_now) - Date.now());
  }, [campaign]);

  useEffect(() => {
    if (result) return;
    // Don't litter storage with empty drafts for tasks the user never typed anything for.
    if (completed === null && !friction && !suggestion && rating === null && !shareConsent) return;
    saveDraft(campaignId, { completed, friction, suggestion, rating, shareConsent });
  }, [campaignId, completed, friction, suggestion, rating, shareConsent, result]);

  if (loading && !campaign) return <Spinner label="Loading task…" />;

  if (result) {
    return (
      <div className="max-w-xl space-y-6">
        <Alert tone="success" title="Feedback submitted — thank you!">
          You earned <strong>{result.credits_awarded} Test Credit</strong>. Your balance is now{' '}
          <strong>{result.balance}</strong>.
        </Alert>
        <div className="flex flex-wrap gap-3">
          <ButtonLink to="/create">Spend a credit on my product</ButtonLink>
          <ButtonLink to="/discover" variant="secondary">
            Test another product
          </ButtonLink>
        </div>
      </div>
    );
  }

  if (loadError && !campaign) return <Alert tone="error" title="Could not load this task">{loadError}</Alert>;

  if (!campaign) {
    return (
      <EmptyState title="This task isn’t available" action={<ButtonLink to="/discover">Browse open tasks</ButtonLink>}>
        It may already be completed, cancelled or expired, it may be your own project, or you may have tested it before.
      </EmptyState>
    );
  }

  if (campaign.reserved_by_other && !campaign.reserved_by_me) {
    return (
      <div className="max-w-xl space-y-6">
        <Alert tone="info" title="Someone else is testing this task right now">
          Each task is held for one tester at a time ({RESERVATION_MINUTES} minutes). It comes back to Discover
          automatically if they don’t finish.
        </Alert>
        <div className="flex flex-wrap gap-3">
          <ButtonLink to="/discover">Browse other tasks</ButtonLink>
          <Button variant="secondary" onClick={reload}>
            Check again
          </Button>
        </div>
      </div>
    );
  }

  // --- reservation timers (server-corrected) ---
  const serverNow = nowMs + clockOffset;
  const reservedUntil = campaign.reserved_by_me && campaign.reservation_expires_at ? Date.parse(campaign.reservation_expires_at) : null;
  const minAt = campaign.min_submit_at ? Date.parse(campaign.min_submit_at) : null;
  const hasReservation = reservedUntil !== null && campaign.project_url !== null;
  const reservationLive = hasReservation && serverNow < reservedUntil;
  const secondsLeft = reservedUntil !== null ? Math.max(0, Math.floor((reservedUntil - serverNow) / 1000)) : 0;
  const waitSeconds = minAt !== null ? Math.max(0, Math.ceil((minAt - serverNow) / 1000)) : 0;
  const canSubmit = reservationLive && waitSeconds === 0 && !submitting;

  async function onReserve() {
    setStartError(null);
    setStarting(true);
    try {
      await startTest(campaignId);
      reload(); // re-read the page: the website URL is only returned to the holder of a live reservation
    } catch (err) {
      setStartError(friendlyError(err));
      if (err instanceof ApiError && err.code && RESYNC_CODES.has(err.code)) reload();
    } finally {
      setStarting(false);
    }
  }

  function validate(): Errors {
    const e: Errors = {};
    if (completed === null) e.completed = 'Tell us whether you completed the task.';
    if (!lengthBetween(friction, LIMITS.feedbackMin, LIMITS.feedbackMax)) {
      e.friction = `Write ${LIMITS.feedbackMin}–${LIMITS.feedbackMax} characters. If nothing was confusing, say so.`;
    }
    if (!lengthBetween(suggestion, LIMITS.feedbackMin, LIMITS.feedbackMax)) {
      e.suggestion = `Write ${LIMITS.feedbackMin}–${LIMITS.feedbackMax} characters.`;
    }
    if (rating === null) e.rating = 'Choose a rating.';
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setServerError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0 || completed === null || rating === null) return;

    setSubmitting(true);
    try {
      const res = await submitTest({
        campaignId,
        taskCompleted: completed,
        friction,
        suggestion,
        uxRating: rating,
        shareConsent,
      });
      saveDraft(campaignId, null);
      setBalance(res.balance);
      setResult(res);
    } catch (err) {
      setServerError(friendlyError(err));
      setSubmitting(false);
      if (err instanceof ApiError && err.code) {
        if (DRAFT_DEAD_CODES.has(err.code)) saveDraft(campaignId, null);
        // The first submit may have succeeded with a lost response: re-read the authoritative balance.
        if (err.code === 'already_tested') {
          fetchProfile()
            .then((p) => setBalance(p.credit_balance))
            .catch(() => undefined);
        }
        if (RESYNC_CODES.has(err.code)) reload();
      }
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-5">
      <aside className="space-y-5 lg:col-span-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Product to test</p>
          <h1 className="mt-1 break-words text-2xl font-bold tracking-tight text-slate-900">{campaign.project_name}</h1>
          {campaign.description && <p className="mt-2 break-words text-sm text-slate-600">{campaign.description}</p>}
        </div>

        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Your task</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-slate-900">{campaign.task_description}</p>
        </div>

        {hasReservation && campaign.project_url ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-semibold text-slate-900">Step 1 — open the website</p>
            <a
              href={campaign.project_url}
              target="_blank"
              rel="noopener noreferrer nofollow ugc"
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Open {hostOf(campaign.project_url)} ↗
            </a>
            <p className="mt-3 break-all text-xs text-slate-500">
              <ExternalLink href={campaign.project_url}>{campaign.project_url}</ExternalLink>
            </p>
            <p className="mt-3 text-xs text-slate-500">
              It opens in a new tab. Try the task, then come back here for step 2. This site belongs to another user and is
              not vetted by PeerProbe — don’t enter real passwords or payment details.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-semibold text-slate-900">Step 1 — reserve this task</p>
            <p className="mt-2 text-sm text-slate-600">
              Reserving holds the task for you for <strong>{RESERVATION_MINUTES} minutes</strong> and reveals the website.
              Please spend at least <strong>{MIN_TEST_SECONDS} seconds</strong> really testing before you submit. If you run
              out of time, nothing is lost — you can reserve it again.
            </p>
            {startError && (
              <div className="mt-3">
                <Alert tone="error">{startError}</Alert>
              </div>
            )}
            <Button className="mt-4 w-full" size="lg" onClick={onReserve} disabled={starting}>
              {starting ? 'Reserving…' : 'Reserve task & reveal website'}
            </Button>
            {(friction || suggestion) && (
              <p className="mt-3 text-xs text-slate-500">Your earlier answers are saved on this device and will be restored.</p>
            )}
          </div>
        )}
      </aside>

      {!hasReservation ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center text-sm text-slate-500 lg:col-span-3">
          Step 2 (your feedback) unlocks after you reserve the task.
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-6 lg:col-span-3">
          {reservationLive ? (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
              <span className="font-semibold">Reserved for you</span> · time left{' '}
              <span className="font-mono font-semibold" data-testid="reservation-left">{clock(secondsLeft)}</span>
              {waitSeconds > 0 ? (
                <>
                  {' '}
                  · you can submit in <span className="font-mono font-semibold" data-testid="submit-wait">{clock(waitSeconds)}</span>
                </>
              ) : (
                <> · you can submit now</>
              )}
            </div>
          ) : (
            <Alert tone="warning" title="Your reservation ran out">
              Your answers below are kept. Reserve the task again to continue — if nobody else took it meanwhile, you can
              submit right away.
              <div className="mt-3 flex items-center gap-3">
                <Button onClick={onReserve} disabled={starting}>
                  {starting ? 'Reserving…' : 'Reserve again'}
                </Button>
                {startError && <span className="text-red-700">{startError}</span>}
              </div>
            </Alert>
          )}

          <p className="text-sm font-semibold text-slate-900">Step 2 — share what happened</p>

          <fieldset aria-describedby="completed-err">
            <legend className="text-sm font-semibold text-slate-800">Did you complete the task?</legend>
            <div className="mt-2 flex gap-3">
              {[
                { v: true, label: 'Yes, I completed it' },
                { v: false, label: 'No, I got stuck' },
              ].map((o) => (
                <label
                  key={String(o.v)}
                  className={`flex flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                    completed === o.v ? 'border-indigo-500 bg-indigo-50 font-semibold text-indigo-900' : 'border-slate-300 bg-white'
                  }`}
                >
                  <input
                    type="radio"
                    name="completed"
                    className="accent-indigo-600"
                    checked={completed === o.v}
                    onChange={() => setCompleted(o.v)}
                  />
                  {o.label}
                </label>
              ))}
            </div>
            <p id="completed-err" className="mt-1.5 min-h-4 text-xs text-red-700">
              {errors.completed}
            </p>
          </fieldset>

          <Field
            label="What was confusing or caused friction?"
            error={errors.friction}
            hint="Be specific: which screen, which element, what you expected."
            counter={{ value: friction, max: LIMITS.feedbackMax }}
          >
            {({ id, describedBy, invalid, className }) => (
              <textarea
                id={id}
                className={className}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                rows={4}
                value={friction}
                onChange={(e) => setFriction(e.target.value)}
              />
            )}
          </Field>

          <Field
            label="What is one improvement you’d suggest?"
            error={errors.suggestion}
            counter={{ value: suggestion, max: LIMITS.feedbackMax }}
          >
            {({ id, describedBy, invalid, className }) => (
              <textarea
                id={id}
                className={className}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                rows={3}
                value={suggestion}
                onChange={(e) => setSuggestion(e.target.value)}
              />
            )}
          </Field>

          <fieldset aria-describedby="rating-err">
            <legend className="text-sm font-semibold text-slate-800">Overall UX rating</legend>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {RATING_LABELS.map((label, i) => {
                const value = i + 1;
                return (
                  <label
                    key={value}
                    className={`flex cursor-pointer flex-col items-center rounded-lg border px-1 py-2 text-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-indigo-600 ${
                      rating === value ? 'border-indigo-500 bg-indigo-50 text-indigo-900' : 'border-slate-300 bg-white'
                    }`}
                  >
                    <input
                      type="radio"
                      name="rating"
                      className="sr-only"
                      checked={rating === value}
                      onChange={() => setRating(value)}
                    />
                    <span className="text-lg font-bold">{value}</span>
                    <span className="text-[11px] leading-tight text-slate-500">{label}</span>
                  </label>
                );
              })}
            </div>
            <p id="rating-err" className="mt-1.5 min-h-4 text-xs text-red-700">
              {errors.rating}
            </p>
          </fieldset>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5 accent-indigo-600"
              checked={shareConsent}
              onChange={(e) => setShareConsent(e.target.checked)}
            />
            <span>
              <strong className="text-slate-900">Optional:</strong> allow the founder to quote my feedback publicly
              (anonymously). Leave unchecked to keep it private to them.
            </span>
          </label>

          {serverError && <Alert tone="error">{serverError}</Alert>}

          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" size="lg" disabled={!canSubmit}>
              {submitting ? 'Submitting…' : 'Submit feedback & earn 1 credit'}
            </Button>
            {reservationLive && waitSeconds > 0 && (
              <span className="text-sm text-slate-500">
                Unlocks after {MIN_TEST_SECONDS} seconds of testing — {waitSeconds}s to go.
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
