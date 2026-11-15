// Targeted Tester Matching - the pure, dependency-free part: the five categories and the keyword suggester.
// (Matching itself happens in Postgres: list_matched_campaigns() = plain set intersection, see migration 6.)
//
// Written with erasable TypeScript only (no enums / parameter properties / imports) so that tests/unit can import
// this file directly with `node`.

export const CATEGORY_IDS = ['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface CategoryInfo {
  id: CategoryId;
  label: string;
  /** One line shown under the label so people know what they are choosing. */
  blurb: string;
  /**
   * Words / phrases that make the bio suggester propose this category. Deliberately plain job / activity / skill
   * words. No terms that describe protected or sensitive attributes (age, religion, race, gender, health,
   * disability, politics, family status, nationality ...): a unit test enforces that.
   */
  keywords: readonly string[];
}

export const CATEGORIES: readonly CategoryInfo[] = [
  {
    id: 'tech_savvy',
    label: 'Tech-Savvy Users',
    blurb: 'Comfortable with software, developer tools and new apps.',
    keywords: ['developer', 'engineer', 'programmer', 'programming', 'coder', 'coding', 'devops', 'sysadmin', 'software', 'api', 'open source', 'full stack', 'frontend', 'backend', 'machine learning', 'data scientist', 'cloud', 'linux', 'power user', 'tech enthusiast'],
  },
  {
    id: 'founders_builders',
    label: 'Founders & Product Builders',
    blurb: 'Building a startup, product or side project.',
    keywords: ['founder', 'co-founder', 'cofounder', 'startup', 'entrepreneur', 'indie hacker', 'maker', 'product manager', 'product owner', 'product designer', 'solopreneur', 'bootstrapped', 'side project', 'saas', 'ux', 'ui designer'],
  },
  {
    id: 'business_office',
    label: 'Business & Office Users',
    blurb: 'Uses software for work: operations, finance, sales, marketing, admin.',
    keywords: ['manager', 'operations', 'accountant', 'accounting', 'finance', 'marketing', 'sales', 'consultant', 'hr', 'human resources', 'office', 'administrator', 'analyst', 'project manager', 'customer support', 'small business', 'business owner', 'freelancer', 'bookkeeper', 'bookkeeping'],
  },
  {
    id: 'students_learners',
    label: 'Students & Learners',
    blurb: 'Studying or learning a new skill.',
    keywords: ['student', 'university', 'college', 'school', 'learning', 'learner', 'bootcamp', 'course', 'self-taught', 'graduate', 'studying', 'phd', 'apprentice', 'intern'],
  },
  {
    id: 'everyday_nontechnical',
    label: 'Everyday & Non-Technical Users',
    blurb: 'Uses apps day to day without a technical background.',
    keywords: ['non-technical', 'non technical', 'not technical', 'not a developer', 'not techy', 'not tech-savvy', 'everyday', 'casual', 'beginner', 'regular user', 'average user', 'ordinary user', 'general public', 'no coding'],
  },
];

const BY_ID: Readonly<Record<string, CategoryInfo>> = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

export const isCategoryId = (x: unknown): x is CategoryId => typeof x === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, x);

export function categoryLabel(id: string): string {
  return BY_ID[id]?.label ?? id;
}

/** Same canonical form as the database: known ids only, de-duplicated, in the fixed category order. */
export function normalizeCategories(ids: readonly string[] | null | undefined): CategoryId[] {
  const set = new Set(ids ?? []);
  return CATEGORY_IDS.filter((id) => set.has(id));
}

