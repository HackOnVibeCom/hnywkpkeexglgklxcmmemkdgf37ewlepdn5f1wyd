// Deterministic detection of text that tries to instruct the model instead of describing something. It is a SECOND line of
// defence next to the prompt wording, the model's own `instruction_like_text` flag and the code-level grounding in validate.ts.
// It is a HINT, not a verdict: deliberately narrow so that ordinary work vocabulary ("I score each lead in the CRM", "I write
// system prompts for bots", "I override the default business rules") is NOT flagged, and it is NOT the thing that decides
// qualification (grounded evidence + the model's judgement do).
//
//  * Campaign text that looks like an instruction is NEVER evaluated by the model for matching (it can still be browsed):
//    a founder cannot steer the model, and a legitimate batch of relevant campaigns is NOT penalised.
//  * Tester answers that look like an instruction are not assessed in that run: the tester is asked to rewrite them neutrally.
//
// Text is Unicode-normalised (NFKC) and stripped of invisible format characters first, so zero-width tricks and look-alike
// letters do not bypass it. English, Ukrainian and Russian phrasings are covered; other languages are not (the grounding rules
// and the model flag still apply there).

import { cleanText } from './util.ts';

const TARGET = String.raw`(?:me|this|my\s+answers?|my\s+profile|this\s+(?:tester|campaign|candidate|applicant|profile|answer|answers)|every\s+(?:tester|campaign|candidate)|all\s+(?:testers|campaigns|candidates))`;
const VERDICT = String.raw`(?:qualified|approved|an?\s+expert|expert|strong(?:\s+match)?|a\s+perfect\s+match|perfect|top|best)`;

const PATTERNS: readonly RegExp[] = [
  // "ignore all previous instructions", "disregard the above rules", "forget earlier prompts"
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(?:instruction|prompt|rule|message|guideline)s?\b/i,
  // role / channel markers at the start of a line ("System: ...", "Assistant: ...")
  /(?:^|\n)\s*(?:system|assistant|developer)\s*:/i,
  // "mark me as qualified", "rate this campaign as strong", "recommend this to every tester"
  new RegExp(String.raw`\b(?:mark|rate|label|rank|classify|approve|grade|score)\s+${TARGET}\s+(?:as|with|a|an)?\s*${VERDICT}\b`, 'i'),
  new RegExp(String.raw`\b(?:consider|treat|count|regard)\s+${TARGET}\s+(?:as\s+)?${VERDICT}\b`, 'i'),
  new RegExp(String.raw`\b(?:you\s+(?:must|should|will|have to)|please|always)\s+(?:mark|rate|label|rank|output|return|respond|answer|say|classify)\b[^.\n]{0,40}\b${VERDICT}\b`, 'i'),
  /\brecommend\b[^.\n]{0,40}\b(?:to|for)\b[^.\n]{0,25}\b(?:every|all)\b[^.\n]{0,15}\b(?:tester|user|person|one)s?\b/i,
  // "you are now an ..." / "act as ..." / "pretend to be ..."
  /\b(?:you are now|act as|pretend (?:to be|you are)|from now on you)\b/i,
  // asks for the prompt or secrets
  /\b(?:reveal|print|show|repeat|output)\b[^.\n]{0,30}\b(?:system prompt|your instructions|your prompt|api key)\b/i,
  // Ukrainian / Russian
  /(?:ігноруй|ігноруйте|проігноруй|забудь|забудьте)[^.\n]{0,40}(?:інструкці|правил|промпт|вказівк)/i,
  /(?:игнорируй|игнорируйте|проигнорируй|забудь|забудьте)[^.\n]{0,40}(?:инструкци|правил|промпт|указани)/i,
  /(?:познач|признай|вважай|оціни)[^.\n]{0,20}(?:мене|цього\s+тестера)[^.\n]{0,25}(?:кваліфіковани|експерт|схвален)/i,
  /(?:отметь|пометь|признай|считай|оцени)[^.\n]{0,20}(?:меня|этого\s+тестера)[^.\n]{0,25}(?:квалифицирован|эксперт|одобрен)/i,
];

export function looksLikeInstruction(text: unknown): boolean {
  if (typeof text !== 'string' || text === '') return false;
  const t = cleanText(text, 20_000);
  return PATTERNS.some((re) => re.test(t));
}
