// Professional-experience assessment for Tech-Savvy, Founders & Product Builders and Business & Office testers.
//
// WHAT IT DECIDES. Whether the tester's four free-text answers contain plausible, relevant, sufficiently substantive
// SELF-REPORTED experience (rubric r1, rubrics.ts). It is not an exam: no credential, school, employer, title or years are needed.
//
// HOW A DECISION BECOMES REAL. The model only PROPOSES. This file decides in code, and the only write path is the profile
// workstream's service_record_qualification (called by the Edge Function with a user id verified from the caller's JWT and the
// question_version + answers_hash it just READ from service_get_ai_profile). The browser can never forge or submit a status.
//   qualified            only if: model says qualified, confidence is not low, no plausibility concern, no instruction-like text,
//                        and at least TWO distinct criteria are backed by verbatim quotes that sit in at least TWO DIFFERENT answers.
//   not_qualified        only if: the model says "not yet" with confidence, no flags, and fewer than two grounded criteria.
//                        (An honest "I have little experience" lands here: no failure of the person, they can still take open tasks.)
//   needs_clarification  everything else (unsure, vague, contradictory, too thin, instruction-like text). NOT recorded: the category
//                        stays pending, nothing is invented in either direction, and the tester gets neutral follow-up prompts.
// Results are labelled "based on self-reported experience, not verified credentials". Messages are fixed text, never model text.

import { AiError } from './openai.ts';
import { looksLikeInstruction } from './guard.ts';
import { ASSESS_SCHEMA, assessSystemPrompt, assessUserMessage } from './prompts.ts';
import { DEFAULT_CLARIFICATION, RUBRICS, RUBRIC_VERSION } from './rubrics.ts';
import { cleanText, isRecord, LIMITS, normForQuote } from './util.ts';
import { groundedQuote, safeText } from './validate.ts';
import type {
  AssessDeps, AssessmentTarget, AssessOutcome, AssessResponse, AssessResult, AssessStatus, ModelUsage, ProfessionalCategory,
} from './types.ts';

/** Below this many words in total the four answers are too thin to judge: ask for detail instead of spending a model call. */
const MIN_TOTAL_WORDS = 20;
const SELF_REPORTED = 'This is based on your self-reported answers, not on verified professional credentials.';

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const ORDER: readonly string[] = ['tech_savvy', 'founders_builders', 'business_office'];

function message(outcome: AssessOutcome, label: string, why?: 'thin' | 'instruction'): string {
  switch (outcome) {
    case 'qualified':
      return `Your answers describe hands-on experience for ${label}. ${SELF_REPORTED}`;
    case 'not_qualified':
      return `From your answers we could not yet see hands-on experience for ${label}. That is fine: you can still take open tasks and use any other category. If you do have more experience, you can add detail to your answers, but only what is true. ${SELF_REPORTED}`;
    case 'needs_clarification':
      if (why === 'thin') return `Your answers for ${label} are very short, so we cannot judge them yet. A few more concrete details about what you actually did would help, but only if they are true. You can still take open tasks. ${SELF_REPORTED}`;
      if (why === 'instruction') return `Some text in your answers reads like instructions rather than a description of your experience. Please describe what you actually did in your own words. ${SELF_REPORTED}`;
      return `We could not tell confidently from your answers for ${label}. Concrete details about what you actually did can help, but only if they are true; nothing is wrong if your experience is modest, and you can still take open tasks. ${SELF_REPORTED}`;
    default:
      return `We could not finish checking ${label} right now. It stays pending; please try again later.`;
  }
}

function result(t: { category: ProfessionalCategory }, outcome: AssessOutcome, why?: 'thin' | 'instruction', questions: string[] = []): AssessResult {
  const r = RUBRICS[t.category];
  return {
    category: t.category, outcome, message: message(outcome, r.label, why),
    clarification_questions: outcome === 'needs_clarification' ? (questions.length > 0 ? questions : DEFAULT_CLARIFICATION[t.category]) : [],
    criteria: r.criteria.map((c) => c.text),
  };
}

export interface Decision {
  decision: 'qualified' | 'not_qualified' | 'needs_clarification';
  confidence: number;
  questions: string[];
}

/** Policy applied to the model's PROPOSAL. null = malformed (treated as a failed call, nothing is recorded). */
export function decideAssessment(raw: unknown, target: AssessmentTarget): Decision | null {
  if (!isRecord(raw)) return null;
  if (raw.outcome !== 'qualified' && raw.outcome !== 'not_yet' && raw.outcome !== 'unclear') return null;
  if (raw.confidence !== 'low' && raw.confidence !== 'medium' && raw.confidence !== 'high') return null;
  if (!Array.isArray(raw.criteria) || typeof raw.plausibility_concern !== 'boolean' || typeof raw.instruction_like_text !== 'boolean') return null;

  const answersNorm = target.answers.map((a) => normForQuote(a.answer));
  const validIds = new Set(RUBRICS[target.category].criteria.map((c) => c.id));
  const seen = new Set<string>();
  const answerIdx = new Set<number>();
  for (const c of raw.criteria.slice(0, 8)) {
    if (!isRecord(c) || c.met !== 'yes' || typeof c.id !== 'string' || !validIds.has(c.id) || seen.has(c.id)) continue;
    if (looksLikeInstruction(c.quote)) continue;
    let idx = -1;
    for (let i = 0; i < answersNorm.length && idx < 0; i++) if (groundedQuote(c.quote, answersNorm[i])) idx = i; // the quote must live inside ONE answer
    if (idx < 0) continue;
    seen.add(c.id);
    answerIdx.add(idx);
  }
  const grounded = seen.size;

  const qs = Array.isArray(raw.clarification_questions)
    ? raw.clarification_questions.filter((q): q is string => typeof q === 'string').slice(0, 3).map((q) => safeText(q, 160)).filter((q) => q.length >= 8 && !looksLikeInstruction(q))
    : [];
  const flagged = raw.instruction_like_text === true || raw.plausibility_concern === true;
  const sure = raw.confidence !== 'low';
  const num = raw.confidence === 'high' ? 0.85 : 0.6;

  if (raw.outcome === 'qualified' && !flagged && sure && grounded >= 2 && answerIdx.size >= 2) return { decision: 'qualified', confidence: num, questions: [] };
  if (raw.outcome === 'not_yet' && !flagged && sure && grounded < 2) return { decision: 'not_qualified', confidence: num, questions: [] };
  // Everything else - including a "qualified" claim the evidence does not back - is NOT recorded.
  return { decision: 'needs_clarification', confidence: 0, questions: qs };
}

