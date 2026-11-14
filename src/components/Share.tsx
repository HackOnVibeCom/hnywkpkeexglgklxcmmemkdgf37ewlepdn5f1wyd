import { useState } from 'react';
import { REFERRAL_REWARD_CAP } from '../lib/limits';
import { referralLink } from '../lib/referral';
import type { MyCampaign, MyReferrals } from '../lib/types';
import { Button } from './ui';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* clipboard API blocked (insecure context / permissions): fall back below */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

const linkBtn =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50';

function ShareButtons({ text, link, copyLabel, copyWhat }: { text: string; link: string; copyLabel: string; copyWhat: 'link' | 'message' }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function onCopy() {
    const ok = await copyText(copyWhat === 'link' ? link : `${text} ${link}`);
    setState(ok ? 'ok' : 'fail');
    setTimeout(() => setState('idle'), 2500);
  }
  async function onShare() {
    try {
      await navigator.share({ text, url: link });
    } catch {
      /* the user dismissed the share sheet */
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" onClick={onCopy}>
        {copyLabel}
      </Button>
      {canShare && (
        <Button variant="secondary" onClick={onShare}>
          Share…
        </Button>
      )}
      <a
        className={linkBtn}
        target="_blank"
        rel="noopener noreferrer"
        href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`}
      >
        Post on X
      </a>
      <a
        className={linkBtn}
        target="_blank"
        rel="noopener noreferrer"
        href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(link)}`}
      >
        LinkedIn
      </a>
      <span role="status" aria-live="polite" className="text-sm text-emerald-700">
        {state === 'ok' && 'Copied!'}
        {state === 'fail' && <span className="text-red-700">Could not copy — select the text and copy it manually.</span>}
      </span>
    </div>
  );
}

const SHARE_TEXT = {
  requested:
    'I just asked real founders to test my product on PeerProbe — a free swap of 3-minute usability tests, no signup. Heads-up: if you join with my link and finish a test, I earn a free test credit.',
  earned:
    'I just earned a free usability-test credit by testing another founder’s product on PeerProbe. Swap tests with other founders — no signup:',
  general:
    'I’m swapping usability tests with other founders on PeerProbe: test someone’s product, get yours tested by real people. No signup:',
} as const;

/** "Invite a founder" prompt. States the incentive plainly (what the sharer gets) so it is never a hidden bribe. */
export function ShareCard({ code, variant }: { code: string | undefined; variant: keyof typeof SHARE_TEXT }) {
  const link = referralLink(code);
  return (
    <section aria-labelledby="share-h" className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
      <h2 id="share-h" className="font-semibold text-indigo-950">
        Know a founder who’d like a free usability test?
      </h2>
      <p className="mt-1 text-sm text-indigo-900">
        {code ? (
          <>
            When a friend joins through your link and <strong>finishes their first test</strong>, you earn{' '}
            <strong>+1 Test Credit</strong> (up to {REFERRAL_REWARD_CAP} friends). They start with a free credit too.
          </>
        ) : (
          <>Invite another founder — more testers means faster feedback for everyone.</>
        )}
      </p>
      <label className="mt-3 block">
        <span className="sr-only">Your invite link</span>
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
        />
      </label>
      <div className="mt-3">
        <ShareButtons text={SHARE_TEXT[variant]} link={link} copyLabel="Copy invite link" copyWhat="link" />
      </div>
    </section>
  );
}

export interface ProofStats {
  tests: number;
  completed: number;
  avgRating: number;
  /** A tester-consented quote, if any. Private feedback never appears here. */
  quote: string | null;
}

/** Pure: derives the results card from the founder's OWN, already-readable dashboard data. */
export function proofStats(campaigns: MyCampaign[]): ProofStats | null {
  const subs = campaigns.flatMap((c) => c.submissions);
  if (subs.length === 0) return null;
  const completed = subs.filter((s) => s.task_completed).length;
  const avg = subs.reduce((a, s) => a + s.ux_rating, 0) / subs.length;
  const consented = subs.find((s) => s.share_consent);
  let quote: string | null = null;
  if (consented) {
    const t = consented.friction.trim().replace(/\s+/g, ' ');
    quote = t.length > 140 ? `${t.slice(0, 137)}…` : t;
  }
  return { tests: subs.length, completed, avgRating: Math.round(avg * 10) / 10, quote };
}

export function proofText(s: ProofStats, includeQuote: boolean): string {
  const n = s.tests === 1 ? '1 tester' : `${s.tests} testers`;
  const base = `${n} just tested my product on PeerProbe: ${s.completed}/${s.tests} completed the task, average UX rating ${s.avgRating}/5.`;
  const q = includeQuote && s.quote ? ` One tester said: “${s.quote}”` : '';
  return `${base}${q} Swap usability tests with other founders, no signup:`;
}

/** "Share my results": real numbers only, computed locally; nothing is published to PeerProbe or anyone else. */
export function ProofCard({ campaigns, code }: { campaigns: MyCampaign[]; code: string | undefined }) {
  const stats = proofStats(campaigns);
  const [withQuote, setWithQuote] = useState(true);
  if (!stats) return null;
  const link = referralLink(code);
  const text = proofText(stats, withQuote);
  return (
    <section aria-labelledby="proof-h" className="mt-12">
      <h2 id="proof-h" className="text-xl font-bold tracking-tight text-slate-900">
        Share your results
      </h2>
      <div className="mt-4 rounded-xl bg-slate-900 p-6 text-white" data-testid="proof-card">
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-300">Tested by other founders on PeerProbe</p>
        <p className="mt-2 text-3xl font-bold">
          {stats.tests} {stats.tests === 1 ? 'real test' : 'real tests'}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-slate-400">Completed the task</dt>
            <dd className="text-lg font-semibold">
              {stats.completed} of {stats.tests}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Average UX rating</dt>
            <dd className="text-lg font-semibold">{stats.avgRating} / 5</dd>
          </div>
        </dl>
        {withQuote && stats.quote && <p className="mt-4 border-l-2 border-indigo-400 pl-3 text-sm italic text-slate-200">“{stats.quote}”</p>}
      </div>
      {stats.quote && (
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="accent-indigo-600" checked={withQuote} onChange={(e) => setWithQuote(e.target.checked)} />
          Include a quote (only feedback whose tester allowed public quoting is ever offered)
        </label>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Built in your browser from your own results. Private feedback and tester identities are never included, and nothing
        is published until you post it yourself.
      </p>
      <div className="mt-3">
        <ShareButtons text={text} link={link} copyLabel="Copy message" copyWhat="message" />
      </div>
    </section>
  );
}

/** Honest referral numbers (real counts from the server; zeros are shown as zeros). */
export function ReferralStats({ data }: { data: MyReferrals | null }) {
  if (!data) return null;
  return (
    <p className="mt-3 text-sm text-indigo-900" data-testid="referral-stats">
      Invited: <strong>{data.invited}</strong> · finished a first test: <strong>{data.converted}</strong> · credits earned:{' '}
      <strong>
        {data.rewarded} of {data.cap}
      </strong>
    </p>
  );
}
