// HTTP layer of the ai-match Edge Function with every external piece injected (auth, deps), so request validation,
// CORS, error mapping and "never leak internals" are unit-testable. index.ts is the thin Deno wiring around this.
//
// Two actions, each with its own kill switch: {"action":"recommend"} (Discover recommendations) and {"action":"assess"}
// (professional-experience assessment of the CALLER's own pending categories). The body carries nothing else: a client can
// never choose a user, a category, a prompt, a model or a decision.

import { assess } from './assess.ts';
import { recommend } from './engine.ts';
import type { AssessDeps, AssessResponse, Deps, RecommendResponse } from './types.ts';

export interface HandlerOptions {
  /** Per-action switch (AI_MATCHING_ENABLED / AI_ASSESSMENT_ENABLED) AND an OpenAI key being configured. */
  enabled: { recommend: boolean; assess: boolean };
  allowedOrigins: readonly string[];
  /** Verifies the caller's JWT with Supabase Auth; returns the verified user id or null. */
  authenticate(req: Request): Promise<string | null>;
  /** Builds the per-request dependencies for an already-verified user. */
  makeRecommendDeps(userId: string, req: Request): Deps;
  makeAssessDeps(userId: string, req: Request): AssessDeps;
}

const MAX_BODY_BYTES = 2048;

function cors(req: Request, allowed: readonly string[]): Record<string, string> {
  const origin = req.headers.get('origin');
  const h: Record<string, string> = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
  if (origin && allowed.includes(origin)) h['access-control-allow-origin'] = origin;
  return h;
}

function json(req: Request, opts: HandlerOptions, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(req, opts.allowedOrigins) },
  });
}

const now = () => new Date().toISOString();
const RECOMMEND_UNAVAILABLE = (): RecommendResponse => ({ status: 'unavailable', items: [], generated_at: now(), profile_etag: '', evaluated: 0, from_cache: false, understanding: null });
const ASSESS_UNAVAILABLE = (): AssessResponse => ({ status: 'unavailable', results: [], generated_at: now() });

export function createHandler(opts: HandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, opts.allowedOrigins) });
    if (req.method !== 'POST') return json(req, opts, 405, { error: 'method_not_allowed' });

    // Browser calls must come from our own origins (CORS is advisory, but non-browser clients still need a valid JWT).
    const origin = req.headers.get('origin');
    if (origin && !opts.allowedOrigins.includes(origin)) return json(req, opts, 403, { error: 'origin_not_allowed' });

    // Authentication first: unauthenticated callers learn nothing and cost nothing.
    let userId: string | null = null;
    try { userId = await opts.authenticate(req); } catch { userId = null; }
    if (!userId) return json(req, opts, 401, { error: 'unauthorized' });

    // Bounded, strictly validated input. The only accepted bodies are {"action":"recommend"} and {"action":"assess"}.
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(req, opts, 413, { error: 'payload_too_large' });
    let text: string;
    try { text = await req.text(); } catch { return json(req, opts, 400, { error: 'bad_request' }); }
    if (text.length > MAX_BODY_BYTES) return json(req, opts, 413, { error: 'payload_too_large' });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return json(req, opts, 400, { error: 'bad_request' }); }
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body as object) : [];
    const action = keys.length === 1 ? (body as Record<string, unknown>).action : null;
    if (action !== 'recommend' && action !== 'assess') return json(req, opts, 400, { error: 'bad_request' });

    try {
      if (action === 'recommend') {
        if (!opts.enabled.recommend) return json(req, opts, 200, RECOMMEND_UNAVAILABLE()); // feature off / no key: plain list
        return json(req, opts, 200, await recommend(opts.makeRecommendDeps(userId, req)));
      }
      if (!opts.enabled.assess) return json(req, opts, 200, ASSESS_UNAVAILABLE());
      return json(req, opts, 200, await assess(opts.makeAssessDeps(userId, req)));
    } catch {
      // Never reflect internals (DB errors, provider bodies, prompts) to the browser; log a coarse marker for operators only.
      console.error(`ai-match: unhandled error in ${action}`);
      return json(req, opts, 200, action === 'recommend' ? RECOMMEND_UNAVAILABLE() : ASSESS_UNAVAILABLE());
    }
  };
}
