import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { CategoryPicker } from '../components/CategoryPicker';
import { Field } from '../components/form';
import { Alert, Button, ButtonLink, PageHeader } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { createCampaign, fetchProfile, friendlyError } from '../lib/api';
import { CAMPAIGN_EXPIRY_DAYS } from '../lib/limits';
import type { TestingMode } from '../lib/matching';
import { LIMITS, isValidPublicUrl, lengthBetween } from '../lib/validation';

interface Errors {
  categories?: string;
  name?: string;
  url?: string;
  description?: string;
  task?: string;
}

export function CreateTask() {
  const { profile, setBalance } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [task, setTask] = useState('');
  const [targetCategories, setTargetCategories] = useState<string[]>([]);
  const [mode, setMode] = useState<TestingMode>('open');
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const balance = profile?.credit_balance ?? 0;
  const canAfford = balance >= 1;

  function validate(): Errors {
    const e: Errors = {};
    if (!lengthBetween(name, LIMITS.nameMin, LIMITS.nameMax)) e.name = `Name must be ${LIMITS.nameMin}–${LIMITS.nameMax} characters.`;
    if (!isValidPublicUrl(url)) e.url = 'Enter a public website URL like https://yourapp.com (no localhost or IP addresses).';
    if (description.trim().length > LIMITS.descriptionMax) e.description = `Keep it under ${LIMITS.descriptionMax} characters.`;
    if (!lengthBetween(task, LIMITS.taskMin, LIMITS.taskMax)) {
      e.task = `Describe the task in ${LIMITS.taskMin}–${LIMITS.taskMax} characters.`;
    }
    if (mode === 'targeted' && targetCategories.length === 0) e.categories = 'Choose at least one tester category, or switch to open testing.';
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setServerError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    setSubmitting(true);
    try {
      await createCampaign({ name, url, description, task, mode, targetCategories });
      // Balance is authoritative in Postgres; re-read it rather than guessing.
      const fresh = await fetchProfile();
      setBalance(fresh.credit_balance);
      navigate('/dashboard', { state: { justCreated: true } });
    } catch (err) {
      setServerError(friendlyError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Request a test"
        subtitle="Describe your product and one specific task. A real founder will try it and report back."
      />

      <div className="mb-6">
        {canAfford ? (
          <Alert tone="info">
            This costs <strong>1 credit</strong>. You have <strong>{balance}</strong>. Your request stays open for{' '}
            {CAMPAIGN_EXPIRY_DAYS} days; if nobody tests it, or you cancel while nobody is testing it, the credit is refunded.
          </Alert>
        ) : (
          <Alert tone="warning" title="You have 0 credits">
            Test another founder’s product to earn one, then come back.{' '}
            <ButtonLink to="/discover" variant="ghost" className="!px-1 !py-0 underline">
              Find a task to test
            </ButtonLink>
          </Alert>
        )}
      </div>

      <form onSubmit={onSubmit} noValidate className="space-y-6">
        <Field label="Project name" error={errors.name} counter={{ value: name, max: LIMITS.nameMax }}>
          {({ id, describedBy, invalid, className }) => (
            <input
              id={id}
              className={className}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Invoicing"
              maxLength={LIMITS.nameMax + 20}
              autoComplete="off"
            />
          )}
        </Field>

        <Field
          label="Website URL"
          error={errors.url}
          hint="Must be publicly reachable. Testers will open it in a new tab."
        >
          {({ id, describedBy, invalid, className }) => (
            <input
              id={id}
              className={className}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://yourapp.com"
              autoComplete="off"
            />
          )}
        </Field>

        <Field
          label="What does it do? (optional)"
          error={errors.description}
          counter={{ value: description, max: LIMITS.descriptionMax }}
        >
          {({ id, describedBy, invalid, className }) => (
            <textarea
              id={id}
              className={className}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A one-line description so testers have context."
            />
          )}
        </Field>

        <Field
          label="The task (2–3 minutes)"
          error={errors.task}
          hint="Be specific and outcome-based: what should the tester try to accomplish?"
          counter={{ value: task, max: LIMITS.taskMax }}
        >
          {({ id, describedBy, invalid, className }) => (
            <textarea
              id={id}
              className={className}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              rows={4}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Sign up for the free plan and find out how to export your data as CSV."
            />
          )}
        </Field>

        <fieldset data-testid="mode-picker">
          <legend className="text-sm font-semibold text-slate-800">Who can take this test?</legend>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {(
              [
                {
                  id: 'open' as const,
                  title: 'Open testing',
                  body: 'Any eligible tester can take it. You can optionally pick categories to recommend it to first — nobody is excluded, so it is usually tested sooner.',
                },
                {
                  id: 'targeted' as const,
                  title: 'Targeted testing',
                  body: 'Only testers who match at least one category you choose can start it, and the server enforces that. Professional categories also need an assessment of their self-reported written experience. Fewer testers qualify, so it may take longer.',
                },
              ]
            ).map((m) => (
              <label
                key={m.id}
                data-testid={`mode-${m.id}`}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 text-sm ${mode === m.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-white hover:bg-slate-50'}`}
              >
                <input type="radio" name="testing-mode" className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600" checked={mode === m.id} onChange={() => setMode(m.id)} />
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-900">{m.title}</span>
                  <span className="mt-0.5 block text-xs text-slate-600">{m.body}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <CategoryPicker
            legend={mode === 'targeted' ? 'Required tester categories (choose at least one)' : 'Recommend it to (optional)'}
            hint={
              mode === 'targeted' ? (
                <>
                  A tester must have <strong>at least one</strong> of these in their profile. Every category needs the tester's four written
                  answers. Tech-Savvy Users, Founders &amp; Product Builders and Business &amp; Office Users must also have been
                  <strong>assessed</strong> from their self-reported experience (not a verified credential). Students &amp; Learners and
                  Everyday &amp; Non-Technical Users become active once their answers are saved.
                  If nobody tests it within {CAMPAIGN_EXPIRY_DAYS} days, your credit is refunded.
                </>
              ) : (
                <>
                  <strong>Targeted Tester Matching:</strong> the task is recommended first to testers who chose these categories. It is a
                  preference, not a restriction — any tester can still pick it up.
                </>
              )
            }
            value={targetCategories}
            onChange={setTargetCategories}
            testIdPrefix="target"
          />
          {errors.categories && (
            <p role="alert" className="mt-2 text-sm text-red-700" data-testid="categories-error">
              {errors.categories}
            </p>
          )}
        </div>

        {serverError && <Alert tone="error">{serverError}</Alert>}

        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" size="lg" disabled={submitting || !canAfford}>
            {submitting ? 'Posting…' : 'Spend 1 credit & request test'}
          </Button>
          <span className="text-sm text-slate-500">One human response per request.</span>
        </div>
      </form>
    </div>
  );
}
