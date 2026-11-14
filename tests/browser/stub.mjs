// A small STATEFUL fake of the Supabase API surface the app uses. It mirrors the server rules that
// matter to the UI (reservations, minimum testing time, expiry, error codes) with configurable,
// short timings so tests run in seconds. It is NOT the database: SQL behaviour is tested in
// supabase/tests (PGlite) and against a real project.
export const HOST = 'https://testproj.supabase.co';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
  'access-control-expose-headers': '*',
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', role: 'authenticated', is_anonymous: true, exp: 4102444800 })}.sig`;
export const iso = (ms) => new Date(ms).toISOString();
export const DAY = 864e5;

export const CAMP_ID = '22222222-2222-2222-2222-222222222222';
export const SITE = 'https://acme-invoices.example.com';

export function feedRow(o = {}) {
  return {
    campaign_id: CAMP_ID,
    project_name: 'Acme Invoicing',
    description: 'Invoices for freelancers',
    task_description: 'Create an invoice for a client and download it as a PDF.',
    created_at: iso(Date.now() - 5 * 60e3),
    expires_at: iso(Date.now() + 6 * DAY + 3600e3),
    reserved_by_me: false,
    reservation_expires_at: null,
    ...o,
  };
}

export function dashCampaign(o = {}) {
  return {
    id: 'c-' + Math.random().toString(36).slice(2, 8),
    task_description: 'Sign up and export your data as CSV.',
    status: 'open',
    max_responses: 1,
    response_count: 0,
    created_at: iso(Date.now() - 3e5),
    expires_at: iso(Date.now() + 7 * DAY - 3e5),
    completed_at: null,
    closed_at: null,
    project: { name: 'Other app', url: 'https://other.example.com', description: null },
    ...o,
  };
}

