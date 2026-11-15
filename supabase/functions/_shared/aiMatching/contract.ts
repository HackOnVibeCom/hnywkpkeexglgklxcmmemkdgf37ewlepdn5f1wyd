// ADAPTER between the profile workstream's server-only contract and this engine. THE ONLY file that knows their shape.
//
// Their side (src/lib/aiContract.ts, contract v1): public.service_get_ai_profile(user_id) returns
//   { contract_version: 1, subject_ref (null without consent), consent: { ai_processing }, profile: { bio (null without
//     consent), categories } | null, categories: [{ category, kind, selected, state, question_version, answers_hash,
//     answers: [{ question_id, question, answer }] | null (null unless consent AND selected AND complete) } x5],
//     active_categories, participation_ready, etag }.
// Everything personal is already withheld by that function unless consent is granted. This adapter keeps ONLY what the model
// may see and drops the rest (qualification objects, nicknames (never present), hashes except the one a decision must quote,
// timestamps). If their contract changes, this file is the only place that has to change; an unknown version fails closed.

import { isRecord } from './util.ts';
import type { AssessmentInput, AssessmentTarget, ProfessionalCategory, RawProfileInput } from './types.ts';

export const SUPPORTED_CONTRACT_VERSION = 1;
const PROFESSIONAL: readonly string[] = ['tech_savvy', 'founders_builders', 'business_office'];

const NO_CONSENT: RawProfileInput = { consent: false, subject_ref: null, etag: null, participation_ready: false, has_profile: false, bio: null, categories: [], answers: [] };

function checked(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null; // unknown user
  if (!isRecord(raw) || raw.contract_version !== SUPPORTED_CONTRACT_VERSION) {
    throw new Error('unsupported_profile_contract'); // fail closed: never guess at a different shape
  }
  return raw;
}

const hasConsent = (raw: Record<string, unknown>): boolean => isRecord(raw.consent) && raw.consent.ai_processing === true;
const subjectRef = (raw: Record<string, unknown>): string | null => (typeof raw.subject_ref === 'string' && raw.subject_ref !== '' ? raw.subject_ref : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Matching input: bio + selected categories + the answers of ACTIVE categories only (a pending / not-qualified professional category does not count for matching). */
export function mapContractProfile(rawIn: unknown): RawProfileInput {
  const raw = checked(rawIn);
  if (!raw) return NO_CONSENT;
  const profile = isRecord(raw.profile) ? raw.profile : null;
  if (!hasConsent(raw) || !subjectRef(raw)) return { ...NO_CONSENT, has_profile: profile !== null, participation_ready: raw.participation_ready === true };

  const selected = profile ? strs(profile.categories) : [];
  const answers: RawProfileInput['answers'] = [];
  if (Array.isArray(raw.categories)) {
    for (const c of raw.categories) {
      if (!isRecord(c) || typeof c.category !== 'string' || !selected.includes(c.category) || c.state !== 'active' || !Array.isArray(c.answers)) continue;
      for (const a of c.answers) {
        if (isRecord(a) && typeof a.question === 'string' && typeof a.answer === 'string') {
          answers.push({ category: c.category, question: a.question, answer: a.answer });
        }
      }
    }
  }
  return {
    consent: true,
    subject_ref: subjectRef(raw),
    etag: typeof raw.etag === 'string' ? raw.etag : null,
    participation_ready: raw.participation_ready === true,
    has_profile: profile !== null,
    bio: profile && typeof profile.bio === 'string' ? profile.bio : null,
    categories: selected,
    answers,
  };
}

/** Assessment input: professional categories waiting for a decision whose four answers are readable (consent present). */
export function mapAssessmentInput(rawIn: unknown): AssessmentInput {
  const raw = checked(rawIn);
  const none: AssessmentInput = { consent: false, subject_ref: null, bio: null, targets: [] };
  if (!raw || !hasConsent(raw) || !subjectRef(raw)) return none;
  const profile = isRecord(raw.profile) ? raw.profile : null;
  const targets: AssessmentTarget[] = [];
  if (Array.isArray(raw.categories)) {
    for (const c of raw.categories) {
      if (!isRecord(c) || typeof c.category !== 'string' || !PROFESSIONAL.includes(c.category)) continue;
      if (c.selected !== true || c.state !== 'pending_assessment' || !Array.isArray(c.answers)) continue;
      if (typeof c.answers_hash !== 'string' || !Number.isInteger(c.question_version)) continue;
      const answers = c.answers
        .filter((a): a is Record<string, unknown> => isRecord(a) && typeof a.question_id === 'string' && typeof a.question === 'string' && typeof a.answer === 'string')
        .map((a) => ({ question_id: a.question_id as string, question: a.question as string, answer: a.answer as string }));
      if (answers.length === 0) continue;
      targets.push({ category: c.category as ProfessionalCategory, question_version: c.question_version as number, answers_hash: c.answers_hash, answers });
    }
  }
  return { consent: true, subject_ref: subjectRef(raw), bio: profile && typeof profile.bio === 'string' ? profile.bio : null, targets };
}
