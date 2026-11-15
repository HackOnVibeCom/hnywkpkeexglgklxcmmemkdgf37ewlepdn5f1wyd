import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConsentCard, DeleteExperience, ExperiencePanel, StatusPill } from '../components/Experience';
import { AssessmentPanel } from '../components/ai/AssessmentPanel';
import { CategoryPicker } from '../components/CategoryPicker';
import { Field } from '../components/form';
import { Alert, Button, ButtonLink, PageHeader, Spinner } from '../components/ui';
import { deleteMyExperience, deleteTesterProfile, friendlyError, getMyExperience, getMyTesterProfile, saveTesterProfile } from '../lib/api';
import { categoryLabel, CATEGORY_IDS, experienceBadge, isCategoryId, normalizeCategories, suggestCategories, type CategorySuggestion } from '../lib/matching';
import type { ExperienceCategory, MyExperience, TesterProfile } from '../lib/types';
import { useLoad } from '../lib/useLoad';

const NICK_MAX = 30;
const BIO_MAX = 280;

export function Profile() {
  const { data, error, loading, reload } = useLoad<{ profile: TesterProfile | null; experience: MyExperience | null }>(async () => {
    const [profile, experience] = await Promise.all([
      getMyTesterProfile(),
      // null = backend without migration 8: the previous profile page behaviour (no questions, no consent)
      getMyExperience().catch(() => null),
    ]);
    return { profile, experience };
  });
  const [params] = useSearchParams();
  const wanted = params.get('answers') ?? '';
  const [open, setOpen] = useState<string | null>(isCategoryId(wanted) ? wanted : null);
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (isCategoryId(wanted)) sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [wanted, data]);
  /** Open one category's four questions and bring them into view. */
  function openAnswers(cat: string) {
    setOpen(cat);
    window.setTimeout(() => sectionRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }), 0);
  }

  const exp = data?.experience ?? null;
  // Bumped ONLY by an event that legitimately starts an automatic assessment: the tester saved a professional category's answers
  // while AI processing is on, or switched AI processing on. A page load or refresh never bumps it (so it never costs a request).
  const [autoToken, setAutoToken] = useState(0);
  function afterConsentChange(granted: boolean) {
    reload();
    if (granted) setAutoToken((n) => n + 1);
  }
  function afterAnswersSaved(c: ExperienceCategory) {
    reload();
    if (c.requires_assessment && c.state === 'pending_assessment' && c.reason !== 'consent_required' && exp?.ai_consent.granted) setAutoToken((n) => n + 1);
  }
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Tester profile"
        subtitle="Browsing and requesting tests needs no profile. To take tests and earn credits, tell UXBarter what you have experience with, in four short written answers."
      />
      {error && (
        <div className="mb-6">
          <Alert tone="error" title="Could not load your profile">
            {error}
          </Alert>
        </div>
      )}
      {loading && !data && <Spinner label="Loading your profile…" />}
      {data && exp && <CompletionBanner exp={exp} onAnswer={openAnswers} />}
      {data && <ProfileForm initial={data.profile} experience={exp} onChanged={reload} />}
      {data && exp && data.profile && (
        <ExperienceSection exp={exp} open={open} setOpen={setOpen} sectionRef={sectionRef} onSaved={afterAnswersSaved} />
      )}
      {data && exp && <AssessmentPanel exp={exp} onChanged={reload} autoToken={autoToken} />}
      {data && exp && <ConsentCard granted={exp.ai_consent.granted} onChanged={afterConsentChange} />}
      {data && exp && <DeleteExperience hasAnswers={exp.categories.some((c) => c.answers_version !== null)} onDeleted={reload} />}
    </div>
  );
}

function CompletionBanner({ exp, onAnswer }: { exp: MyExperience; onAnswer: (cat: string) => void }) {
  const firstIncomplete = exp.categories.find((c) => c.selected && !c.answers_complete);
  if (exp.participation_ready) {
    return (
      <div className="mb-6" data-testid="profile-complete">
        <Alert tone="success" title="Your tester profile is complete">
          You can take tests and earn credits.{' '}
          {exp.active_categories.length > 0
            ? `Active categories: ${exp.active_categories.map(categoryLabel).join(', ')}.`
            : 'None of your categories is active yet (professional categories wait for their assessment); every open task is available to you.'}
        </Alert>
      </div>
    );
  }
  return (
    <div className="mb-6" data-testid="profile-incomplete">
      <Alert tone="warning" title="Complete your tester profile to start testing">
        To take tests and earn credits, tick at least one category below, save your profile, and answer its four short questions. Until then you can still browse,
        request tests and use everything else.
        {firstIncomplete && (
          <div className="mt-3">
            <Button type="button" variant="secondary" onClick={() => onAnswer(firstIncomplete.category)} data-testid="banner-answer">
              Answer the questions for {categoryLabel(firstIncomplete.category)}
            </Button>
          </div>
        )}
      </Alert>
    </div>
  );
}

