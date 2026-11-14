import { useId, type ReactNode } from 'react';

const inputBase =
  'block w-full rounded-lg border bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:border-indigo-500';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Shows "n / max" under the field. */
  counter?: { value: string; max: number };
  children: (ids: { id: string; describedBy: string; invalid: boolean; className: string }) => ReactNode;
}

/** Label + control + hint/error wiring (aria-describedby / aria-invalid) in one place. */
export function Field({ label, hint, error, counter, children }: FieldProps) {
  const id = useId();
  const describedBy = `${id}-desc`;
  const invalid = Boolean(error);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-slate-800">
        {label}
      </label>
      <div className="mt-1.5">
        {children({
          id,
          describedBy,
          invalid,
          className: `${inputBase} ${invalid ? 'border-red-400' : 'border-slate-300'}`,
        })}
      </div>
      <div id={describedBy} className="mt-1.5 flex justify-between gap-3 text-xs">
        <span className={invalid ? 'text-red-700' : 'text-slate-500'}>{error ?? hint}</span>
        {counter && (
          <span className={counter.value.trim().length > counter.max ? 'text-red-700' : 'text-slate-400'}>
            {counter.value.trim().length}/{counter.max}
          </span>
        )}
      </div>
    </div>
  );
}
