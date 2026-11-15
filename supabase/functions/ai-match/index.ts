// Supabase Edge Function `ai-match` - AI recommendations + professional-experience assessment. Thin Deno wiring around
// _shared/aiMatching (all logic is unit-tested in Node; this file is exercised under real Deno by tests/deno/e2e.mjs).
//
// Secrets (set with `supabase secrets set`, NEVER committed, never VITE_*):
//   OPENAI_API_KEY            required for either action
//   AI_MATCHING_ENABLED       "true" to switch {"action":"recommend"} on   (kill switch; otherwise the app shows the plain list)
//   AI_ASSESSMENT_ENABLED     "true" to switch {"action":"assess"} on      (independent kill switch)
// Optional:
//   OPENAI_MODEL              default gpt-6-luna      OPENAI_REASONING_EFFORT   default low
//   AI_USER_DAILY_CALLS       default 12              AI_GLOBAL_DAILY_CALLS     default 1500
//   AI_GLOBAL_DAILY_TOKENS    default 5000000         AI_MIN_RUN_INTERVAL_SECONDS default 15
//   AI_ALLOWED_ORIGINS        comma list, default the two production hosts (add http://localhost:5173 for local dev)
//   OPENAI_BASE_URL           TEST ONLY and honoured only for loopback hosts (127.0.0.1 / localhost), so the key can never be sent elsewhere
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
//
// Data sources (nothing is duplicated here):
//   * the tester's voluntary text, consent, subject_ref, participation_ready, category states and etag: the profile workstream's
//     server-only contract public.service_get_ai_profile(user_id) (contract v1), mapped by _shared/aiMatching/contract.ts;
//   * campaigns + eligibility: public.list_campaigns_v2() under the CALLER's own JWT (the server's verdict);
//   * professional decisions: ONLY public.service_record_qualification (the profile workstream's one allowed write path);
//   * erasure: public.ai_apply_erasure_events() (reads the contract's service_list_erasure_events), run at the start of every request;
//   * derived data / caps: the ai_* RPCs of migration 20261115000500 (execute granted to service_role only).
//
// Auth model: the caller's JWT is verified with Supabase Auth (verify_jwt = true in config.toml AND getUser here).
// The service-role client is only ever used with the user id verified from that JWT.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.105.4';
import { mapAssessmentInput, mapContractProfile } from '../_shared/aiMatching/contract.ts';
import { createHandler } from '../_shared/aiMatching/handler.ts';
import { createOpenAiCaller } from '../_shared/aiMatching/openai.ts';
import type { AssessDeps, AssessNote, CacheState, CachedMatch, CommonDeps, Deps, FeedRow, ReserveResult } from '../_shared/aiMatching/types.ts';

const env = (k: string): string => Deno.env.get(k) ?? '';
const int = (k: string, d: number): number => {
  const n = Number(env(k));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};
