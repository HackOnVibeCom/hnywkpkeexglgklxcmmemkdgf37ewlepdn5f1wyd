import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { CategoryPicker } from '../components/CategoryPicker';
import { Field } from '../components/form';
import { Alert, Button, ButtonLink, PageHeader } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { createCampaign, fetchProfile, friendlyError } from '../lib/api';
import { CAMPAIGN_EXPIRY_DAYS } from '../lib/limits';
import { LIMITS, isValidPublicUrl, lengthBetween } from '../lib/validation';

interface Errors {
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
      await createCampaign({ name, url, description, task, targetCategories });
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

        <CategoryPicker
          legend="Preferred testers (optional)"
          hint={
            <>
              <strong>Targeted Tester Matching:</strong> your task is recommended first to testers who chose these categories.
              It is a preference, not a guarantee — any tester can still pick it up, and with none selected it is shown to everyone.
            </>
          }
          value={targetCategories}
          onChange={setTargetCategories}
          testIdPrefix="target"
        />

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
