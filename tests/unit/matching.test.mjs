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
console.log('\n[professional vs general categories]');
{
  const { PROFESSIONAL_CATEGORY_IDS, isProfessional, ASSESSMENT_NOTE } = await import('../../src/lib/matching.ts');
  ok(JSON.stringify(PROFESSIONAL_CATEGORY_IDS) === '["tech_savvy","founders_builders","business_office"]', 'exactly the three professional categories are assessed');
  ok(['students_learners', 'everyday_nontechnical'].every((c) => !isProfessional(c)) && PROFESSIONAL_CATEGORY_IDS.every(isProfessional), 'the two general categories are never "professional"');
  ok(!isProfessional('wizards') && !isProfessional('') && !isProfessional('__proto__'), 'unknown ids are not professional');
  ok(/does not verify/i.test(ASSESSMENT_NOTE) && /self|own written/i.test(ASSESSMENT_NOTE), 'the assessment note says nothing is verified');
}

console.log('\n[answer validation mirrors the server]');
{
  const { validateAnswer, validateAnswers, ANSWER_MIN, ANSWER_MAX } = await import('../../src/lib/matching.ts');
  ok(ANSWER_MIN === 15 && ANSWER_MAX === 800, 'limits are 15..800 characters');
  ok(validateAnswer('') !== null && validateAnswer('   ') !== null && validateAnswer('a b c d e f g') !== null, 'empty, blank and 13-character answers are rejected');
  ok(validateAnswer('one two three x') === null, 'exactly 15 characters with enough words is accepted');
  ok(validateAnswer('x'.repeat(60)) !== null && validateAnswer('Python programming') !== null, 'a single long word / two words are rejected');
  ok(validateAnswer('yes yes yes yes yes yes yes') !== null, 'three or more words but fewer than three DIFFERENT words are rejected');
  ok(validateAnswer(('word ').repeat(160) + 'z') !== null, 'over 800 characters is rejected');
  ok(validateAnswer('Привет я изучаю программирование и дизайн') === null, 'non-ASCII text is accepted');
  ok(validateAnswer('valid looking text \u0007 with a bell char') !== null, 'control characters are rejected');
  ok(validateAnswer('  lots   of\n\nspaces and   line breaks here ') === null, 'whitespace is normalised before measuring');
  const ids = ['q1', 'q2', 'q3', 'q4'];
  const good = { q1: 'I use these tools every day', q2: 'A project where I built things', q3: 'Something broke so I read logs', q4: 'Products I enjoy testing a lot' };
  ok(validateAnswers(ids, good).ok === true, 'four good answers are ok');
  ok(validateAnswers(ids, { ...good, q3: '' }).errors.q3 && !validateAnswers(ids, { ...good, q3: '' }).ok, 'a missing answer is reported on its own question');
  const dup = validateAnswers(ids, { q1: 'the same words here', q2: 'The Same Words Here', q3: good.q3, q4: good.q4 });
  ok(dup.duplicate === true && dup.ok === false, 'duplicate answers are flagged');
  ok(Object.keys(validateAnswers(ids, {}).errors).length === 4, 'no answers: all four are reported');
}

console.log('\n[status wording: never "verified"]');
{
  const { experienceBadge } = await import('../../src/lib/matching.ts');
  const mk = (state, reason, extra = {}) => ({ state, reason, requires_assessment: true, qualification: null, ...extra });
  ok(experienceBadge(mk('inactive', 'not_selected')) === null, 'not selected: no badge');
  ok(experienceBadge(mk('incomplete', 'answers_needed')).kind === 'incomplete' && /four answers needed/.test(experienceBadge(mk('incomplete', 'answers_needed')).text), 'incomplete: asks for four answers');
  ok(/questions were updated/.test(experienceBadge(mk('incomplete', 'questions_changed')).text), 'outdated answers: says the questions were updated');
  ok(experienceBadge(mk('pending_assessment', 'consent_required')).kind === 'pending' && /permission/.test(experienceBadge(mk('pending_assessment', 'consent_required')).text), 'professional with answers but no consent: pending, needs permission');
  ok(/answers received/.test(experienceBadge(mk('pending_assessment', 'awaiting_assessment')).text), 'with consent: pending assessment');
  ok(experienceBadge(mk('not_qualified', 'not_qualified')).kind === 'warn', 'not_qualified is a warning with a way forward');
  ok(experienceBadge({ state: 'active', reason: 'active', requires_assessment: false, qualification: null }).text === 'Active', 'a general category is simply Active');
  ok(/qualified by assessment/.test(experienceBadge(mk('active', 'active', { qualification: { status: 'qualified', source: 'ai_assessment' } })).text), 'professional: "qualified by assessment"');
  ok(!/earlier screening/i.test(experienceBadge(mk('active', 'active', { qualification: { status: 'qualified', source: 'ai_assessment' } })).text), 'there is no "earlier screening" status any more: only an assessment activates a professional category');
  const all = ['inactive', 'incomplete', 'pending_assessment', 'not_qualified', 'active'].flatMap((s) => ['answers_needed', 'consent_required', 'active'].map((r) => experienceBadge(mk(s, r))?.text ?? '')).join(' ');
  ok(!/\b(verified|certified|accredited|validated)\b/i.test(all), 'no badge text claims verification');
}

