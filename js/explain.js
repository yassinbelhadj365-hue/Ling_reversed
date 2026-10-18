// One AI answer per tap (ai.js, Google Gemini free tier): the translation of the sentence,
// what the word means *here*, and a short explanation in the language being learned,
// written with the transcript as context. Replaces the old mix of sentence translators,
// bilingual dictionaries and "meaning here" guesses, which often disagreed.
import * as db from './db.js';
import { state, langName } from './state.js';
import { hash32 } from './text.js';
import { geminiJson, sourceLabel } from './ai.js';

const QUICK_CONTEXT_CHARS = 3000;  // enough to know the situation, cheap on every tap
const DEEP_CONTEXT_CHARS = 30000;  // "More detail": a large part of the transcript

const S = { type: 'STRING' };
const LIST = { type: 'ARRAY', items: S };
const object = (properties) => ({ type: 'OBJECT', properties, required: Object.keys(properties) });
// The tap asks only for what the panel shows at once, so the answer is short and quick.
const QUICK = {
  translation: S, meaning_native: S, meaning_target: S,
  lemma: S, part_of_speech: S, multiword_unit: { type: 'STRING', nullable: true },
  same_meaning_as: { type: 'INTEGER' },
};
// "More detail" adds grammar and examples.
export const SCHEMA = object({ ...QUICK, grammar: S, examples: LIST, examples_native: LIST });
export const QUICK_SCHEMA = object(QUICK);

// The part of the transcript around the sentence, at most maxChars long.
export function excerptAround(transcript, sentence, maxChars) {
  if (!transcript) return '';
  if (transcript.length <= maxChars) return transcript;
  const at = Math.max(0, transcript.indexOf(sentence));
  const start = Math.max(0, Math.min(at - Math.floor(maxChars / 2), transcript.length - maxChars));
  return `${start > 0 ? '…' : ''}${transcript.slice(start, start + maxChars)}${start + maxChars < transcript.length ? '…' : ''}`;
}

// input: {kind: 'word' | 'passage', term, sentence, transcript, senses?}
// senses: meanings of the word the learner has already met elsewhere (state.recordSense).
export function buildPrompt(input, { depth = 'quick' } = {}) {
  const L = langName(state.settings.lang), N = langName(state.settings.native);
  const deep = depth === 'deep';
  const senses = input.kind === 'word' ? input.senses || [] : [];
  const what = input.kind === 'passage'
    ? `the selected passage. "translation": an accurate, natural ${N} translation of the passage. ` +
      `"meaning_native": what it means and implies, in ${N} (one sentence). ` +
      `"meaning_target": the same idea said again in simpler ${L} (one sentence). ` +
      (deep ? `"grammar": its notable structures (tenses, constructions, idioms), in simple ${L}. ` +
        `"examples": 4 new short ${L} sentences using the same structure. ` : '')
    : `the target word or phrase exactly as it is used in the given sentence, not its general dictionary meaning. ` +
      `"translation": an accurate, natural ${N} translation of the whole sentence. ` +
      `"meaning_native": what the target means in this sentence, in ${N}, in one to four words (the words you used for it in the translation). ` +
      `"meaning_target": a short, simple ${L} explanation like a monolingual learner's dictionary (a simpler synonym or a short paraphrase, at most 12 words). ` +
      (deep ? `"grammar": its form and why it is used here, in simple ${L}, mentioning common confusions. ` +
        `"examples": 4 short, natural ${L} sentences that use it the same way. ` : '');
  const system =
    `You are a careful ${L} teacher and translator. The learner's native language is ${N}. ` +
    `Use the transcript to understand the situation, the speaker and the topic. Explain ${what}` +
    (deep ? `"examples_native": ${N} translations of "examples", in the same order. Keep "grammar" under 70 words. ` : '') +
    `"lemma" and "part_of_speech" (in ${N}) refer to the target word (empty strings for a passage). ` +
    `"multiword_unit": the expression the word belongs to in this sentence ` +
    `(idiom, phrasal or separable verb, fixed phrase), written as it appears in the sentence, or null. ` +
    `"same_meaning_as": ${senses.length
      ? `the learner has already met this word with these meanings: ${senses.map((m, k) => `${k + 1}. "${m}"`).join(' ')}. ` +
        'Give the number of the one that is the same meaning as here (the same sense, even if worded differently), or 0 if the meaning here is different. '
      : '0. '}` +
    `Accuracy matters more than style: never guess a meaning that doesn't fit the sentence. Reply with JSON only.`;
  const excerpt = excerptAround(input.transcript, input.sentence, deep ? DEEP_CONTEXT_CHARS : QUICK_CONTEXT_CHARS);
  const user = `${excerpt ? `Transcript:\n"""\n${excerpt}\n"""\n\n` : ''}` +
    (input.kind === 'passage'
      ? `Passage: "${input.term}"`
      : `Sentence: ${input.sentence}\nTarget: "${input.term}"`);
  return { system, user, schema: deep ? SCHEMA : QUICK_SCHEMA, fast: !deep };
}

// -> {result, source}; throws Error('no-provider') when no AI is set up.
// fresh: skip the cache (Settings' Test button).
export async function explain(input, { depth = 'quick', fresh = false } = {}) {
  const { lang, native } = state.settings;
  const senses = input.senses?.length ? `|${hash32(input.senses.join('|'))}` : '';
  const cacheKey = `e|${depth}|${lang}|${native}|${input.kind}|${hash32(input.sentence || '')}|${input.term}${senses}`;
  const cached = !fresh && await db.get('dict', cacheKey);
  if (cached) return cached.value;
  const { result, model } = await geminiJson(buildPrompt(input, { depth }));
  const value = { result, source: sourceLabel(model) };
  await db.put('dict', { key: cacheKey, value, at: Date.now() });
  // The reader's line translation reuses the same translation of a word's sentence.
  const sentence = (input.kind === 'word' ? input.sentence : input.term || '').trim();
  if (result.translation && sentence) {
    await db.put('dict', { key: `s|${lang}|${native}|${hash32(sentence)}`, result: { text: result.translation, source: value.source }, at: Date.now() });
  }
  return value;
}
