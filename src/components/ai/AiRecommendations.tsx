import { useEffect, useState } from 'react';
import { fetchAiRecommendations, setAiConsentGranted } from '../../lib/ai/aiApi';
import { AI_ENABLED } from '../../lib/ai/flag';
import type { AiRecommendResult } from '../../lib/ai/types';
import { friendlyError } from '../../lib/api';
import type { MatchedCampaign } from '../../lib/types';
import { Alert, Button, ButtonLink } from '../ui';

type Phase = { kind: 'loading' } | { kind: 'optin' } | { kind: 'result'; result: AiRecommendResult };

export const AI_PRIVACY_POINTS = [
  'Your tester bio, your chosen categories and the experience answers you wrote are sent to OpenAI, our AI provider, to find tests that fit your experience.',
  'We do not send your account ID, nickname or sign-in token. OpenAI’s API policy says API inputs are not used to train its models by default; OpenAI may keep requests for up to 30 days for abuse monitoring.',
  'Please do not write sensitive personal information (health, finances, ID numbers, other people’s details) in your profile or answers.',
  'Everything is self-reported. Neither UXBarter nor the AI verifies your school, employer or experience.',
  'The AI only suggests tests. The server still decides what you may start: Targeted tests keep their eligibility and qualification rules.',
  'You can turn this off at any time. That deletes the analysis and recommendations we stored about you.',
];

/**
 * AI-personalised block at the top of Discover. Entirely additive: if AI is off, not configured, rate-limited or the
 * provider is down, the full eligible list below it works exactly as before.
 */
export function AiRecommendations(props: { campaigns: MatchedCampaign[]; atCap: boolean }) {
  // Feature flag: with VITE_AI_MATCHING unset nothing renders and nothing is requested.
  return AI_ENABLED ? <AiBlock {...props} /> : null;
}

/** Heading for the unchanged full list. Only shown when the AI block is (so the page is identical with AI off). */
export function BrowseAllHeading({ note }: { note: boolean }) {
  if (!AI_ENABLED) return null;
  return (
    <>
      <h2 className="mb-1 text-lg font-semibold text-slate-900" data-testid="browse-all">
        Browse all eligible tests
      </h2>
      {note && <p className="mb-4 text-xs text-slate-500">Tests you cannot start yet are marked and listed last.</p>}
    </>
  );
}

