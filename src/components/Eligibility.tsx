import { ButtonLink } from './ui';
import { CategoryBadges } from './CategoryPicker';
import { explainIneligible, type TestingMode } from '../lib/matching';
import type { CampaignEligibility } from '../lib/types';

/** "Open testing" / "Targeted testing" pill. */
export function ModeBadge({ mode }: { mode: TestingMode }) {
  return mode === 'targeted' ? (
    <span data-testid="mode-badge" className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
      Targeted testing
    </span>
  ) : (
    <span data-testid="mode-badge" className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
      Open testing
    </span>
  );
}

/**
 * Shown instead of the "Reserve" button when the SERVER says this tester cannot start a targeted task. The rules are
 * enforced in PostgreSQL (a reservation is refused); this panel only explains why and what to do.
 */
export function EligibilityPanel({ elig }: { elig: CampaignEligibility }) {
  const ex = explainIneligible(elig.reason, elig.required_categories, elig.missing_screening);
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950" data-testid="eligibility-panel" role="status">
      <p className="text-sm font-semibold">Not eligible: {ex.title}</p>
      <p className="mt-2 text-sm">{ex.body}</p>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-amber-800">Required (at least one)</p>
      <CategoryBadges ids={elig.required_categories} highlight={elig.overlap} className="mt-1.5" />
      <div className="mt-4 flex flex-wrap gap-2">
        {ex.action === 'screening' && ex.screeningCategory && (
          <ButtonLink to={`/profile?screening=${ex.screeningCategory}`} data-testid="take-screening">
            Take the screening
          </ButtonLink>
        )}
        {ex.action === 'profile' && (
          <ButtonLink to="/profile" data-testid="edit-profile">
            Edit tester profile
          </ButtonLink>
        )}
        <ButtonLink to="/discover" variant="secondary">
          Browse other tasks
        </ButtonLink>
      </div>
      <p className="mt-3 text-xs text-amber-900">You can read the task, but only eligible testers can reserve it. Your credits and daily limit are not affected.</p>
    </div>
  );
}
