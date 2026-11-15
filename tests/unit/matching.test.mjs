// Unit tests for src/lib/matching.ts (categories + transparent keyword suggester). No browser, no database:
// node imports the TypeScript file directly (type stripping), which is why that file uses erasable TS only.
//   node tests/unit/matching.test.mjs      (or: npm run test:unit)
import { CATEGORIES, CATEGORY_IDS, categoryLabel, isCategoryId, normalizeCategories, suggestCategories } from '../../src/lib/matching.ts';

let pass = 0;
let fail = 0;
const ok = (c, n, x = '') => {
  if (c) pass++;
  else fail++;
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`);
};
const ids = (s) => s.map((x) => x.id);

console.log('\n[the five categories]');
ok(CATEGORY_IDS.length === 5 && CATEGORIES.length === 5, 'exactly five categories');
ok(JSON.stringify(CATEGORIES.map((c) => c.label)) === JSON.stringify(['Tech-Savvy Users', 'Founders & Product Builders', 'Business & Office Users', 'Students & Learners', 'Everyday & Non-Technical Users']), 'labels match the product spec, in order');
ok(JSON.stringify(CATEGORY_IDS) === JSON.stringify(['tech_savvy', 'founders_builders', 'business_office', 'students_learners', 'everyday_nontechnical']), 'ids match the database allow-list (migration 6)');
ok(CATEGORY_IDS.every(isCategoryId) && !isCategoryId('wizards') && !isCategoryId(null) && !isCategoryId('__proto__') && !isCategoryId('constructor'), 'isCategoryId accepts only the five ids (prototype keys rejected)');
ok(categoryLabel('students_learners') === 'Students & Learners' && categoryLabel('nope') === 'nope', 'categoryLabel falls back to the raw id');

console.log('\n[normalizeCategories = the database canonical form]');
ok(JSON.stringify(normalizeCategories(['students_learners', 'tech_savvy', 'tech_savvy'])) === '["tech_savvy","students_learners"]', 'de-duplicates and orders canonically');
ok(JSON.stringify(normalizeCategories(['bogus', 'business_office'])) === '["business_office"]', 'drops unknown ids');
ok(normalizeCategories(null).length === 0 && normalizeCategories(undefined).length === 0 && normalizeCategories([]).length === 0, 'null / undefined / empty -> []');

console.log('\n[suggestCategories: transparent, deterministic]');
const dev = suggestCategories('I am a backend developer working on APIs and Linux servers.');
ok(ids(dev)[0] === 'tech_savvy' && dev[0].matched.includes('developer') && dev[0].matched.includes('backend') && dev[0].matched.includes('api') === false, 'developer/backend bio -> Tech-Savvy first, with the matched words listed', JSON.stringify(dev));
ok(suggestCategories('I own a small business and handle sales and bookkeeping').map((s) => s.id).join() === 'business_office', 'small business owner -> Business & Office only');
ok(ids(suggestCategories('Co-founder of a SaaS startup, I build side projects')).includes('founders_builders'), 'founder / startup -> Founders & Product Builders');
ok(ids(suggestCategories('Final-year university student, still learning')).join() === 'students_learners', 'student bio -> Students & Learners');
ok(ids(suggestCategories('Just a casual beginner who uses apps every day, everyday user')).join() === 'everyday_nontechnical', 'casual / beginner -> Everyday & Non-Technical');
ok(suggestCategories('').length === 0 && suggestCategories(null).length === 0 && suggestCategories('   \n ').length === 0, 'empty bio -> no suggestions');
ok(suggestCategories('I like hiking and cooking').length === 0, 'unrelated bio -> no suggestions (nothing is invented)');
const multi = suggestCategories('Startup founder and software developer, also a part-time student');
ok(['tech_savvy', 'founders_builders', 'students_learners'].every((id) => ids(multi).includes(id)), 'several categories can be suggested together');
ok(JSON.stringify(suggestCategories('Startup founder and software developer, also a part-time student')) === JSON.stringify(multi), 'same input -> same output (deterministic)');
ok(suggestCategories('DEVELOPER').length === 1 && suggestCategories('Developer!')[0].matched[0] === 'developer', 'case-insensitive, punctuation-tolerant');
ok(suggestCategories('undeveloped land, apiary hobby').length === 0, 'whole-word matching: "undeveloped" is not "developer", "apiary" is not "api"');
ok(suggestCategories('the offices in town').length === 0, 'whole-word matching: "offices" is not "office"');

console.log('\n[negation: "I am not a developer" must not suggest Tech-Savvy]');
const neg = suggestCategories("I'm not a developer, just a regular user of apps");
ok(ids(neg).join() === 'everyday_nontechnical', 'not a developer -> Everyday & Non-Technical only', JSON.stringify(neg));
ok(neg[0].matched.includes('not a developer'), 'and the explanation shows the phrase that triggered it');
ok(ids(suggestCategories('Non-technical founder building a startup')).sort().join() === 'everyday_nontechnical,founders_builders', 'non-technical founder -> Everyday + Founders (no Tech-Savvy)');
ok(!ids(suggestCategories('not tech-savvy at all, I work in an office')).includes('tech_savvy'), '"not tech-savvy" never suggests Tech-Savvy');

console.log('\n[ordering of suggestions]');
const order = suggestCategories('developer engineer programmer and a student');
ok(ids(order)[0] === 'tech_savvy' && ids(order)[1] === 'students_learners', 'most matched words first, ties keep the fixed category order');

console.log('\n[no sensitive attributes are inferred]');
// Static check on the keyword lists: none of them may be a protected / sensitive-attribute word.
const SENSITIVE = ['age', 'aged', 'old', 'young', 'youth', 'senior', 'elderly', 'retired', 'retiree', 'teen', 'teenager', 'child', 'children', 'kid', 'kids', 'parent', 'mother', 'father', 'mom', 'dad', 'married', 'single', 'divorced', 'pregnant', 'religion', 'religious', 'christian', 'muslim', 'jewish', 'hindu', 'buddhist', 'atheist', 'race', 'racial', 'black', 'white', 'asian', 'latino', 'hispanic', 'ethnic', 'ethnicity', 'gender', 'male', 'female', 'man', 'woman', 'men', 'women', 'lgbt', 'gay', 'lesbian', 'trans', 'transgender', 'sexual', 'disabled', 'disability', 'blind', 'deaf', 'autistic', 'autism', 'adhd', 'health', 'sick', 'illness', 'disease', 'cancer', 'depression', 'political', 'politics', 'democrat', 'republican', 'liberal', 'conservative', 'nationality', 'immigrant', 'citizen', 'country', 'income', 'poor', 'rich', 'wealthy', 'union'];
const words = (kw) => kw.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const hits = CATEGORIES.flatMap((c) => c.keywords.flatMap((kw) => words(kw).filter((w) => SENSITIVE.includes(w)).map((w) => `${c.id}:${kw}`)));
ok(hits.length === 0, 'no keyword contains a protected or sensitive-attribute term', hits.join(', '));
// Behavioural check: bios that mention such attributes produce no suggestion from them.
for (const bio of ['I am a 70 year old retired grandmother', 'devout Muslim and proud father of three', 'I have ADHD and live with a disability', 'Proud member of the LGBT community', 'Voted Republican my whole life', 'Immigrant from Brazil, single mom']) {
  ok(suggestCategories(bio).length === 0, `sensitive bio yields nothing: "${bio}"`, JSON.stringify(suggestCategories(bio)));
}
ok(suggestCategories('Retired teacher').length === 0, '"retired" alone suggests nothing (no age inference)');
ok(Array.isArray(suggestCategories('x').map((s) => s.matched)), 'suggestions expose only category + the words found (no scores about people)');
ok(CATEGORIES.every((c) => c.keywords.length >= 8 && new Set(c.keywords).size === c.keywords.length), 'keyword lists are non-trivial and duplicate-free');

console.log('\n[Matching v2 helpers: screening categories and explanations]');
{
  const { SCREENING_CATEGORY_IDS, requiresScreening, SCREENED_LABEL, explainIneligible, shortReason } = await import('../../src/lib/matching.ts');
  ok(JSON.stringify(SCREENING_CATEGORY_IDS) === '["tech_savvy","founders_builders","business_office"]', 'exactly the three professional categories require screening');
  ok(['students_learners', 'everyday_nontechnical'].every((c) => !requiresScreening(c)) && SCREENING_CATEGORY_IDS.every(requiresScreening), 'the two general categories never require screening');
  ok(!requiresScreening('wizards') && !requiresScreening('') && !requiresScreening('__proto__'), 'unknown ids are not "professional"');
  ok(SCREENED_LABEL === 'Screened — self-reported experience' && !/verified|certified|credential/i.test(SCREENED_LABEL), 'the screening badge says self-reported and never "verified"');
  const np = explainIneligible('no_profile', ['tech_savvy', 'students_learners']);
  ok(np.action === 'profile' && /Tech-Savvy Users, Students & Learners/.test(np.body) && /no tester profile/.test(np.body), 'no_profile: asks for a profile and lists the required categories');
  const mm = explainIneligible('category_mismatch', ['business_office']);
  ok(mm.action === 'profile' && /Business & Office Users/.test(mm.body) && /does not include/.test(mm.body), 'category_mismatch: says the profile lacks the categories');
  const sr = explainIneligible('screening_required', ['tech_savvy', 'students_learners'], ['tech_savvy']);
  ok(sr.action === 'screening' && sr.screeningCategory === 'tech_savvy' && /self-reported/.test(sr.body) && /not a verified credential/.test(sr.body), 'screening_required: points at the screening to take and says it is self-reported, not a verified credential');
  ok(explainIneligible('screening_required', ['founders_builders', 'business_office'], ['founders_builders', 'business_office']).screeningCategory === 'founders_builders', 'with several missing screenings the first one is offered');
  ok(explainIneligible('weird', []).action === null && explainIneligible(null, []).action === null, 'an unknown reason gives a safe generic message');
  ok(['no_profile', 'category_mismatch', 'screening_required', null].every((r) => typeof shortReason(r) === 'string' && shortReason(r).length > 3), 'short reasons exist for every code');
  const all = [np, mm, sr].map((e) => e.title + ' ' + e.body).join(' ');
  ok(!/\b(AI|artificial|machine learning)\b/i.test(all), 'no AI claims in any explanation');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
