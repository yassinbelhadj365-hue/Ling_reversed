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
  translation: S, highlight: S, meaning_native: S, meaning_target: S,
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

// The instructions a word lookup and a batch of them (buildBatch) share.
const sentenceRule = (N, which) =>
  `an accurate, natural ${N} translation of ${which} only. It may be an auto-generated caption ` +
  `without punctuation, cut off mid-sentence: translate exactly the words it contains (add punctuation, fix obvious ` +
  `speech-recognition mistakes, ignore tags like [Musique]); never add words from the neighbouring lines of the transcript. `;
const wordRules = (L, N) =>
  `"highlight": the word or words of your "translation" that translate the target, copied exactly as they appear there. ` +
  `"meaning_native": what the target means in this sentence, in ${N}, in one to four words (usually the highlight, in its dictionary form). ` +
  `"meaning_target": a short, simple ${L} explanation like a monolingual learner's dictionary (a simpler synonym or a short paraphrase, at most 12 words). ` +
  `For example (French → English), sentence "il est avocat à paris depuis", target "avocat": translation "He has been a lawyer in Paris since", ` +
  `highlight "lawyer", meaning_native "lawyer"; but with "j'ai mangé un avocat", it is "avocado". `;
const lemmaRules = (N) =>
  `"lemma" and "part_of_speech" (in ${N}) refer to the target word (empty strings for a passage). ` +
  `"multiword_unit": the expression the word belongs to in this sentence ` +
  `(idiom, phrasal or separable verb, fixed phrase), written as it appears in the sentence, or null. `;

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
      `"highlight": an empty string. ` +
      (deep ? `"grammar": its notable structures (tenses, constructions, idioms), in simple ${L}. ` +
        `"examples": 4 new short ${L} sentences using the same structure. ` : '')
    : `the target word or phrase exactly as it is used in the given sentence, not its general dictionary meaning. ` +
      `"translation": ${sentenceRule(N, 'the given sentence')}` + wordRules(L, N) +
      (deep ? `"grammar": its form and why it is used here, in simple ${L}, mentioning common confusions. ` +
        `"examples": 4 short, natural ${L} sentences that use it the same way. ` : '');
  const system =
    `You are a careful ${L} teacher and translator. The text is in ${L}; the learner's native language is ${N}. ` +
    `Use the transcript to understand the situation, the speaker and the topic. Explain ${what}` +
    (deep ? `"examples_native": ${N} translations of "examples", in the same order. Keep "grammar" under 70 words. ` : '') +
    lemmaRules(N) +
    `"same_meaning_as": ${senses.length
      ? `the learner has already met this word with these meanings: ${senses.map((m, k) => `${k + 1}. "${m}"`).join(' ')}. ` +
        'Give the number of the one that is the same meaning as here (the same sense, even if worded differently), or 0 if the meaning here is different. '
      : '0. '}` +
    `Accuracy matters more than style: never guess a meaning that doesn't fit the sentence. Reply with JSON only.`;
  const excerpt = excerptAround(input.transcript, input.sentence, deep ? DEEP_CONTEXT_CHARS : QUICK_CONTEXT_CHARS);
  const user = `${excerpt ? `Transcript, for context only (don't translate it):\n"""\n${excerpt}\n"""\n\n` : ''}` +
    (input.kind === 'passage'
      ? `Passage: "${input.term}"`
      : `Sentence: ${input.sentence}\nTarget: "${input.term}"`);
  return { system, user, schema: deep ? SCHEMA : QUICK_SCHEMA, fast: !deep };
}

// -> {result, source}; throws Error('no-provider') when no AI is set up.
// fresh: skip the cache (Settings' Test button).
export async function explain(input, { depth = 'quick', fresh = false } = {}) {
  const cacheKey = cacheKeyOf(input, depth);
  let cached = !fresh && await db.get('dict', cacheKey);
  // Being looked up with its page right now: that answer is usually only moments away.
  if (!cached && !fresh && pending.has(cacheKey)) {
    await Promise.race([pending.get(cacheKey), new Promise((r) => setTimeout(r, PENDING_WAIT_MS))]);
    cached = await db.get('dict', cacheKey);
  }
  if (cached) return cached.value;
  const { result, model } = await geminiJson(buildPrompt(input, { depth }));
  const value = { result, source: sourceLabel(model) };
  await db.put('dict', { key: cacheKey, value, at: Date.now() });
  await saveSentence(input.kind === 'word' ? input.sentence : input.term, result.translation, value.source);
  return value;
}

const cacheKeyOf = (input, depth) => {
  const { lang, native } = state.settings;
  const senses = input.senses?.length ? `|${hash32(input.senses.join('|'))}` : '';
  return `e|${depth}|${lang}|${native}|${input.kind}|${hash32(input.sentence || '')}|${input.term}${senses}`;
};

