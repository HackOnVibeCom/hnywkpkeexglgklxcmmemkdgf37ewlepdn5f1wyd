// OpenAI Responses API client (https://developers.openai.com/api/docs/guides/structured-outputs, verified 2026-11-15).
//   POST https://api.openai.com/v1/responses
//   text.format = { type:'json_schema', name, strict:true, schema }   -> output_text is JSON matching the schema
//   store:false (no 30-day application-state retention); max_output_tokens INCLUDES reasoning tokens.
// The key is read from the Edge Function's secret store by the caller and never leaves the server.
// Every failure becomes an AiError with a coarse code; raw provider bodies are never returned to browsers.

import { isRecord } from './util.ts';
import type { ModelRequest, ModelResponse } from './types.ts';

export type AiErrorCode = 'timeout' | 'network' | 'http_error' | 'rate_limited_upstream' | 'refusal' | 'incomplete' | 'bad_response' | 'not_configured';

export class AiError extends Error {
  code: AiErrorCode;
  status: number | null;
  constructor(code: AiErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  /** reasoning.effort - model dependent (gpt-6-luna: none|low|medium|high|xhigh|max). */
  reasoningEffort?: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createOpenAiCaller(opts: OpenAiOptions): (req: ModelRequest) => Promise<ModelResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = (opts.baseUrl ?? 'https://api.openai.com') + '/v1/responses';
  const timeoutMs = opts.timeoutMs ?? 45_000;

  return async (req) => {
    if (!opts.apiKey) throw new AiError('not_configured', 'OPENAI_API_KEY is not set');
    const body: Record<string, unknown> = {
      model: opts.model,
      input: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      text: { format: { type: 'json_schema', name: req.name, strict: true, schema: req.schema } },
      max_output_tokens: req.maxOutputTokens,
      store: false,
    };
    if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new AiError((e as Error)?.name === 'AbortError' ? 'timeout' : 'network', 'request failed');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) throw new AiError('rate_limited_upstream', 'upstream rate limit', 429);
    if (!res.ok) {
      try { await res.text(); } catch { /* body intentionally discarded: it may echo prompt content */ }
      throw new AiError('http_error', `upstream status ${res.status}`, res.status);
    }

    let data: unknown;
    try { data = await res.json(); } catch { throw new AiError('bad_response', 'response is not JSON'); }
    if (!isRecord(data)) throw new AiError('bad_response', 'unexpected response shape');
    if (data.status === 'incomplete') throw new AiError('incomplete', 'model output was cut off');

    const output = Array.isArray(data.output) ? data.output : [];
    const message = output.find((o) => isRecord(o) && o.type === 'message');
    const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
    if (content.some((c) => isRecord(c) && c.type === 'refusal')) throw new AiError('refusal', 'model refused');
    const textPart = content.find((c) => isRecord(c) && c.type === 'output_text');
    const text = isRecord(textPart) && typeof textPart.text === 'string' ? textPart.text : null;
    if (!text) throw new AiError('bad_response', 'no output text');

    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new AiError('bad_response', 'output is not valid JSON'); }

    const u = isRecord(data.usage) ? data.usage : {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return { json, usage: { input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens) } };
  };
}