export interface CategorySuggestion {
  id: CategoryId;
  label: string;
  /** The exact words found in the bio. This list IS the explanation: nothing else influences a suggestion. */
  matched: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "word" boundaries that also work for phrases and hyphens: not preceded / followed by a letter or digit.
const phraseRe = (kw: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(kw)}(?![\\p{L}\\p{N}])`, 'iu');

/**
 * Transparent keyword suggester. NOT an AI model and not a classifier of people: it only looks for the listed
 * words in the text the user typed, and the UI shows which words triggered which suggestion. It never selects
 * anything by itself.
 *
 * Negations are handled by order: "everyday / non-technical" phrases are located first and removed from the text
 * before the other categories are matched, so "I am not a developer" does not suggest Tech-Savvy Users.
 */
export function suggestCategories(bio: string | null | undefined): CategorySuggestion[] {
  const text = (bio ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const everyday = BY_ID.everyday_nontechnical;
  let rest = text;
  const everydayHits: string[] = [];
  // Longest phrases first so "not tech-savvy" wins over "tech".
  for (const kw of [...everyday.keywords].sort((a, b) => b.length - a.length)) {
    const re = phraseRe(kw);
    if (re.test(rest)) {
      everydayHits.push(kw);
      rest = rest.replace(new RegExp(re.source, 'giu'), ' ');
    }
  }

  const out: CategorySuggestion[] = [];
  for (const c of CATEGORIES) {
    const hay = c.id === 'everyday_nontechnical' ? text : rest;
    const matched = c.id === 'everyday_nontechnical' ? everydayHits : c.keywords.filter((kw) => phraseRe(kw).test(hay));
    if (matched.length > 0) out.push({ id: c.id, label: c.label, matched });
  }
  // Most evidence first; ties keep the fixed category order (stable sort), so the result is deterministic.
  return out.sort((a, b) => b.matched.length - a.matched.length);
}

// ---------------------------------------------------------------------------------------------------------------
// Open vs targeted testing and the EXPERIENCE profile (pure helpers; the RULES live in Postgres).
// Four open-ended answers per category. General categories become active when the answers are valid; the three
// PROFESSIONAL categories additionally need a qualification decision (assessment of the self-reported answers), never
// the answers alone. Nothing here claims verification of employment, identity or qualifications.
// ---------------------------------------------------------------------------------------------------------------

export type TestingMode = 'open' | 'targeted';

/** The three professional categories: active only after a qualification decision. */
export const PROFESSIONAL_CATEGORY_IDS = ['tech_savvy', 'founders_builders', 'business_office'] as const;
export type ProfessionalCategoryId = (typeof PROFESSIONAL_CATEGORY_IDS)[number];

export const isProfessional = (id: string): id is ProfessionalCategoryId => (PROFESSIONAL_CATEGORY_IDS as readonly string[]).includes(id);

/** Basic input limits (the server enforces the same, and is authoritative). */
export const ANSWER_MIN = 15;
export const ANSWER_MAX = 800;
export const ANSWER_SAVES_PER_DAY = 5;

/** Instant feedback only: null = looks fine. Mirrors normalize_experience_answers in migration 8. */
export function validateAnswer(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < ANSWER_MIN) return `Write at least ${ANSWER_MIN} characters (a sentence or two, in your own words).`;
  if (t.length > ANSWER_MAX) return `Please keep it under ${ANSWER_MAX} characters.`;
  const words = t.split(' ');
  if (words.length < 3 || new Set(words.map((w) => w.toLowerCase())).size < 3) return 'Use at least three different words.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) return 'This text contains characters that are not allowed.';
  return null;
}

/** Errors per question id, plus a flag when two or more answers are the same text. */
export function validateAnswers(ids: readonly string[], answers: Readonly<Record<string, string>>): { errors: Record<string, string>; duplicate: boolean; ok: boolean } {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicate = false;
  for (const id of ids) {
    const v = answers[id] ?? '';
    const e = validateAnswer(v);
    if (e) errors[id] = e;
    const key = v.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!e) {
      if (seen.has(key)) duplicate = true;
      seen.add(key);
    }
  }
  return { errors, duplicate, ok: Object.keys(errors).length === 0 && !duplicate };
}

export type ExperienceStateId = 'inactive' | 'incomplete' | 'active' | 'pending_assessment' | 'not_qualified';

export interface ExperienceLike {
  state: ExperienceStateId;
  reason: string;
  requires_assessment: boolean;
  qualification: { status: string; source: string } | null;
}

export interface ExperienceBadge {
  kind: 'active' | 'pending' | 'incomplete' | 'warn';
  text: string;
}

/** Wording for a category's status. Never "verified". null = nothing to show (not selected). */
export function experienceBadge(c: ExperienceLike): ExperienceBadge | null {
  switch (c.state) {
    case 'inactive':
      return null;
    case 'incomplete':
      return {
        kind: 'incomplete',
        text: c.reason === 'questions_changed' ? 'Incomplete · questions were updated, please review your answers' : 'Incomplete · four answers needed',
      };
    case 'pending_assessment':
      return {
        kind: 'pending',
        text: c.reason === 'consent_required' ? 'Pending assessment · needs your AI permission' : 'Pending assessment · answers received',
      };
    case 'not_qualified':
      return { kind: 'warn', text: 'Not qualified yet · edit your answers to be assessed again' };
    case 'active':
      if (!c.requires_assessment) return { kind: 'active', text: 'Active' };
      return { kind: 'active', text: 'Active · qualified by assessment' };
  }
}

/** The honest one-line description of what the professional assessment is. */
export const ASSESSMENT_NOTE = 'Professional categories are assessed from your own written description of your experience. UXBarter does not verify employment, identity or qualifications.';

export type IneligibleReason = 'profile_incomplete' | 'category_mismatch' | 'qualification_required' | 'no_profile' | 'screening_required';

export interface Explanation {
  title: string;
  body: string;
  /** What the tester can do about it. */
  action: 'profile' | 'answers' | null;
  /** For action = answers: the category whose answers / assessment unlock the task. */
  answersCategory: string | null;
}

const list = (ids: readonly string[]) => ids.map(categoryLabel).join(', ');

/** Plain-language reason why a tester cannot start a task (mirrors the server's reason codes). */
export function explainIneligible(reason: string | null | undefined, required: readonly string[], missing: readonly string[] = []): Explanation {
  const req = list(required);
  if (reason === 'profile_incomplete' || reason === 'no_profile') {
    return {
      title: 'Complete your tester profile first',
      body: 'To take tests and earn credits, choose at least one tester category and answer its four short questions in your own words. You can still request tests without it.',
      action: 'profile',
      answersCategory: null,
    };
  }
  if (reason === 'category_mismatch') {
    return {
      title: 'Your tester profile does not match this task',
      body: `The founder asked for testers in: ${req}. Your profile does not include any of these categories. If one of them describes you, add it to your profile and answer its questions.`,
      action: 'profile',
      answersCategory: null,
    };
  }
  if (reason === 'qualification_required' || reason === 'screening_required') {
    const first = missing[0] ?? required[0] ?? null;
    const what = missing.length > 0 ? list(missing) : req;
    return {
      title: 'Qualification required',
      body: `This task asks for: ${req}. You selected ${what}, but it is not active yet: all four answers are needed and, for professional categories, an assessment of your self-reported experience (not a verified credential). Until then it does not qualify you for targeted tasks.`,
      action: 'answers',
      answersCategory: first,
    };
  }
  return { title: 'You cannot take this task', body: 'This task is restricted to certain testers.', action: null, answersCategory: null };
}

/** Short label for a Discover card. */
export function shortReason(reason: string | null | undefined): string {
  if (reason === 'profile_incomplete' || reason === 'no_profile') return 'complete your profile first';
  if (reason === 'category_mismatch') return 'your profile does not match';
  if (reason === 'qualification_required' || reason === 'screening_required') return 'qualification required';
  return 'not eligible';
}