export async function assess(deps: AssessDeps): Promise<AssessResponse> {
  const out = (status: AssessStatus, results: AssessResult[]): AssessResponse => ({
    status, results: results.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category)), generated_at: new Date().toISOString(),
  });

  await deps.applyErasures().catch(() => deps.log?.('erasure_sweep_failed'));
  const input = await deps.getAssessmentInput();
  if (!input.consent || !input.subject_ref) {
    await deps.purgeDerived().catch(() => deps.log?.('purge_failed'));
    return out('consent_required', []);
  }
  const subject = input.subject_ref;
  if (input.targets.length === 0) return out('ok', []);

  const bioRaw = cleanText(input.bio, LIMITS.bioChars);
  const bio = looksLikeInstruction(bioRaw) ? '' : bioRaw; // instruction-like bio is simply not sent
  const notes = await deps.getNotes(subject).catch((): [] => []);
  const results: AssessResult[] = [];
  const toCall: AssessmentTarget[] = [];

  for (const t of input.targets) {
    const text = t.answers.map((a) => a.answer).join(' ');
    if (wordCount(text) < MIN_TOTAL_WORDS) { results.push(result(t, 'needs_clarification', 'thin')); continue; }
    if (looksLikeInstruction(text)) { results.push(result(t, 'needs_clarification', 'instruction')); continue; }
    const note = notes.find((n) => n.category === t.category && n.answers_hash === t.answers_hash);
    if (note) { results.push(result(t, 'needs_clarification', undefined, note.payload.clarification_questions)); continue; }
    toCall.push(t);
  }
  if (toCall.length === 0) return out('ok', results);

  const admitted = await deps.reserveRun(toCall.length);
  if (admitted !== 'ok') {
    for (const t of toCall) results.push(result(t, 'pending'));
    return out(admitted === 'too_fast' ? 'busy' : admitted === 'user_daily_cap' ? 'rate_limited' : 'budget_reached', results);
  }

  const spent: ModelUsage = { input_tokens: 0, output_tokens: 0 };
  let failures = 0;
  let consentGone = false;
  try {
    for (const t of toCall) {
      try {
        const res = await deps.callModel({
          name: 'professional_assessment', system: assessSystemPrompt(t.category),
          user: assessUserMessage(bio, t.answers.map((a) => ({ question_id: a.question_id, question: cleanText(a.question, 300), answer: cleanText(a.answer, LIMITS.answerChars) }))),
          schema: ASSESS_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: LIMITS.maxOutputTokensAssess,
        });
        spent.input_tokens += res.usage.input_tokens; spent.output_tokens += res.usage.output_tokens;
        const d = decideAssessment(res.json, t);
        if (!d) { failures++; deps.log?.('assessment_malformed'); results.push(result(t, 'pending')); continue; }

        if (d.decision === 'needs_clarification') {
          await deps.putNote(subject, t.category, t.answers_hash, { clarification_questions: d.questions }).catch(() => deps.log?.('note_write_failed'));
          results.push(result(t, 'needs_clarification', undefined, d.questions));
          continue;
        }
        try {
          await deps.recordQualification({
            category: t.category, question_version: t.question_version, answers_hash: t.answers_hash, status: d.decision,
            // Fixed text only: no model-written prose and never any answer text is stored in the decision.
            assessment: {
              model: deps.config.model, rubric_version: RUBRIC_VERSION, confidence: d.confidence,
              summary: d.decision === 'qualified'
                ? `Self-reported answers judged to show hands-on experience (rubric ${RUBRIC_VERSION}).`
                : `Self-reported answers did not yet show hands-on experience (rubric ${RUBRIC_VERSION}).`,
            },
          });
          results.push(result(t, d.decision));
        } catch (e) {
          const m = String((e as Error)?.message ?? '');
          if (m.includes('consent_required')) { consentGone = true; deps.log?.('record_consent_required'); }
          else if (m.includes('stale_assessment')) deps.log?.('record_stale'); // answers changed while we were thinking: not an error
          else { failures++; deps.log?.('record_failed'); }
          results.push(result(t, 'pending'));
        }
      } catch (e) {
        failures++;
        deps.log?.(e instanceof AiError ? `model_${e.code}` : 'assess_failed');
        results.push(result(t, 'pending'));
      }
    }
  } finally {
    if (spent.input_tokens + spent.output_tokens > 0) await deps.recordTokens(spent).catch(() => undefined);
  }
  if (consentGone) return out('consent_required', results);
  return out(failures === toCall.length ? 'unavailable' : 'ok', results);
}
