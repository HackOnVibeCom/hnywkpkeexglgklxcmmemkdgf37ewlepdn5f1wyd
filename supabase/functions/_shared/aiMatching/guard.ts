// Deterministic detection of text that tries to instruct the model instead of describing something. It is a SECOND line of
// defence next to the prompt wording and the code-level grounding in validate.ts, and it is deliberately narrow so that
// ordinary descriptions are not flagged.
//
//  * Campaign text that looks like an instruction is NEVER evaluated by the model for matching (it can still be browsed):
//    a founder cannot steer the model, and a legitimate batch of relevant campaigns is NOT penalised.
//  * Tester answers that look like an instruction are never assessed as qualifying: the tester is asked to describe their
//    experience in their own words.

const PATTERNS: readonly RegExp[] = [
  // "ignore all previous instructions", "disregard the above rules", "forget earlier prompts"
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(?:instruction|prompt|rule|message|guideline)s?\b/i,
  // role / channel markers
  /\b(?:system|assistant|developer)\s*(?:prompt|message|instruction)s?\b/i,
  /(?:^|\n)\s*(?:system|assistant|developer)\s*:/i,
  // "mark/rate/label this (campaign|answer|me) as strong/qualified/..."
  /\b(?:mark|rate|label|rank|score|classify|set|output|return|respond|answer)\b[^.\n]{0,40}\b(?:this|me|it|everyone|every|all|each)\b[^.\n]{0,40}\b(?:as\s+|with\s+|:\s*)?(?:qualified|approved|strong|good|relevant|best|perfect|top)\b/i,
  // "recommend (this) to every/all testers"
  /\brecommend\b[^.\n]{0,40}\b(?:to|for)\b[^.\n]{0,25}\b(?:every|all)\b/i,
  // "you are now an ..." / "act as ..." / "pretend to be ..."
  /\b(?:you are now|act as|pretend (?:to be|you are)|from now on you)\b/i,
  // asks for the prompt or secrets
  /\b(?:reveal|print|show|repeat|output)\b[^.\n]{0,30}\b(?:system prompt|instructions|your prompt|api key)\b/i,
];

export function looksLikeInstruction(text: unknown): boolean {
  if (typeof text !== 'string' || text === '') return false;
  return PATTERNS.some((re) => re.test(text));
}
