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