function ExperienceSection({
  exp,
  open,
  setOpen,
  sectionRef,
  onSaved,
}: {
  exp: MyExperience;
  open: string | null;
  setOpen: (cat: string | null) => void;
  sectionRef: React.MutableRefObject<HTMLElement | null>;
  onSaved: (c: ExperienceCategory) => void;
}) {
  const selected = exp.categories.filter((c) => c.selected);
  return (
    <section ref={sectionRef} className="mt-12 max-w-2xl" aria-labelledby="experience-h" data-testid="experience-section">
      <h2 id="experience-h" className="text-xl font-bold tracking-tight text-slate-900">
        Your experience
      </h2>
      <p className="mt-2 text-sm text-slate-600">
        Each category you selected has four short written questions. Categories are independent: finishing one does not change another. Students &amp; Learners and
        Everyday &amp; Non-Technical Users become <strong>active</strong> as soon as the answers are saved. Tech-Savvy Users, Founders &amp; Product Builders and Business
        &amp; Office Users stay <strong>pending</strong> until an assessment of your answers is done: submitting text alone never activates them. It is
        self-reported, not a verified credential.
      </p>
      {selected.length === 0 ? (
        <p className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600" data-testid="no-categories">
          Choose at least one category above and save your profile; its four questions will appear here.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {selected.map((c) => (
            <li key={c.category} className="rounded-xl border border-slate-200 bg-white p-4" data-testid={`experience-row-${c.category}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">{categoryLabel(c.category)}</p>
                  <p className="mt-1">
                    <StatusPill category={c} testId={`status-${c.category}`} />
                  </p>
                </div>
                {open !== c.category && (
                  <Button type="button" variant="secondary" onClick={() => setOpen(c.category)} data-testid={`answer-${c.category}`}>
                    {c.answers_version === null ? 'Answer the 4 questions' : 'Edit my answers'}
                  </Button>
                )}
              </div>
              {open === c.category && (
                <ExperiencePanel
                  category={c.category}
                  onSaved={(res) => onSaved(res)}
                  onClose={() => setOpen(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProfileForm({ initial, experience, onChanged }: { initial: TesterProfile | null; experience: MyExperience | null; onChanged: () => void }) {
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
      // removing the profile also removes the written answers (nothing personal is left behind the user's back)
      if (experience) await deleteMyExperience();
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
  // Status per category as decided by the DATABASE (migration 8); the form only shows it.
  const byCat = new Map((experience?.categories ?? []).map((c) => [c.category, c]));
  const badges: Record<string, { kind: 'active' | 'pending' | 'incomplete' | 'warn'; text: string } | null> | undefined = experience
    ? Object.fromEntries(
        CATEGORY_IDS.map((id) => {
          if (!categories.includes(id)) return [id, null];
          const c: ExperienceCategory | undefined = byCat.get(id);
          if (!c || !c.selected) return [id, { kind: 'incomplete' as const, text: 'Save your profile, then answer its four questions' }];
          return [id, experienceBadge(c)];
        }),
      )
    : undefined;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6" data-testid="profile-form">
      <Alert tone="info" title="How your profile is used">
        Founders can ask for <strong>targeted</strong> testers in specific categories; the server only lets matching testers start those tasks. Open tasks are
        available to every tester with a complete profile. Your profile and answers are private to you and never shown to founders or other testers.
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
        hint="Voluntary. What do you do, and what kind of products do you use? Only used for AI personalization if you turn that on below. Please leave out sensitive personal details (health, religion, politics, age, ethnicity …)."
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
        hint="Choose any that fit. Each one gets four short written questions; you need at least one completed category to take tests. A student can be an expert and an everyday user can be a careful tester: pick what describes your experience."
        value={categories}
        onChange={(next) => setCategories(next)}
        testIdPrefix="profile-cat"
        badges={badges}
      />

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={() => setSuggestions(suggestCategories(bio))} data-testid="suggest-btn">
            Suggest categories from my bio
          </Button>
          <span className="text-xs text-slate-500">Simple keyword matching on the words you typed — not AI. Nothing is selected for you.</span>
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
          {experience ? (
            categories.length > 0 ? (
              <span data-testid="saved-next">Next, answer the four questions for each category below: a category only counts once its answers are saved.</span>
            ) : (
              <>Saved without categories. Choose at least one to be able to take tests.</>
            )
          ) : categories.length > 0 ? (
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
      {saved === 'removed' && <Alert tone="success" title="Profile removed">Your profile{experience ? ' and written answers were' : ' was'} deleted.</Alert>}

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
            <span className="text-slate-700">{experience ? 'Delete nickname, bio, categories and your written answers?' : 'Delete nickname, bio and categories?'}</span>
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
        Your profile lives with your anonymous identity in this browser. It is only used to decide which tasks you can take and how they are ordered. It is
        not shown to founders, not shared with other testers and never changes your credits. Unless you turn on AI personalization further down this page, nothing about
        you is sent to any AI service.
      </p>
    </form>
  );
}
