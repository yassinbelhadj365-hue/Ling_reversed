// AI explanations of a word, phrase or passage *in context*, written first in the
// language being learned (simple, direct-method style) and second in the native
// language (shown only on request). Free providers only:
//   - Chrome's built-in Gemini Nano (on-device), for quick explanations
//   - OpenRouter free models (assist.js), for quick explanations when Nano isn't
//     available and for "deeper" ones that read a large part of the transcript
import * as db from './db.js';
import { state, langName } from './state.js';
import { hash32 } from './text.js';
import { getKey, openRouterJson } from './assist.js';

const NANO_CONTEXT_CHARS = 1200;   // Gemini Nano has a small context window
const CLOUD_CONTEXT_CHARS = 30000; // free cloud models read much more of the transcript

export const SCHEMA = {
  type: 'object',
  properties: {
    target: {
      type: 'object',
      properties: {
        meaning: { type: 'string' },
        grammar: { type: 'string' },
        examples: { type: 'array', items: { type: 'string' } },
      },
      required: ['meaning', 'grammar', 'examples'],
    },
    native: {
      type: 'object',
      properties: {
        meaning: { type: 'string' },
        grammar: { type: 'string' },
        translation: { type: 'string' },
        examples: { type: 'array', items: { type: 'string' } },
      },
      required: ['meaning', 'grammar', 'translation', 'examples'],
    },
    lemma: { type: 'string' },
    part_of_speech: { type: 'string' },
    multiword_unit: { type: ['string', 'null'] },
  },
  required: ['target', 'native', 'lemma', 'part_of_speech', 'multiword_unit'],
};

// The part of the transcript around the sentence, at most maxChars long.
export function excerptAround(transcript, sentence, maxChars) {
  if (!transcript) return '';
  if (transcript.length <= maxChars) return transcript;
  const at = Math.max(0, transcript.indexOf(sentence));
  const start = Math.max(0, Math.min(at - Math.floor(maxChars / 2), transcript.length - maxChars));
  return `${start > 0 ? '…' : ''}${transcript.slice(start, start + maxChars)}${start + maxChars < transcript.length ? '…' : ''}`;
}

// input: {kind: 'word' | 'passage', term, sentence, transcript}
export function buildPrompt(input, { depth = 'quick', contextChars = CLOUD_CONTEXT_CHARS } = {}) {
  const L = langName(state.settings.lang), N = langName(state.settings.native);
  const nEx = depth === 'deep' ? 4 : 3;
  const what = input.kind === 'passage'
    ? `the selected passage. "target.meaning": say the same thing again in simpler ${L}. ` +
      `"target.grammar": explain its structure (tenses, constructions, idioms) in simple ${L}. ` +
      `"native.translation": a natural ${N} translation of the passage. "native.meaning": what it means and implies, in ${N}. ` +
      `"native.grammar": the same structure explanation in ${N}. "target.examples": ${nEx} new short ${L} sentences that use the same structure.`
    : `the target word or phrase exactly as it is used in the given sentence (not its general dictionary meaning). ` +
      `"target.meaning": explain it in simple ${L}, like a monolingual learner's dictionary, using a simpler synonym or paraphrase. ` +
      `"target.grammar": its form and why it is used here, in simple ${L}. ` +
      `"native.meaning": the meaning here in ${N} (a few words). "native.grammar": the same note in ${N}. ` +
      `"native.translation": a ${N} translation of the whole sentence. ` +
      `"target.examples": ${nEx} short, natural ${L} sentences that use it the same way (typical uses, collocations).`;
  const system =
    `You are a patient ${L} teacher who teaches through the language itself. The learner's native language is ${N}. ` +
    `Use the transcript to understand the situation, the speaker and the topic. Explain ${what} ` +
    `"native.examples": ${N} translations of target.examples, in the same order. ` +
    `Keep grammar notes under ${depth === 'deep' ? 70 : 40} words. "lemma" and "part_of_speech" refer to the target word ` +
    `(empty strings for a passage). "multiword_unit": the expression the word belongs to (idiom, phrasal or separable verb, fixed phrase), or null. ` +
    `${depth === 'deep' ? 'The learner already saw a short explanation and is still confused: be more thorough and mention common confusions. ' : ''}` +
    `Reply with JSON only, matching this shape: {"target":{"meaning":"","grammar":"","examples":[]},"native":{"meaning":"","grammar":"","translation":"","examples":[]},"lemma":"","part_of_speech":"","multiword_unit":null}`;
  const excerpt = excerptAround(input.transcript, input.sentence, contextChars);
  const user = `${excerpt ? `Transcript:\n"""\n${excerpt}\n"""\n\n` : ''}` +
    (input.kind === 'passage'
      ? `Passage: "${input.term}"`
      : `Sentence: ${input.sentence}\nTarget: "${input.term}"`);
  return { system, user };
}

// ---------- Gemini Nano (Chrome's built-in Prompt API) ----------

// 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported'
export async function aiStatus() {
  if (window.__lingoAI) return 'available'; // smoke-test hook
  if (!('LanguageModel' in self)) return 'unsupported';
  try { return await self.LanguageModel.availability(); } catch { return 'unsupported'; }
}

const nanoSessions = new Map(); // `${lang}|${native}|${kind}` -> session | 'unsupported'

async function nano(input, onProgress) {
  const { lang, native } = state.settings;
  const key = `${lang}|${native}|${input.kind}`;
  let base = nanoSessions.get(key);
  if (base === 'unsupported') return null;
  const p = buildPrompt(input, { contextChars: NANO_CONTEXT_CHARS });
  if (!base) {
    try {
      base = await self.LanguageModel.create({
        initialPrompts: [{ role: 'system', content: p.system }],
        expectedInputs: [{ type: 'text', languages: [lang, native] }],
        expectedOutputs: [{ type: 'text', languages: [lang, native] }],
        monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded)); },
      });
    } catch {
      nanoSessions.set(key, 'unsupported'); // e.g. the model can't write this language
      return null;
    }
    nanoSessions.set(key, base);
  }
  const s = await base.clone();
  try {
    return JSON.parse(await s.prompt(p.user, { responseConstraint: SCHEMA }));
  } finally {
    s.destroy();
  }
}

// ---------- entry point ----------

// -> {result, source} ; throws Error('no-provider') when no free AI is set up.
// depth 'quick': Gemini Nano, else a free cloud model. 'deep': a free cloud model.
export async function explain(input, { depth = 'quick', onProgress } = {}) {
  const { lang, native } = state.settings;
  const cacheKey = `e|${depth}|${lang}|${native}|${input.kind}|${hash32(input.sentence || '')}|${input.term}`;
  const cached = await db.get('dict', cacheKey);
  if (cached) return cached.value;
  let value = null;
  if (depth === 'quick') {
    if (window.__lingoAI) value = { result: await window.__lingoAI(input), source: 'On-device AI' }; // smoke-test hook
    else if ((await aiStatus()) !== 'unsupported' && (await aiStatus()) !== 'unavailable') {
      const result = await nano(input, onProgress).catch(() => null);
      if (result) value = { result, source: 'On-device AI (Gemini Nano)' };
    }
  }
  if (!value) {
    if (!window.__lingoAssist && !(await getKey())) throw new Error('no-provider');
    const { result, model } = await openRouterJson(buildPrompt(input, { depth }));
    value = { result, source: `${model.split('/').pop().replace(/:free$/, '')} (free)` };
  }
  await db.put('dict', { key: cacheKey, value, at: Date.now() });
  return value;
}