export function createBackend(opts = {}) {
  const s = {
    balance: opts.balance ?? 1,
    calls: [],
    signups: 0,
    holdMs: opts.holdMs ?? 15 * 60e3,
    minMs: opts.minMs ?? 60e3,
    skewMs: opts.skewMs ?? 0,
    feed: opts.feed ?? [feedRow()],
    /** per-campaign test-page data; available=false => get_campaign_for_test returns [] */
    pages: opts.pages ?? { [CAMP_ID]: { available: true, reservedByOther: false } },
    reservation: null, // { campaign_id, firstAt, startedAt, expiresAt }
    submitted: new Set(),
    status: opts.status ?? { rewards_24h: 0, daily_limit: 5, next_reward_slot_at: null, active_reservation: null },
    settled: 0,
    /** rpc name -> { message, details, sticky } ; one-shot unless sticky */
    forced: {},
    dashCampaigns: opts.dashCampaigns ?? [],
    dashReservations: opts.dashReservations ?? [],
    ledger: opts.ledger ?? [{ id: 1, delta: 1, reason: 'starter', campaign_id: null, created_at: iso(Date.now() - 72e5) }],
    submissions: opts.submissions ?? [],
    refCode: opts.refCode ?? 'abcdef123456',
    referrals: opts.referrals ?? { code: opts.refCode ?? 'abcdef123456', cap: 3, invited: 0, converted: 0, rewarded: 0 },
    claimResult: opts.claimResult ?? { claimed: true },
  };
  const now = () => Date.now() + s.skewMs;
  const called = (name) => s.calls.filter((c) => c.p.endsWith('/rpc/' + name));

  function liveRes(id) {
    const r = s.reservation;
    return r && r.campaign_id === id && r.expiresAt > now() ? r : null;
  }

  async function install(ctx) {
    await ctx.route(HOST + '/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const p = url.pathname;
      const m = req.method();
      const send = (body, status = 200, headers = {}) =>
        route.fulfill({ status, contentType: 'application/json', headers: { ...CORS, ...headers }, body: JSON.stringify(body) });
      const fail = (message, details = null) => send({ code: 'P0001', details, hint: null, message }, 400);
      if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      let body = null;
      try {
        body = req.postDataJSON();
      } catch {
        /* no body */
      }
      s.calls.push({ m, p, q: url.search, body, at: Date.now() });

      const rpcName = p.startsWith('/rest/v1/rpc/') ? p.slice('/rest/v1/rpc/'.length) : null;
      if (rpcName && s.forced[rpcName]) {
        const f = s.forced[rpcName];
        if (!f.sticky) delete s.forced[rpcName];
        return fail(f.message, f.details ?? null);
      }

      if (p === '/auth/v1/signup') {
        s.signups++;
        return send({
          access_token: JWT,
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: 4102444800,
          refresh_token: 'r',
          user: { id: 'u1', aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: iso(Date.now()) },
        });
      }
      if (rpcName === 'ensure_profile') {
        return send({ id: 'u1', credit_balance: s.balance, created_at: iso(Date.now()), ref_code: s.refCode });
      }
      if (p === '/rest/v1/profiles') return send({ id: 'u1', credit_balance: s.balance, created_at: iso(Date.now()) });
      if (rpcName === 'claim_referral') return send(s.claimResult);
      if (rpcName === 'get_my_referrals') return send(s.referrals);
      if (rpcName === 'settle_referral_rewards') return send(0);
      if (rpcName === 'list_open_campaigns') return send(s.feed);
      if (rpcName === 'get_my_status') return send({ ...s.status, server_now: iso(now()) });
      if (rpcName === 'settle_expired_campaigns') {
        const n = s.settled;
        s.settled = 0;
        return send(n);
      }

      if (rpcName === 'get_campaign_for_test') {
        const id = body?.p_campaign_id;
        const pg = s.pages[id];
        if (!pg || !pg.available || s.submitted.has(id)) return send([]);
        const r = liveRes(id);
        return send([
          {
            campaign_id: id,
            project_name: 'Acme Invoicing',
            project_url: r ? SITE : null,
            description: 'Invoices for freelancers',
            task_description: 'Create an invoice for a client and download it as a PDF.',
            created_at: iso(Date.now() - 5 * 60e3),
            expires_at: iso(Date.now() + 6 * DAY),
            reserved_by_me: !!r,
            reserved_by_other: !!pg.reservedByOther && !r,
            reservation_expires_at: r ? iso(r.expiresAt) : null,
            min_submit_at: r ? iso(r.firstAt + s.minMs) : null,
            server_now: iso(now()),
          },
        ]);
      }
      if (rpcName === 'start_test') {
        const id = body?.p_campaign_id;
        const pg = s.pages[id];
        if (pg?.reservedByOther) return fail('campaign_reserved');
        let r = liveRes(id);
        if (!r) {
          const prev = s.reservation && s.reservation.campaign_id === id ? s.reservation : null;
          r = s.reservation = { campaign_id: id, firstAt: prev ? prev.firstAt : now(), startedAt: now(), expiresAt: now() + s.holdMs };
        }
        return send({ campaign_id: id, reservation_expires_at: iso(r.expiresAt), min_submit_at: iso(r.firstAt + s.minMs), server_now: iso(now()) });
      }
      if (rpcName === 'submit_test') {
        const id = body?.p_campaign_id;
        const r = s.reservation && s.reservation.campaign_id === id ? s.reservation : null;
        if (!r) return fail('reservation_required');
        if (r.expiresAt <= now()) return fail('reservation_expired');
        if (now() < r.firstAt + s.minMs) return fail('too_fast', String(Math.ceil((r.firstAt + s.minMs - now()) / 1000)));
        s.submitted.add(id);
        s.balance += 1;
        s.reservation = null;
        return send({ submission_id: 's1', credits_awarded: 1, balance: s.balance });
      }
      if (rpcName === 'create_project_with_campaign') {
        s.balance -= 1;
        return send('33333333-3333-3333-3333-333333333333');
      }
      if (rpcName === 'cancel_campaign') {
        const id = body?.p_campaign_id;
        const c = s.dashCampaigns.find((x) => x.id === id);
        if (!c) return fail('campaign_not_found');
        s.balance += 1;
        c.status = 'cancelled';
        c.closed_at = iso(Date.now());
        s.ledger.unshift({ id: 99, delta: 1, reason: 'campaign_refund', campaign_id: id, created_at: iso(Date.now()) });
        return send({ status: 'cancelled', refunded: true, balance: s.balance });
      }

      if (p === '/rest/v1/credit_ledger') {
        if (m === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': '0-0/2' } });
        return send(s.ledger);
      }
      if (p === '/rest/v1/campaigns') return send(s.dashCampaigns);
      if (p === '/rest/v1/test_reservations') return send(s.dashReservations);
      if (p === '/rest/v1/test_submissions') return send(s.submissions);
      return send({ message: 'unstubbed ' + p }, 404);
    });
  }

  return { s, install, called, now };
}