function AiBlock({ campaigns, atCap }: { campaigns: MatchedCampaign[]; atCap: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'loading' });
    (async () => {
      // The function itself reads consent: nothing is analysed (and nothing leaves our servers) until it is granted.
      const result = await fetchAiRecommendations();
      if (!cancelled) setPhase(result.status === 'consent_required' ? { kind: 'optin' } : { kind: 'result', result });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  async function toggle(granted: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setAiConsentGranted(granted);
      setNonce((n) => n + 1);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ai-recs-title" data-testid="ai-recs" className="mb-8 rounded-xl border border-indigo-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="ai-recs-title" className="text-lg font-semibold text-slate-900">
            Recommended for your experience
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">AI-suggested from your self-reported profile. Not verified. Optional.</p>
        </div>
        {phase.kind === 'result' && (
          <div className="flex flex-wrap gap-2">
            <ButtonLink to="/profile" variant="secondary">
              Edit my profile
            </ButtonLink>
            <Button variant="ghost" onClick={() => toggle(false)} disabled={busy} data-testid="ai-off">
              Turn off AI analysis
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {phase.kind === 'loading' && (
        <p role="status" className="mt-4 text-sm text-slate-600" data-testid="ai-loading">
          Finding tests that fit your experience…
        </p>
      )}

      {phase.kind === 'optin' && (
        <div className="mt-3" data-testid="ai-optin">
          <p className="text-sm text-slate-700">
            Want tests picked for what you have actually done, not just a category? Turn on AI matching. It reads the profile and experience answers you
            already wrote.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600">
            {AI_PRIVACY_POINTS.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => toggle(true)} disabled={busy} data-testid="ai-on">
              I agree — turn on AI matching
            </Button>
            <ButtonLink to="/profile" variant="secondary">
              Review my profile first
            </ButtonLink>
          </div>
          <p className="mt-3 text-xs text-slate-500">No thanks? Everything below works without it.</p>
        </div>
      )}

      {phase.kind === 'result' && <Results result={phase.result} campaigns={campaigns} atCap={atCap} />}
    </section>
  );
}

function Results({ result, campaigns, atCap }: { result: AiRecommendResult; campaigns: MatchedCampaign[]; atCap: boolean }) {
  // Defence in depth: the server already filtered by eligibility; the UI only shows rows the Discover feed marks eligible.
  const items = result.recommendations
    .map((r) => ({ r, c: campaigns.find((x) => x.campaign_id === r.campaign_id) }))
    .filter((x): x is { r: (typeof result.recommendations)[number]; c: MatchedCampaign } => !!x.c && x.c.eligible && x.c.fit !== 'not_eligible');

  if (result.status === 'insufficient_profile') {
    return (
      <div className="mt-3" data-testid="ai-insufficient">
        <p className="text-sm text-slate-700">Add a few lines about what you have actually done or used, and we can match you to relevant tests.</p>
        <ButtonLink to="/profile" className="mt-3">
          Add my experience
        </ButtonLink>
      </div>
    );
  }
  if (result.status === 'rate_limited' || result.status === 'busy' || result.status === 'budget_reached' || result.status === 'unavailable') {
    const text =
      result.status === 'busy'
        ? 'Still working on your previous request. Give it a few seconds, then refresh.'
        : result.status === 'rate_limited'
          ? 'You have used today’s AI matching allowance. Showing what we already know; try again tomorrow.'
          : 'AI recommendations are not available right now.';
    return (
      <div className="mt-3 space-y-3" data-testid="ai-unavailable">
        <Alert tone="info">{text} You can still browse every test you are eligible for below.</Alert>
        {items.length > 0 && <List items={items} atCap={atCap} />}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="mt-3" data-testid="ai-empty">
        <p className="font-medium text-slate-900">No highly relevant tests found yet.</p>
        <p className="mt-1 text-sm text-slate-600">
          We only recommend a test when your own words show clear relevance, so this list can be empty. New tests appear all the time, and more
          detail about your experience helps. You can always browse all eligible tests below to earn credits.
        </p>
        <ButtonLink to="/profile" variant="secondary" className="mt-3">
          Add more about my experience
        </ButtonLink>
      </div>
    );
  }
  return (
    <div className="mt-4">
      {result.understanding && result.understanding.areas.length > 0 && (
        <p className="mb-3 text-xs text-slate-600" data-testid="ai-understanding">
          What we picked up from your profile: {result.understanding.areas.join(' · ')}
        </p>
      )}
      <List items={items} atCap={atCap} />
    </div>
  );
}

function List({ items, atCap }: { items: Array<{ r: AiRecommendResult['recommendations'][number]; c: MatchedCampaign }>; atCap: boolean }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" data-testid="ai-list">
      {items.map(({ r, c }) => (
        <li key={c.campaign_id} data-verdict={r.verdict} className="flex flex-col rounded-lg border border-indigo-200 bg-indigo-50/40 p-4">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2.5 py-0.5 text-xs font-semibold text-white" data-testid="ai-badge">
              {r.verdict === 'strong' ? 'Strong match' : 'Good match'}
            </span>
            <span className="inline-flex rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-xs text-slate-600">
              {c.testing_mode === 'targeted' ? 'Targeted · you are eligible' : 'Open testing'}
            </span>
          </p>
          <h3 className="mt-2 break-words font-semibold text-slate-900">{c.project_name}</h3>
          <p className="mt-1 text-sm text-slate-800" data-testid="ai-explanation">
            {r.explanation}
          </p>
          {r.evidence.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-slate-600" data-testid="ai-evidence">
              {r.evidence.map((e, i) => (
                <li key={`${i}-${e.quote}`}>
                  From your profile: <q>{e.quote}</q>
                </li>
              ))}
            </ul>
          )}
          {r.unsupported_requirements.length > 0 && (
            <p className="mt-2 text-xs text-amber-900" data-testid="ai-unsupported">
              Not clearly covered by your profile: {r.unsupported_requirements.join(', ')}
            </p>
          )}
          <div className="mt-4 flex-1" />
          {atCap && !c.reserved_by_me ? (
            <Button disabled>Limit reached</Button>
          ) : (
            <ButtonLink to={`/test/${c.campaign_id}`}>Start test</ButtonLink>
          )}
        </li>
      ))}
    </ul>
  );
}
