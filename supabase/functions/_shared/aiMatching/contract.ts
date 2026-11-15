// ADAPTER between the profile/qualification workstream's server-only contract and this engine.
//
// Their side (src/lib/aiContract.ts on the profile branch, contract v1): public.service_get_ai_profile(user_id) returns
//   { contract_version: 1,
//     consent: { ai_processing: boolean, ... },
//     profile: { bio: string|null (null unless consent), categories: string[], updated_at } | null,
//     categories: [{ category, selected, answers_complete, answers: [{ question_id, question, answer }] | null (null unless
//                    consent AND answers_complete), ... } x5],
//     ... }
// Everything personal is already withheld by that function unless consent is granted. This adapter keeps ONLY what the model
// may see (bio, selected categories, the question/answer pairs) and drops the rest (qualification state, hashes, subject_ref,
// timestamps). If their contract changes, this file is the only place that has to change.

import { isRecord } from './util.ts';
import type { RawProfileInput } from './types.ts';

export const SUPPORTED_CONTRACT_VERSION = 1;

/** Consent withheld / unknown profile => a RawProfileInput that carries no personal text at all. */
const NO_CONSENT: RawProfileInput = { consent: false, has_profile: false, bio: null, categories: [], answers: [] };

export function mapContractProfile(raw: unknown): RawProfileInput {
  if (raw === null || raw === undefined) return NO_CONSENT; // unknown user
  if (!isRecord(raw) || raw.contract_version !== SUPPORTED_CONTRACT_VERSION) {
    throw new Error('unsupported_profile_contract'); // fail closed: never guess at a different shape
  }
  const consent = isRecord(raw.consent) && raw.consent.ai_processing === true;
  if (!consent) return { ...NO_CONSENT, has_profile: isRecord(raw.profile) };

  const profile = isRecord(raw.profile) ? raw.profile : null;
  const selected = profile && Array.isArray(profile.categories) ? profile.categories.filter((c): c is string => typeof c === 'string') : [];
  const answers: RawProfileInput['answers'] = [];
  if (Array.isArray(raw.categories)) {
    for (const c of raw.categories) {
      if (!isRecord(c) || typeof c.category !== 'string' || !selected.includes(c.category) || !Array.isArray(c.answers)) continue;
      for (const a of c.answers) {
        if (isRecord(a) && typeof a.question === 'string' && typeof a.answer === 'string') {
          answers.push({ category: c.category, question: a.question, answer: a.answer });
        }
      }
    }
  }
  return {
    consent: true,
    has_profile: profile !== null,
    bio: profile && typeof profile.bio === 'string' ? profile.bio : null,
    categories: selected,
    answers,
  };
}