/** Like int(), but 0 is a valid setting (AI_MIN_RUN_INTERVAL_SECONDS=0 switches the throttle off); unset/garbage/negative => default. */
const intOrZero = (k: string, d: number): number => {
  const raw = env(k).trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

const SUPABASE_URL = env('SUPABASE_URL');
const ANON_KEY = env('SUPABASE_ANON_KEY');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_KEY = env('OPENAI_API_KEY');
const MODEL = env('OPENAI_MODEL') || 'gpt-6-luna';

const ALLOWED_ORIGINS = (env('AI_ALLOWED_ORIGINS') || 'https://uxbarter.vercel.app,https://peerprobe.vercel.app')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** TEST ONLY: a base-URL override is honoured only for loopback hosts, so a misconfiguration can never redirect the API key. */
function openAiBase(): string | undefined {
  const v = env('OPENAI_BASE_URL');
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' ? v.replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

// Created lazily: a missing service key must degrade to "feature off", not crash the function at boot.
let serviceClient: SupabaseClient | null = null;
function service(): SupabaseClient {
  if (!serviceClient) serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return serviceClient;
}

const callModel = createOpenAiCaller({ apiKey: OPENAI_KEY, model: MODEL, reasoningEffort: env('OPENAI_REASONING_EFFORT') || 'low', baseUrl: openAiBase() });

function userClient(req: Request): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function rpc<T>(client: SupabaseClient, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    console.error(`ai-match: rpc ${fn} failed`); // function name only: never arguments or data
    // The PostgREST message of OUR functions is a short code (e.g. stale_assessment); the engine branches on it, the browser never sees it.
    throw new Error(String(error.message ?? 'rpc failed').slice(0, 120));
  }
  return data as T;
}

function common(userId: string, kind: 'match' | 'assess'): CommonDeps {
  const caps = () => ({
    p_user_daily_cap: int('AI_USER_DAILY_CALLS', 12),
    p_global_daily_cap: int('AI_GLOBAL_DAILY_CALLS', 1500),
    p_global_token_cap: int('AI_GLOBAL_DAILY_TOKENS', 5_000_000),
    p_min_interval_seconds: intOrZero('AI_MIN_RUN_INTERVAL_SECONDS', 15),
  });
  return {
    config: {
      model: MODEL,
      userDailyCallCap: int('AI_USER_DAILY_CALLS', 12),
      globalDailyCallCap: int('AI_GLOBAL_DAILY_CALLS', 1500),
      globalDailyTokenCap: int('AI_GLOBAL_DAILY_TOKENS', 5_000_000),
      minRunIntervalSeconds: intOrZero('AI_MIN_RUN_INTERVAL_SECONDS', 15),
    },
    applyErasures: async () => { await rpc(service(), 'ai_apply_erasure_events', { p_limit: 500 }); },
    purgeDerived: async () => { await rpc(service(), 'ai_purge_user', { p_user: userId }); },
    reserveRun: (calls) => rpc<ReserveResult>(service(), 'ai_reserve_run', { p_user: userId, p_kind: kind, p_calls: calls, ...caps() }),
    recordTokens: async (u) => { await rpc(service(), 'ai_record_tokens', { p_user: userId, p_kind: kind, p_input: u.input_tokens, p_output: u.output_tokens }); },
    consentActive: async (subjectRef) => (await rpc<boolean>(service(), 'ai_consent_active', { p_user: userId, p_subject_ref: subjectRef })) === true,
    callModel,
    log: (code) => console.error(`ai-match: ${code}`), // coarse code only
  };
}

const profileRpc = (userId: string) => rpc<unknown>(service(), 'service_get_ai_profile', { p_user_id: userId });

const handler = createHandler({
  enabled: {
    recommend: env('AI_MATCHING_ENABLED') === 'true' && OPENAI_KEY !== '' && SERVICE_KEY !== '',
    assess: env('AI_ASSESSMENT_ENABLED') === 'true' && OPENAI_KEY !== '' && SERVICE_KEY !== '',
  },
  allowedOrigins: ALLOWED_ORIGINS,

  async authenticate(req) {
    const auth = req.headers.get('authorization') ?? '';
    if (!/^Bearer\s+\S+$/i.test(auth)) return null;
    // Verified by Supabase Auth (signature + expiry + session), not decoded locally. Token passed explicitly.
    const token = auth.replace(/^Bearer\s+/i, '');
    const { data, error } = await userClient(req).auth.getUser(token);
    return error || !data.user ? null : data.user.id;
  },

  makeRecommendDeps(userId, req): Deps {
    const caller = userClient(req);
    return {
      ...common(userId, 'match'),
      getProfileInput: async () => mapContractProfile(await profileRpc(userId)),
      listCandidates: () => rpc<FeedRow[]>(caller, 'list_campaigns_v2'),
      getCache: (subjectRef) => rpc<CacheState>(service(), 'ai_get_cache', { p_user: userId, p_subject_ref: subjectRef }),
      putAnalysis: async (subjectRef, inputHash, analysis) => {
        await rpc(service(), 'ai_put_analysis', { p_user: userId, p_subject_ref: subjectRef, p_input_hash: inputHash, p_analysis: analysis, p_model: MODEL });
      },
      putMatches: async (subjectRef, rows: CachedMatch[]) => {
        await rpc(service(), 'ai_put_matches', { p_user: userId, p_subject_ref: subjectRef, p_matches: rows });
      },
    };
  },

  makeAssessDeps(userId): AssessDeps {
    return {
      ...common(userId, 'assess'),
      getAssessmentInput: async () => mapAssessmentInput(await profileRpc(userId)),
      getNotes: (subjectRef) => rpc<AssessNote[]>(service(), 'ai_get_assessment_notes', { p_user: userId, p_subject_ref: subjectRef }),
      putNote: async (subjectRef, category, answersHash, payload) => {
        await rpc(service(), 'ai_put_assessment_note', { p_user: userId, p_subject_ref: subjectRef, p_category: category, p_answers_hash: answersHash, p_payload: payload, p_model: MODEL });
      },
      // The ONE write path for a professional-category decision (profile workstream's function). Never a table write.
      recordQualification: async (a) => {
        await rpc(service(), 'service_record_qualification', {
          p_user_id: userId, p_category: a.category, p_question_version: a.question_version, p_answers_hash: a.answers_hash,
          p_status: a.status, p_assessment: a.assessment,
        });
      },
    };
  },
});

Deno.serve(handler);
