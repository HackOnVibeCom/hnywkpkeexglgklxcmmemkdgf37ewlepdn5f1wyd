import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ScreeningPanel } from '../components/Screening';
import { CategoryPicker } from '../components/CategoryPicker';
import { Field } from '../components/form';
import { Alert, Button, ButtonLink, PageHeader, Spinner } from '../components/ui';
import { deleteTesterProfile, friendlyError, getMyScreeningStatus, getMyTesterProfile, saveTesterProfile } from '../lib/api';
import { categoryLabel, normalizeCategories, requiresScreening, SCREENED_LABEL, suggestCategories, SCREENING_CATEGORY_IDS, type CategorySuggestion } from '../lib/matching';
import type { ScreeningStatus, TesterProfile } from '../lib/types';
import { useLoad } from '../lib/useLoad';

const NICK_MAX = 30;
const BIO_MAX = 280;

export function Profile() {
  const { data, error, loading, reload } = useLoad<{ profile: TesterProfile | null; screening: ScreeningStatus[] }>(async () => {
    const [profile, screening] = await Promise.all([getMyTesterProfile(), getMyScreeningStatus().catch(() => [] as ScreeningStatus[])]);
    return { profile, screening };
  });

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Tester profile"
        subtitle="Optional. Tell UXBarter what kind of tester you are, and Discover will show the tasks aimed at people like you first. Open tasks always stay available."
      />
      {error && (
        <div className="mb-6">
          <Alert tone="error" title="Could not load your profile">
            {error}
          </Alert>
        </div>
      )}
      {loading && !data && <Spinner label="Loading your profile…" />}
      {data && <ProfileForm initial={data.profile} onChanged={reload} />}
      {data && data.screening.length > 0 && <ScreeningSection status={data.screening} onChanged={reload} />}
    </div>
  );
}

