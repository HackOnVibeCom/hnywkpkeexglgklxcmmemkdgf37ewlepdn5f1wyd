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
    /** Targeted Tester Matching: false = the backend predates migration 6 (matching RPCs + column are missing). */
    matching: opts.matching ?? true,
    /** my optional tester profile ({ nickname, bio, categories, updated_at }) or null */
    tester: opts.tester ?? null,
    /** campaigns created through the UI: { rpc, body } */
    created: [],
    /** Matching v2 (Open vs Targeted testing + screening). false = the backend predates migration 7. */
    v2: opts.v2 ?? opts.matching ?? true,
    /** Active vs Pending categories (migration 8). false = the backend predates it: professional categories count as soon as they are in the profile. */
    v3: opts.v3 ?? opts.v2 ?? opts.matching ?? true,
    /**
     * Experience profile (migration 8). answered = categories whose four answers are saved (default: all of the tester's
     * categories, so older suites keep a "complete" profile); qualified = professional categories with a valid decision
     * ("screened" is the old name and still accepted); consent = AI processing allowed.
     */
    answered: new Set(opts.answered ?? opts.tester?.categories ?? []),
    qualified: new Set(opts.qualified ?? opts.screened ?? []),
    notQualified: new Set(opts.notQualified ?? []),
    consent: opts.consent ?? false,
    /** category -> saved answers {q1..q4} */
    answerText: { ...(opts.answerText ?? {}) },
    /** saves used in the last 24 h per category */
    saves: { ...(opts.saves ?? {}) },
    /** { cat, answers } for every accepted save */
    expSaves: [],
    consentCalls: [],
    deleteCalls: [],
  };
  const PRO = ['tech_savvy', 'founders_builders', 'business_office'];
  const ALLCATS = ['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical'];
  /** Mirrors the SQL rule (category_state / tester_eligibility). */
  const catState = (c) => {
    if (!(s.tester?.categories ?? []).includes(c)) return 'inactive';
    if (!s.answered.has(c)) return 'incomplete';
    if (!PRO.includes(c)) return 'active';
    if (s.qualified.has(c)) return 'active';
    if (s.notQualified.has(c)) return 'not_qualified';
    return 'pending_assessment';
  };
  const activeCats = () =>
    s.v3 ? ALLCATS.filter((c) => catState(c) === 'active') : (s.tester?.categories ?? []).filter((c) => !PRO.includes(c) || s.qualified.has(c));
  const ready = () => !s.v3 || (s.tester?.categories ?? []).some((c) => s.answered.has(c));
  function eligibilityOf(mode, required) {
    const cats = s.tester?.categories ?? [];
    if (s.v3 && !ready()) return { eligible: false, reason: 'profile_incomplete', missing: [], overlap: [] };
    const active = activeCats();
    const overlap = required.filter((x) => active.includes(x));
    if (mode !== 'targeted') return { eligible: true, reason: 'open', missing: [], overlap };
    if (!s.v3 && cats.length === 0) return { eligible: false, reason: 'no_profile', missing: [], overlap: [] };
    const raw = required.filter((x) => cats.includes(x));
    if (raw.length === 0) return { eligible: false, reason: 'category_mismatch', missing: [], overlap: [] };
    if (overlap.length > 0) return { eligible: true, reason: 'eligible', missing: [], overlap };
    // v2-only backend (no migration 8): the old rule
    return { eligible: false, reason: s.v3 ? 'qualification_required' : 'screening_required', missing: raw, overlap: s.v3 ? [] : raw };
  }
  const rowEligibility = (r) => eligibilityOf(r.testing_mode ?? 'open', r.target_categories ?? []);
  const QS = (cat) => ['q1', 'q2', 'q3', 'q4'].map((id, i) => ({
    id,
    prompt: 'Question ' + (i + 1) + ' for ' + cat + ': describe what you have done.',
    hint: i === 0 ? 'Any level is welcome.' : null,
  }));
  const catJson = (c) => {
    const state = catState(c);
    const q = s.qualified.has(c) && PRO.includes(c) && (state === 'active') ? { status: 'qualified', source: 'ai_assessment', decided_at: iso(Date.now() - 3600e3) } : null;
    return {
      category: c,
      requires_assessment: PRO.includes(c),
      selected: state !== 'inactive',
      state,
      reason: state === 'inactive' ? 'not_selected' : state === 'incomplete' ? (s.answerText[c] ? 'questions_changed' : 'answers_needed') : state === 'pending_assessment' ? (s.consent ? 'awaiting_assessment' : 'consent_required') : state === 'not_qualified' ? 'not_qualified' : 'active',
      question_version: 1,
      answers_version: s.answerText[c] ? 1 : null,
      answers_complete: s.answered.has(c),
      answers_updated_at: s.answerText[c] ? iso(Date.now() - 60e3) : null,
      qualification: q,
    };
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
      const MISSING = (fn) => send({ code: 'PGRST202', details: null, hint: null, message: `Could not find the function public.${fn} without parameters in the schema cache` }, 404);
      if (rpcName === 'list_matched_campaigns') {
        if (!s.matching) return MISSING('list_matched_campaigns');
        // Mirrors the SQL ordering: own reservation, then overlap with MY categories (more first), then oldest, then id.
        const cats = activeCats();
        const rows = s.feed.map((r) => {
          const target = r.target_categories ?? [];
          const match = target.filter((x) => cats.includes(x));
          return { ...r, target_categories: target, match_categories: match, is_recommended: match.length > 0 };
        });
        rows.sort((a, b) => Number(b.reserved_by_me) - Number(a.reserved_by_me) || Number(b.is_recommended) - Number(a.is_recommended) || b.match_categories.length - a.match_categories.length || Date.parse(a.created_at) - Date.parse(b.created_at) || (a.campaign_id < b.campaign_id ? -1 : 1));
        return send(rows);
      }
      // ---------------- Matching v2 ----------------
      const V2 = ['list_campaigns_v2', 'get_campaign_eligibility', 'create_campaign_v2'];
      if (rpcName && V2.includes(rpcName) && !s.v2) return MISSING(rpcName);
      if (rpcName === 'list_campaigns_v2') {
        const rows = s.feed.map((r) => {
          const e = rowEligibility(r);
          const live = !!r.reserved_by_me;
          const ok2 = e.eligible || live;
          return {
            ...r,
            testing_mode: r.testing_mode ?? 'open',
            target_categories: r.target_categories ?? [],
            match_categories: e.overlap,
            fit: !ok2 ? 'not_eligible' : e.overlap.length > 0 ? 'recommended' : 'eligible',
            eligible: ok2,
            ineligible_reason: ok2 ? null : e.reason,
            missing_screening: ok2 ? [] : e.missing,
          };
        });
        const rank = (r) => (r.fit === 'not_eligible' ? 2 : r.fit === 'recommended' ? 0 : 1);
        rows.sort((a, b) => Number(b.reserved_by_me) - Number(a.reserved_by_me) || rank(a) - rank(b) || b.match_categories.length - a.match_categories.length || Date.parse(a.created_at) - Date.parse(b.created_at) || (a.campaign_id < b.campaign_id ? -1 : 1));
        return send(rows);
      }
      if (rpcName === 'get_campaign_eligibility') {
        const id = body?.p_campaign_id;
        const row = s.feed.find((r) => r.campaign_id === id);
        const mode = row?.testing_mode ?? s.pages[id]?.mode ?? 'open';
        const required = row?.target_categories ?? s.pages[id]?.required ?? [];
        const e = eligibilityOf(mode, required);
        const hold = liveRes(id);
        return send({
          campaign_id: id, testing_mode: mode, required_categories: required,
          eligible: !!hold || e.eligible, reason: hold ? 'in_progress' : e.reason,
          missing_screening: hold ? [] : e.missing, overlap: e.overlap, own_campaign: false,
        });
      }
      if (rpcName === 'get_screening' || rpcName === 'submit_screening') {
        return s.v3 ? fail('screening_replaced') : MISSING(rpcName);
      }
      const V3 = ['get_my_experience', 'get_experience_questions', 'save_experience_answers', 'set_ai_consent', 'delete_my_experience'];
      if (rpcName && V3.includes(rpcName) && !s.v3) return MISSING(rpcName);
      if (rpcName === 'get_my_experience') {
        return send({
          has_profile: !!s.tester,
          participation_ready: ready(),
          ai_consent: { granted: s.consent, policy_version: 1, updated_at: s.consentCalls.length ? iso(Date.now()) : null },
          categories: ALLCATS.map(catJson),
          active_categories: activeCats(),
        });
      }
      if (rpcName === 'get_experience_questions') {
        const cat = body?.p_category;
        if (!ALLCATS.includes(cat)) return fail('invalid_category');
        return send({
          category: cat, version: 1, requires_assessment: PRO.includes(cat), questions: QS(cat),
          answers: s.answerText[cat] ?? null, answers_version: s.answerText[cat] ? 1 : null, outdated: !!opts.outdated?.[cat],
          updated_at: s.answerText[cat] ? iso(Date.now() - 60e3) : null, saves_left: Math.max(5 - (s.saves[cat] ?? 0), 0),
        });
      }
      if (rpcName === 'save_experience_answers') {
        const cat = body?.p_category;
        const a = body?.p_answers ?? {};
        if (!ALLCATS.includes(cat)) return fail('invalid_category');
        if (!s.tester) return fail('profile_required');
        const ids = ['q1', 'q2', 'q3', 'q4'];
        for (const id of ids) {
          const v = String(a[id] ?? '').replace(/\s+/g, ' ').trim();
          if (v.length < 15) return fail('invalid_answers', id + ':too_short');
          if (v.length > 800) return fail('invalid_answers', id + ':too_long');
          const w = v.split(' ');
          if (w.length < 3 || new Set(w.map((x) => x.toLowerCase())).size < 3) return fail('invalid_answers', id + ':too_few_words');
        }
        if (new Set(ids.map((id) => String(a[id]).replace(/\s+/g, ' ').trim().toLowerCase())).size < 4) return fail('invalid_answers', 'duplicate_answers');
        const same = JSON.stringify(s.answerText[cat]) === JSON.stringify(a);
        if (!same) {
          if ((s.saves[cat] ?? 0) >= 5) return fail('experience_rate_limited', new Date(Date.now() + 3600e3).toISOString());
          s.saves[cat] = (s.saves[cat] ?? 0) + 1;
          s.answerText[cat] = a;
          s.expSaves.push({ cat, answers: a });
          s.qualified.delete(cat); s.notQualified.delete(cat); // a decision is bound to the exact answers
        }
        s.answered.add(cat);
        return send(catJson(cat));
      }
      if (rpcName === 'set_ai_consent') {
        s.consent = !!body?.p_granted;
        s.consentCalls.push(s.consent);
        return send({ granted: s.consent, policy_version: 1, updated_at: iso(Date.now()) });
      }
      if (rpcName === 'delete_my_experience') {
        const cat = body?.p_category ?? null;
        s.deleteCalls.push(cat);
        let n = 0;
        for (const c of ALLCATS) {
          if (cat && c !== cat) continue;
          if (s.answerText[c]) n++;
          delete s.answerText[c];
          s.answered.delete(c);
          s.qualified.delete(c); s.notQualified.delete(c);
        }
        return send({ deleted_answers: n, deleted_decisions: 0 });
      }
      if (rpcName === 'create_campaign_v2') {
        const cats = body?.p_categories ?? [];
        if (body?.p_mode === 'targeted' && cats.length === 0) return fail('targeted_requires_categories');
        if (cats.some((c) => !ALLCATS.includes(c))) return fail('invalid_categories');
        s.created.push({ rpc: rpcName, body });
        s.balance -= 1;
        return send('33333333-3333-3333-3333-333333333333');
      }
      if (rpcName === 'get_my_tester_profile') {
        if (!s.matching) return MISSING('get_my_tester_profile');
        return send(s.tester ? [s.tester] : []);
      }
      if (rpcName === 'save_tester_profile') {
        if (!s.matching) return MISSING('save_tester_profile');
        const nick = String(body?.p_nickname ?? '').replace(/s+/g, ' ').trim();
        const bio = String(body?.p_bio ?? '').replace(/s+/g, ' ').trim();
        const ALL = ['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical'];
        const cats = body?.p_categories ?? [];
        if (nick.length < 2 || nick.length > 30) return fail('invalid_nickname');
        if (bio.length > 280) return fail('invalid_bio');
        if (!Array.isArray(cats) || cats.some((c) => !ALL.includes(c))) return fail('invalid_categories');
        s.tester = { nickname: nick, bio: bio || null, categories: ALL.filter((c) => cats.includes(c)), updated_at: iso(Date.now()) };
        return send([s.tester]);
      }
      if (rpcName === 'delete_my_tester_profile') {
        if (!s.matching) return MISSING('delete_my_tester_profile');
        const had = !!s.tester;
        s.tester = null;
        return send(had);
      }
      if (rpcName === 'create_targeted_campaign') {
        if (!s.matching) return MISSING('create_targeted_campaign');
        const ALL = ['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical'];
        if ((body?.p_target_categories ?? []).some((c) => !ALL.includes(c))) return fail('invalid_categories');
        s.created.push({ rpc: rpcName, body });
        s.balance -= 1;
        return send('33333333-3333-3333-3333-333333333333');
      }
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
        if (!r && s.v2) {
          const row = s.feed.find((x) => x.campaign_id === id);
          const mode = row?.testing_mode ?? pg?.mode ?? 'open';
          const required = row?.target_categories ?? pg?.required ?? [];
          const e = eligibilityOf(mode, required);
          if (!e.eligible) return fail('not_eligible', e.reason);
        }
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
        s.created.push({ rpc: rpcName, body });
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
      if (p === '/rest/v1/campaigns') {
        if ((!s.matching && /target_categories/.test(url.search)) || (!s.v2 && /testing_mode/.test(url.search))) {
          return send({ code: '42703', details: null, hint: null, message: 'column campaigns.' + (/testing_mode/.test(url.search) && s.matching ? 'testing_mode' : 'target_categories') + ' does not exist' }, 400);
        }
        return send(s.dashCampaigns);
      }
      if (p === '/rest/v1/test_reservations') return send(s.dashReservations);
      if (p === '/rest/v1/test_submissions') return send(s.submissions);
      return send({ message: 'unstubbed ' + p }, 404);
    });
  }

  return { s, install, called, now };
}

/**
 * A backend whose identity already has a COMPLETED tester profile (Students & Learners + four answers). Since migration 8 a tester
 * needs one to reserve any task; the core / lifecycle / referral suites use this so they keep exercising their own subject.
 * The profile rules themselves are tested without it (matching-ui, matching-v2-ui, experience-ui).
 */
export function createReadyBackend(opts = {}) {
  return createBackend({ tester: { nickname: 'Ready', bio: null, categories: ['students_learners'], updated_at: iso(Date.now()) }, ...opts });
}