console.log('\n[explanations of why a task cannot be started]');
{
  const { explainIneligible, shortReason } = await import('../../src/lib/matching.ts');
  const pi = explainIneligible('profile_incomplete', []);
  ok(pi.action === 'profile' && /four short questions|four/.test(pi.body) && /still request tests/.test(pi.body), 'profile_incomplete: asks to complete the profile and says requesting tests still works');
  ok(explainIneligible('no_profile', []).action === 'profile', 'the legacy no_profile code is explained the same way');
  const mm = explainIneligible('category_mismatch', ['business_office']);
  ok(mm.action === 'profile' && /Business & Office Users/.test(mm.body) && /does not include/.test(mm.body), 'category_mismatch: says the profile lacks the categories');
  const qr = explainIneligible('qualification_required', ['tech_savvy', 'students_learners'], ['tech_savvy']);
  ok(qr.action === 'answers' && qr.answersCategory === 'tech_savvy' && /not a verified credential/.test(qr.body) && /does not qualify you/.test(qr.body), 'qualification_required: points at the category to complete and says it is self-reported');
  ok(explainIneligible('screening_required', ['founders_builders'], ['founders_builders']).answersCategory === 'founders_builders', 'the legacy screening_required code maps to the same explanation');
  ok(explainIneligible('weird', []).action === null && explainIneligible(null, []).action === null, 'an unknown reason gives a safe generic message');
  ok(['profile_incomplete', 'no_profile', 'category_mismatch', 'qualification_required', 'screening_required', null].every((r) => typeof shortReason(r) === 'string' && shortReason(r).length > 3), 'short reasons exist for every code');
  const all = [pi, mm, qr].map((e) => e.title + ' ' + e.body).join(' ');
  ok(!/\b(AI|artificial|machine learning)\b/i.test(all), 'no AI claims in any explanation');
}

console.log('\n[AI contract types are importable and the recommendation seam is honest]');
{
  const c = await import('../../src/lib/aiContract.ts');
  ok(c.AI_CONTRACT_VERSION === 1, 'contract version 1');
  const r = await import('../../src/lib/recommendations.ts');
  const out = await r.fetchRecommendations();
  ok(out.status === 'unavailable' && !('items' in out), 'until the AI service exists the provider says "unavailable" and invents nothing');
}

console.log('\n[recommendations: only actionable, eligible campaigns are ever shown]');
{
  const { actionableRecommendations } = await import('../../src/lib/recommendations.ts');
  const eligible = new Set(['c1', 'c2', 'c3']);
  const items = [
    { campaign_id: 'c2', reason: 'You described invoicing tools', score: 0.9 },
    { campaign_id: 'x9', reason: 'a targeted task the tester cannot reserve' },
    { campaign_id: 'c2', reason: 'duplicate' },
    { campaign_id: 'c1', reason: 'fits your project work' },
  ];
  const out = actionableRecommendations({ status: 'ok', generated_at: 'now', profile_etag: 'e', items }, eligible);
  ok(JSON.stringify(out.map((r) => r.campaign_id)) === '["c2","c1"]', 'ineligible / unknown campaigns are dropped, duplicates collapse, the service order is kept');
  ok(out[0].score === 0.9 && out[1].score === undefined, 'optional score passes through');
  ok(actionableRecommendations({ status: 'ok', generated_at: 'now', profile_etag: 'e', items: [] }, eligible).length === 0, 'an ok response with no items is an empty list (honest empty state)');
  ok(actionableRecommendations({ status: 'ok', generated_at: 'now', profile_etag: 'e', items: [{ campaign_id: 'x9', reason: 'r' }] }, eligible).length === 0, 'a response that only names ineligible campaigns becomes empty');
  ok(['unavailable', 'consent_required', 'profile_incomplete'].every((s) => actionableRecommendations({ status: s }, eligible).length === 0), 'non-ok statuses never yield items');
  ok(actionableRecommendations({ status: 'ok', generated_at: 'now', profile_etag: 'e', items: 'not-an-array' }, eligible).length === 0 && actionableRecommendations({ status: 'ok', generated_at: 'now', profile_etag: 'e', items: [null, 5, {}] }, eligible).length === 0, 'malformed responses cannot crash the page or inject items');
  ok(actionableRecommendations({ status: 'ok', generated_at: 'now', profile_etag: 'e', items: [{ campaign_id: 'c1', reason: 'x'.repeat(1000) }] }, eligible)[0].reason.length === 280, 'an over-long reason is truncated');
}

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
