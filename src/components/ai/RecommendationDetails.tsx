import type { AiRecommendation } from '../../lib/aiContract';

/**
 * Extra detail the AI service attaches to a recommendation, rendered INSIDE Discover's "Recommended for you" cards: the verdict,
 * the tester's own words it relied on (verified verbatim server-side), and what the profile does not clearly show.
 * Everything is plain text (React escapes it); nothing here can start a test or change eligibility.
 */
export function RecommendationDetails({ rec }: { rec: AiRecommendation }) {
  const evidence = rec.evidence ?? [];
  const unsupported = rec.unsupported_requirements ?? [];
  if (!rec.verdict && evidence.length === 0 && unsupported.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5" data-testid="ai-rec-details">
      <p className="flex flex-wrap items-center gap-1.5 text-xs">
        {rec.verdict && (
          <span data-testid="ai-badge" className="inline-flex rounded-full bg-indigo-600 px-2.5 py-0.5 font-semibold text-white">
            {rec.verdict === 'strong' ? 'Strong match' : 'Good match'}
          </span>
        )}
        <span className="text-slate-500">AI-suggested from your self-reported profile. Not verified.</span>
      </p>
      {evidence.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-600" data-testid="ai-evidence">
          {evidence.map((e, i) => (
            <li key={`${i}-${e.quote}`}>
              From your profile: <q>{e.quote}</q>
            </li>
          ))}
        </ul>
      )}
      {unsupported.length > 0 && (
        <p className="text-xs text-amber-900" data-testid="ai-unsupported">
          Not clearly covered by your profile: {unsupported.join(', ')}
        </p>
      )}
    </div>
  );
}