// The reader's line translation reuses the same translation of a word's sentence.
async function saveSentence(sentence, translation, source) {
  const { lang, native } = state.settings;
  sentence = (sentence || '').trim();
  if (translation && sentence) {
    await db.put('dict', { key: `s|${lang}|${native}|${hash32(sentence)}`, result: { text: translation, source }, at: Date.now() });
  }
}

// ---------- a page's words looked up ahead of time ----------
// Any AI takes a second or more to answer, but a tap answered from the cache shows at once.
// So when a page (or the next caption lines) appears, its new and LingQ words are looked up
// in a few small batched requests, and each answer is saved under the key explain() reads.

const BATCH = 8;            // words per request: small, so the first answers arrive quickly
const AT_ONCE = 2;          // requests in flight at the same time
const PENDING_WAIT_MS = 2500; // a tap on a word being looked up waits this long for it
const pending = new Map();  // cache key -> promise of its batch

const INT = { type: 'INTEGER' };
const { translation: _sentence, ...ITEM } = QUICK; // each sentence is translated once, not per word
const BATCH_SCHEMA = object({
  sentences: { type: 'ARRAY', items: object({ id: INT, translation: S }) },
  items: { type: 'ARRAY', items: object({ id: INT, ...ITEM }) },
});

// items: [{term, sentence, senses?}]; context: the text around them (the page), not translated.
export function buildBatch(items, context = '') {
  const L = langName(state.settings.lang), N = langName(state.settings.native);
  const sentences = [...new Set(items.map((it) => it.sentence))];
  const system =
    `You are a careful ${L} teacher and translator. The text is in ${L}; the learner's native language is ${N}. ` +
    `Use the context to understand the situation, the speaker and the topic. ` +
    `"sentences": one entry per numbered sentence, with its id. "translation": ${sentenceRule(N, 'that sentence')}` +
    `"items": one entry per numbered item, with its id. Explain the item's target word exactly as it is used in its sentence, ` +
    `not its general dictionary meaning; its "translation" is the translation of its sentence. ` + wordRules(L, N) + lemmaRules(N) +
    `"same_meaning_as": when the item lists meanings the learner has already met, the number of the one that is the same ` +
    `meaning as here (the same sense, even if worded differently), or 0 if the meaning here is different; otherwise 0. ` +
    `Answer every sentence and every item. Accuracy matters more than style: never guess a meaning that doesn't fit the sentence. Reply with JSON only.`;
  const met = (senses) => senses?.length ? ` (met before: ${senses.map((m, k) => `${k + 1}. "${m}"`).join(' ')})` : '';
  const user = `${context ? `Context only (don't translate it):\n"""\n${context.slice(0, QUICK_CONTEXT_CHARS)}\n"""\n\n` : ''}` +
    `Sentences:\n${sentences.map((s, k) => `${k + 1}. ${s}`).join('\n')}\n\n` +
    `Items:\n${items.map((it, k) => `${k + 1}. sentence ${sentences.indexOf(it.sentence) + 1}, target "${it.term}"${met(it.senses)}`).join('\n')}`;
  return { system, user, schema: BATCH_SCHEMA, fast: true, background: true, sentences };
}

// Looks the words up in the background. -> stop(): no further requests (the page changed).
export function prefetch(items, { context = '' } = {}) {
  let stopped = false;
  (async () => {
    const todo = [];
    for (const it of items) {
      const key = cacheKeyOf({ kind: 'word', ...it }, 'quick');
      if (pending.has(key) || todo.some((t) => t.key === key) || await db.get('dict', key)) continue;
      todo.push({ ...it, key });
    }
    const chunks = [];
    for (let i = 0; i < todo.length; i += BATCH) chunks.push(todo.slice(i, i + BATCH));
    let next = 0;
    const worker = async () => { while (!stopped && next < chunks.length) await lookUpBatch(chunks[next++], context); };
    await Promise.all(Array.from({ length: AT_ONCE }, worker));
  })().catch(() => { /* a tap asks by itself */ });
  return () => { stopped = true; };
}

async function lookUpBatch(chunk, context) {
  let done;
  const p = new Promise((r) => { done = r; });
  chunk.forEach((it) => pending.set(it.key, p));
  try {
    const req = buildBatch(chunk, context);
    const { result, model } = await geminiJson(req);
    const source = sourceLabel(model);
    const tr = new Map((result.sentences || []).map((s) => [Number(s.id), String(s.translation || '').trim()]));
    for (const { id, ...fields } of result.items || []) {
      const it = chunk[Number(id) - 1];
      const translation = it && tr.get(req.sentences.indexOf(it.sentence) + 1);
      if (!translation || !fields.meaning_native) continue;
      await db.put('dict', { key: it.key, value: { result: { translation, ...fields }, source }, at: Date.now() });
      await saveSentence(it.sentence, translation, source);
    }
  } catch { /* each tap asks by itself */ } finally {
    chunk.forEach((it) => pending.delete(it.key));
    done();
  }
}