function ScreeningSection({ status, onChanged }: { status: ScreeningStatus[]; onChanged: () => void }) {
  const [params] = useSearchParams();
  const wanted = params.get('screening') ?? '';
  const [open, setOpen] = useState<string | null>(requiresScreening(wanted) ? wanted : null);
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (requiresScreening(wanted)) {
      sectionRef.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [wanted]);
  const byCat = new Map(status.map((s) => [s.category, s]));
  return (
    <section ref={sectionRef} className="mt-12 max-w-2xl" aria-labelledby="screening-h" data-testid="screening-section">
      <h2 id="screening-h" className="text-xl font-bold tracking-tight text-slate-900">
        Experience screening
      </h2>
      <p className="mt-2 text-sm text-slate-600">
        Founders can ask for <strong>targeted</strong> testers. To take a targeted task for <strong>Tech-Savvy Users</strong>,{' '}
        <strong>Founders &amp; Product Builders</strong> or <strong>Business &amp; Office Users</strong>, your profile must include that
        category <em>and</em> you must complete a short screening about your hands-on experience. Students &amp; Learners and Everyday &amp;
        Non-Technical Users need none. Screening is <strong>self-reported</strong> — it is not a verified credential — and it never
        affects open tasks.
      </p>
      <ul className="mt-4 space-y-3">
        {SCREENING_CATEGORY_IDS.map((cat) => {
          const s = byCat.get(cat);
          return (
            <li key={cat} className="rounded-xl border border-slate-200 bg-white p-4" data-testid={`screening-row-${cat}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">{categoryLabel(cat)}</p>
                  {s?.qualified ? (
                    <p className="mt-0.5 text-sm font-medium text-emerald-800" data-testid={`screened-${cat}`}>
                      ✓ {SCREENED_LABEL}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-sm text-slate-500" data-testid={`not-screened-${cat}`}>
                      Not screened yet
                      {s && s.attempts_left === 0 && s.next_attempt_at ? ` · next attempt after ${new Date(s.next_attempt_at).toLocaleString()}` : ''}
                    </p>
                  )}
                </div>
                {open !== cat && !s?.qualified && (
                  <Button type="button" variant="secondary" onClick={() => setOpen(cat)} data-testid={`start-screening-${cat}`}>
                    Take the screening
                  </Button>
                )}
              </div>
              {open === cat && (
                <ScreeningPanel
                  category={cat}
                  onDone={onChanged}
                  onClose={() => setOpen(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ProfileForm({ initial, onChanged }: { initial: TesterProfile | null; onChanged: () => void }) {
  const [nickname, setNickname] = useState(initial?.nickname ?? '');
  const [bio, setBio] = useState(initial?.bio ?? '');
  const [categories, setCategories] = useState<string[]>(normalizeCategories(initial?.categories));
  const [suggestions, setSuggestions] = useState<CategorySuggestion[] | null>(null);
  const [errors, setErrors] = useState<{ nickname?: string; bio?: string }>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<'saved' | 'removed' | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  function validate() {
    const e: { nickname?: string; bio?: string } = {};
    const n = nickname.trim().length;
    if (n < 2 || n > NICK_MAX) e.nickname = `Nickname must be 2–${NICK_MAX} characters.`;
    if (bio.trim().length > BIO_MAX) e.bio = `Keep it under ${BIO_MAX} characters.`;
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setServerError(null);
    setSaved(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setSaving(true);
    try {
      await saveTesterProfile({ nickname, bio, categories });
      setSaved('saved');
      onChanged();
    } catch (err) {
      setServerError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  async function onRemove() {
    setServerError(null);
    setSaving(true);
    try {
      await deleteTesterProfile();
      setNickname('');
      setBio('');
      setCategories([]);
      setSuggestions(null);
      setConfirmRemove(false);
      setSaved('removed');
      onChanged();
    } catch (err) {
      setServerError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  const missing = suggestions?.filter((s) => !categories.includes(s.id)) ?? [];

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6" data-testid="profile-form">
      <Alert tone="info" title="Targeted Tester Matching">
        Founders can say which kinds of testers they would like. If you pick categories here, tasks that asked for them are
        marked <strong>Recommended for you</strong> and listed first. For <strong>open</strong> tasks this is only a recommendation:
        you can still test any of them, and your rewards never depend on matching. <strong>Targeted</strong> tasks (where the founder
        requires certain categories) can only be started by matching testers — see the screening section below.
      </Alert>

      <Field label="Nickname" error={errors.nickname} hint="Only you see this. It is never shown to founders or other testers." counter={{ value: nickname, max: NICK_MAX }}>
        {({ id, describedBy, invalid, className }) => (
          <input
            id={id}
            className={className}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="e.g. Sam"
            maxLength={NICK_MAX + 10}
            autoComplete="off"
          />
        )}
      </Field>

      <Field
        label="Short bio (optional)"
        error={errors.bio}
        hint="What do you do, and what kind of products do you use? Please leave out sensitive personal details (health, religion, politics, age, ethnicity …)."
        counter={{ value: bio, max: BIO_MAX }}
      >
        {({ id, describedBy, invalid, className }) => (
          <textarea
            id={id}
            className={className}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            rows={3}
            value={bio}
            onChange={(e) => {
              setBio(e.target.value);
              setSuggestions(null);
            }}
            placeholder="I run a small bakery and use apps for orders and invoices."
          />
        )}
      </Field>

      <CategoryPicker
        legend="Which kinds of tester are you?"
        hint="Choose any that fit, or none. You can change this whenever you like."
        value={categories}
        onChange={(next) => setCategories(next)}
        testIdPrefix="profile-cat"
      />

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={() => setSuggestions(suggestCategories(bio))} data-testid="suggest-btn">
            Suggest categories from my bio
          </Button>
          <span className="text-xs text-slate-500">
            Simple keyword matching on the words you typed — not AI. Nothing is selected for you.
          </span>
        </div>
        {suggestions && (
          <div className="mt-3 text-sm" data-testid="suggestions" aria-live="polite">
            {suggestions.length === 0 ? (
              <p className="text-slate-600">
                {bio.trim() ? 'No known keywords found in your bio. Choose categories yourself above.' : 'Write a short bio first, or just choose categories yourself above.'}
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {suggestions.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <strong className="text-slate-900">{s.label}</strong>
                        <span className="text-slate-600"> — matched: {s.matched.map((m) => `“${m}”`).join(', ')}</span>
                      </span>
                      {categories.includes(s.id) ? (
                        <span className="text-xs font-medium text-emerald-700">Already selected</span>
                      ) : (
                        <Button type="button" variant="ghost" className="!py-1" onClick={() => setCategories(normalizeCategories([...categories, s.id]))} data-testid={`add-${s.id}`}>
                          Add
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {missing.length > 1 && (
                  <Button type="button" variant="ghost" className="mt-2 !py-1" onClick={() => setCategories(normalizeCategories([...categories, ...missing.map((m) => m.id)]))}>
                    Add all suggestions
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {serverError && <Alert tone="error">{serverError}</Alert>}
      {saved === 'saved' && (
        <Alert tone="success" title="Profile saved">
          {categories.length > 0 ? (
            <>
              Discover will recommend tasks for {categories.map(categoryLabel).join(', ')}.{' '}
              <ButtonLink to="/discover" variant="ghost" className="!px-1 !py-0 underline">
                See recommended tasks
              </ButtonLink>
            </>
          ) : (
            <>Saved without categories, so Discover behaves as before.</>
          )}
        </Alert>
      )}
      {saved === 'removed' && <Alert tone="success" title="Profile removed">Your profile was deleted. Discover works exactly as before.</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={saving}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Save profile'}
        </Button>
        {initial && !confirmRemove && (
          <Button type="button" variant="secondary" size="lg" disabled={saving} onClick={() => setConfirmRemove(true)}>
            Remove my profile
          </Button>
        )}
        {initial && confirmRemove && (
          <span className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Confirm removing your profile">
            <span className="text-slate-700">Delete nickname, bio and categories?</span>
            <Button type="button" variant="secondary" disabled={saving} onClick={onRemove} data-testid="confirm-remove">
              Yes, remove
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Your profile lives with your anonymous identity in this browser. It is only used to order the task list for you. It is
        not shown to founders, not shared with other testers and never changes your credits.
      </p>
    </form>
  );
}
