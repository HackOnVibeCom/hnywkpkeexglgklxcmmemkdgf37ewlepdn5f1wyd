import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV = [
  { to: '/discover', label: 'Discover' },
  { to: '/create', label: 'Request a test' },
  { to: '/dashboard', label: 'Dashboard' },
];

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 font-bold text-slate-900" aria-label="UXBarter home">
      <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-white">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="m8 4-4 4 4 4" />
          <path d="M4 8h16" />
          <path d="m16 20 4-4-4-4" />
          <path d="M20 16H4" />
        </svg>
      </span>
      <span className="text-lg tracking-tight">UXBarter</span>
    </Link>
  );
}

function CreditChip() {
  const { status, profile } = useAuth();
  if (status !== 'ready' || !profile) return null;
  return (
    <Link
      to="/dashboard"
      className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-sm font-semibold text-indigo-800 hover:bg-indigo-100"
      title="Your Test Credits"
    >
      <span aria-hidden>●</span>
      {profile.credit_balance} {profile.credit_balance === 1 ? 'credit' : 'credits'}
    </Link>
  );
}

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Logo />
          <div className="flex items-center gap-3 sm:order-last">
            <CreditChip />
          </div>
          <nav aria-label="Main" className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
                    isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 text-xs leading-relaxed text-slate-500 sm:px-6">
          <p className="mb-2 text-sm font-semibold text-slate-700">UXBarter — Give feedback. Get feedback.</p>
          <p>
            UXBarter has no accounts. Your anonymous identity — and your credits — are tied to this browser; clearing
            site data creates a new identity. Anonymous identity does not fully prevent one person from creating
            several identities. Feedback is private to the requesting founder unless the tester opts in to sharing.
          </p>
        </div>
      </footer>
    </div>
  );
}
