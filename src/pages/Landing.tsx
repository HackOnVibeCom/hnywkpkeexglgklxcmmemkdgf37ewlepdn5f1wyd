import { useState } from 'react';
import { ButtonLink } from '../components/ui';
import { hasPendingReferral } from '../lib/referral';

const STEPS = [
  {
    n: '1',
    title: 'Test a founder’s product',
    body: 'Pick a task, open their website, and try the 2–3 minute job they describe. Answer four short questions honestly.',
  },
  {
    n: '2',
    title: 'Earn 1 Test Credit',
    body: 'Every valid, unique completed test earns exactly one credit. You also start with one free credit — no signup.',
  },
  {
    n: '3',
    title: 'Spend it to get yours tested',
    body: 'Post your URL and a specific task. A real person uses your product and tells you where they got stuck.',
  },
];

const FEEDBACK_FIELDS = [
  'Did they complete the task? (yes / no)',
  'Where they were confused or hit friction',
  'One concrete improvement they would make',
  'A 1–5 UX rating',
];

export function Landing() {
  const [invited] = useState(() => hasPendingReferral());
  return (
    <div className="space-y-20">
      <section className="max-w-4xl">
        <p className="mb-4 inline-block rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-indigo-700">
          Give feedback. Get feedback.
        </p>
        <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
          Get real people to use your product.
          <br />
          <span className="text-indigo-600">Earn it by testing theirs.</span>
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
          UXBarter is a credit-based, peer-to-peer usability-testing exchange for founders and developers. Spend three
          minutes testing someone else’s website, earn a Test Credit, and redeem it for a human test of your own product
          — with structured, honest feedback.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink to="/create" size="lg">
            Get my product tested
          </ButtonLink>
          <ButtonLink to="/discover" variant="secondary" size="lg">
            Earn a credit by testing
          </ButtonLink>
        </div>
        <p className="mt-4 text-sm text-slate-500">No signup, email or password. You start with 1 free credit.</p>
        {invited && (
          <p className="mt-3 max-w-xl rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900" data-testid="invited-note">
            A founder invited you. After you finish your first test they earn a free test credit too — that is the only thing
            the invitation does.
          </p>
        )}
      </section>

      <section aria-labelledby="how">
        <h2 id="how" className="text-2xl font-bold tracking-tight text-slate-900">
          How it works
        </h2>
        <ol className="mt-6 grid gap-6 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-xl border border-slate-200 bg-white p-5">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-indigo-600 text-sm font-bold text-white">
                {s.n}
              </span>
              <h3 className="mt-4 font-semibold text-slate-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-xl border border-indigo-200 bg-indigo-50 p-6" aria-labelledby="matching" data-testid="matching-section">
        <h2 id="matching" className="text-xl font-bold tracking-tight text-indigo-950">
          Targeted Tester Matching
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-indigo-900">
          Founders can say who they would most like feedback from, and testers can say what kind of tester they are:
          Tech-Savvy Users, Founders &amp; Product Builders, Business &amp; Office Users, Students &amp; Learners, or Everyday
          &amp; Non-Technical Users. Tasks that fit you are marked <strong>Recommended for you</strong> and shown first.
          It is a simple, explainable rule — overlapping categories rank higher — not an AI model, and the optional profile never
          needs an email or password. Founders choose how a request is shared: <strong>open testing</strong> (any tester can take it;
          categories only recommend it) or <strong>targeted testing</strong> (only testers who match a required category can start it,
          enforced by the server; Tech-Savvy, Founders &amp; Product Builders and Business &amp; Office testers first complete a short
          self-reported screening, which is not a verified credential).
        </p>
      </section>

      <section className="grid gap-10 sm:grid-cols-2" aria-labelledby="gets">
        <div>
          <h2 id="gets" className="text-2xl font-bold tracking-tight text-slate-900">
            What you get back
          </h2>
          <p className="mt-3 text-slate-600">
            Every response follows the same structure, so feedback is comparable and actionable instead of vague.
          </p>
          <ul className="mt-5 space-y-3">
            {FEEDBACK_FIELDS.map((f) => (
              <li key={f} className="flex gap-3 text-slate-700">
                <span aria-hidden className="mt-1 text-indigo-600">✓</span>
                {f}
              </li>
            ))}
          </ul>
        </div>
        <section className="rounded-xl border border-slate-200 bg-white p-6" aria-labelledby="honest">
          <h2 id="honest" className="text-lg font-bold text-slate-900">
            Honest by design
          </h2>
          <ul className="mt-3 space-y-3 text-sm leading-relaxed text-slate-600">
            <li>
              <strong className="text-slate-800">Anonymous.</strong> Your identity and credits live in this browser.
              Clearing site data starts a fresh identity.
            </li>
            <li>
              <strong className="text-slate-800">Private by default.</strong> Feedback is visible only to the founder who
              requested it, unless the tester opts in to sharing.
            </li>
            <li>
              <strong className="text-slate-800">Not abuse-proof.</strong> Anonymous identities cannot fully stop one
              person from creating several. We block self-testing and repeat rewards, hold each task for one tester at a time, require at least a minute of testing and cap rewards at 5 tests per 24 hours per identity — but that is as far as anonymous identities go.
            </li>
            <li>
              <strong className="text-slate-800">No fake data.</strong> Everything you see comes from real people using
              the product. If there’s nothing yet, we say so.
            </li>
          </ul>
        </section>
      </section>

      <section className="rounded-2xl bg-slate-900 px-6 py-10 text-center sm:px-10">
        <h2 className="text-2xl font-bold text-white">Ready for your first test?</h2>
        <p className="mx-auto mt-2 max-w-md text-slate-300">Your free starter credit is waiting. It takes under a minute to post a task.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <ButtonLink to="/create" size="lg">
            Request a test
          </ButtonLink>
          <ButtonLink to="/discover" variant="secondary" size="lg">
            Browse tasks
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
