import { useId, type ReactNode } from 'react';
import { CATEGORIES, normalizeCategories, type ExperienceBadge } from '../lib/matching';

interface Props {
  legend: string;
  hint?: ReactNode;
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Prefix for data-testid on each option (…-tech_savvy). */
  testIdPrefix?: string;
  /** Optional status per category id (Active / Pending …), shown under the description. */
  badges?: Record<string, ExperienceBadge | null | undefined>;
}

/** Multi-select of the five tester categories: native checkboxes in a fieldset (keyboard + screen-reader friendly). */
export function CategoryPicker({ legend, hint, value, onChange, disabled, testIdPrefix = 'cat', badges }: Props) {
  const hintId = useId();
  const selected = new Set(value);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(normalizeCategories([...next]));
  };
  return (
    <fieldset disabled={disabled} aria-describedby={hint ? hintId : undefined}>
      <legend className="text-sm font-semibold text-slate-800">{legend}</legend>
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {CATEGORIES.map((c) => {
          const on = selected.has(c.id);
          return (
            <label
              key={c.id}
              data-testid={`${testIdPrefix}-${c.id}`}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${
                on ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-white hover:bg-slate-50'
              } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                checked={on}
                onChange={() => toggle(c.id)}
              />
              <span className="min-w-0">
                <span className="block font-semibold text-slate-900">{c.label}</span>
                <span className="mt-0.5 block text-xs text-slate-600">{c.blurb}</span>
                {badges?.[c.id] && (
                  <span
                    data-testid={`${testIdPrefix}-badge-${c.id}`}
                    data-kind={badges[c.id]!.kind}
                    className={`mt-1.5 inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${
                      badges[c.id]!.kind === 'active' ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : badges[c.id]!.kind === 'pending' ? 'border-amber-300 bg-amber-50 text-amber-900' : badges[c.id]!.kind === 'warn' ? 'border-red-200 bg-red-50 text-red-900' : 'border-slate-300 bg-slate-50 text-slate-800'
                    }`}
                  >
                    {badges[c.id]!.text}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Small read-only pill list of categories (labels only). */
export function CategoryBadges({ ids, highlight = [], className = '' }: { ids: readonly string[]; highlight?: readonly string[]; className?: string }) {
  if (ids.length === 0) return null;
  const hl = new Set(highlight);
  return (
    <ul className={`flex flex-wrap gap-1.5 ${className}`}>
      {ids.map((id) => {
        const c = CATEGORIES.find((x) => x.id === id);
        return (
          <li
            key={id}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              hl.has(id) ? 'border-indigo-300 bg-indigo-100 text-indigo-900' : 'border-slate-200 bg-slate-50 text-slate-700'
            }`}
          >
            {c?.label ?? id}
          </li>
        );
      })}
    </ul>
  );
}
