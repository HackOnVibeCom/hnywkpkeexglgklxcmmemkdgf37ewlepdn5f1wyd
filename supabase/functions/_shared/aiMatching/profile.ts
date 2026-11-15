// Turns the raw voluntary profile into (a) the minimal payload that may be sent to the model and (b) the text corpus
// that model-quoted evidence is verified against.

import { CATEGORY_LABELS } from './categories.ts';
import { cleanText, LIMITS, normForQuote } from './util.ts';
import type { ProfileForModel, RawProfileInput } from './types.ts';

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

export interface BuiltProfile {
  forModel: ProfileForModel;
  /** Normalised concatenation of everything the tester wrote (bio + answers): quotes must occur in here. */
  corpusNorm: string;
  /** Total characters the tester wrote. */
  textChars: number;
}

/**
 * Only categories currently in the profile, only well-formed answers, every text bounded and cleaned.
 * Deterministic: the same profile always yields the same payload (it is hashed for the cache).
 */
export function buildProfile(raw: RawProfileInput): BuiltProfile {
  const cats = CATEGORY_ORDER.filter((c) => Array.isArray(raw.categories) && raw.categories.includes(c));
  const bio = cleanText(raw.bio, LIMITS.bioChars);
  const answers: ProfileForModel['answers'] = [];
  const list = Array.isArray(raw.answers) ? raw.answers : [];
  for (const c of cats) {
    for (const item of list.filter((x) => x && x.category === c).slice(0, 8)) {
      const answer = cleanText(item.answer, LIMITS.answerChars);
      const question = cleanText(item.question, 300);
      if (answer && question) answers.push({ category: CATEGORY_LABELS[c], question, answer });
    }
  }
  const forModel: ProfileForModel = { bio, categories: cats.map((c) => CATEGORY_LABELS[c]), answers };
  const parts = [bio, ...answers.map((a) => a.answer)];
  return {
    forModel,
    corpusNorm: normForQuote(parts.join('\n')),
    textChars: parts.reduce((n, p) => n + p.length, 0),
  };
}
