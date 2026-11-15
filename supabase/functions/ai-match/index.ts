// Supabase Edge Function `ai-match` - AI-powered Discover recommendations. Thin Deno wiring around _shared/aiMatching.
//
// Secrets (set with `supabase secrets set`, NEVER committed, never VITE_*):
//   OPENAI_API_KEY            required
//   AI_MATCHING_ENABLED       "true" to switch the feature on (kill switch; anything else => app falls back to plain list)
// Optional:
//   OPENAI_MODEL              default gpt-6-luna      OPENAI_REASONING_EFFORT   default low
//   AI_USER_DAILY_CALLS       default 12              AI_GLOBAL_DAILY_CALLS     default 1500
//   AI_GLOBAL_DAILY_TOKENS    default 5000000         AI_MIN_RUN_INTERVAL_SECONDS default 15
//   AI_ALLOWED_ORIGINS        comma list, default the two production hosts (add http://localhost:5173 for local dev)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
//
// Data sources (nothing is duplicated here):
//   * the tester's voluntary text + AI consent: the profile workstream's server-only contract
//     public.service_get_ai_profile(user_id) (contract v1), mapped by _shared/aiMatching/contract.ts;
//   * campaigns + eligibility: public.list_campaigns_v2() under the CALLER's own JWT (the server's verdict);
//   * derived data / caps: the ai_* RPCs of migration 20261115000500 (execute granted to service_role only).
//
// Auth model: the caller's JWT is verified with Supabase Auth (verify_jwt = true in config.toml AND getUser here).
// The service-role client is only ever used with the user id verified from that JWT.

import { createClient } from 'npm:@supabase/supabase-js@2.105.4';
import { mapContractProfile } from '../_shared/aiMatching/contract.ts';
import { createHandler } from '../_shared/aiMatching/handler.ts';
import { createOpenAiCaller } from '../_shared/aiMatching/openai.ts';
import type { CacheState, CachedMatch, Deps, FeedRow, ReserveResult } from '../_shared/aiMatching/types.ts';

const env = (k: string): string => Deno.env.get(k) ?? '';
const int = (k: string, d: number): number => {
  const n = Number(env(k));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

const SUPABASE_URL = env('SUPABASE_URL');
const ANON_KEY = env('SUPABASE_ANON_KEY');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_KEY = env('OPENAI_API_KEY');
const MODEL = env('OPENAI_MODEL') || 'gpt-6-luna';

const ALLOWED_ORIGINS = (env('AI_ALLOWED_ORIGINS') || 'https://uxbarter.vercel.app,https://peerprobe.vercel.app')
  .split(',').map((s) => s.trim()).filter(Boolean);

type Client = ReturnType<typeof createClient>;

// Created lazily: a missing service key must degrade to "feature off", not crash the function at boot.
let serviceClient: Client | null = null;
function service(): Client {
  if (!serviceClient) serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return serviceClient;
}

const callModel = createOpenAiCaller({ apiKey: OPENAI_KEY, model: MODEL, reasoningEffort: env('OPENAI_REASONING_EFFORT') || 'low' });

function userClient(req: Request): Client {
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function rpc<T>(client: Client, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    console.error(`ai-match: rpc ${fn} failed`); // function name only: never arguments, never the provider/db message
    throw new Error(`rpc ${fn} failed`);
  }
  return data as T;
}

const handler = createHandler({
  enabled: env('AI_MATCHING_ENABLED') === 'true' && OPENAI_KEY !== '' && SERVICE_KEY !== '',
  allowedOrigins: ALLOWED_ORIGINS,

  async authenticate(req) {
    const auth = req.headers.get('authorization') ?? '';
    if (!/^Bearer\s+\S+$/i.test(auth)) return null;
    // Verified by Supabase Auth (signature + expiry + session), not decoded locally. Token passed explicitly.
    const token = auth.replace(/^Bearer\s+/i, '');
    const { data, error } = await userClient(req).auth.getUser(token);
    return error || !data.user ? null : data.user.id;
  },

  makeDeps(userId, req): Deps {
    const caller = userClient(req);
    return {
      config: {
        model: MODEL,
        userDailyCallCap: int('AI_USER_DAILY_CALLS', 12),
        globalDailyCallCap: int('AI_GLOBAL_DAILY_CALLS', 1500),
        globalDailyTokenCap: int('AI_GLOBAL_DAILY_TOKENS', 5_000_000),
        minRunIntervalSeconds: int('AI_MIN_RUN_INTERVAL_SECONDS', 15),
      },
      getProfileInput: async () => mapContractProfile(await rpc<unknown>(service(), 'service_get_ai_profile', { p_user_id: userId })),
      listCandidates: () => rpc<FeedRow[]>(caller, 'list_campaigns_v2'),
      getCache: () => rpc<CacheState>(service(), 'ai_get_cache', { p_user: userId }),
      putAnalysis: async (inputHash, analysis) => {
        await rpc(service(), 'ai_put_analysis', { p_user: userId, p_input_hash: inputHash, p_analysis: analysis, p_model: MODEL });
      },
      putMatches: async (rows: CachedMatch[]) => {
        await rpc(service(), 'ai_put_matches', { p_user: userId, p_matches: rows });
      },
      reserveRun: (calls) =>
        rpc<ReserveResult>(service(), 'ai_reserve_run', {
          p_user: userId,
          p_calls: calls,
          p_user_daily_cap: int('AI_USER_DAILY_CALLS', 12),
          p_global_daily_cap: int('AI_GLOBAL_DAILY_CALLS', 1500),
          p_global_token_cap: int('AI_GLOBAL_DAILY_TOKENS', 5_000_000),
          p_min_interval_seconds: int('AI_MIN_RUN_INTERVAL_SECONDS', 15),
        }),
      recordTokens: async (u) => {
        await rpc(service(), 'ai_record_tokens', { p_user: userId, p_input: u.input_tokens, p_output: u.output_tokens });
      },
      purgeDerived: async () => {
        await rpc(service(), 'ai_purge_user', { p_user: userId });
      },
      log: (code) => console.error(`ai-match: ${code}`), // coarse code only
      callModel,
    };
  },
});

Deno.serve(handler);
