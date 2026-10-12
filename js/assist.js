// "Still unclear?" escalation beyond the free layers. Everything here is free or
// uses the user's existing subscription; paid models are never offered.
//   1. a stronger model through OpenRouter: only `:free` models (free account key, no card)
//   2. DeepSeek's free web chat and ChatGPT (the user's subscription), opened in the
//      browser with the question written for them
// The OpenRouter key is stored only in this browser (kv `secret:openrouter`, excluded from backups).
import * as db from './db.js';
import { state, langName } from './state.js';
import { hash32 } from './text.js';

const API = 'https://openrouter.ai/api/v1';
const KEY_ROW = 'secret:openrouter';
// Preferred free models, strongest first; the live list decides what's actually offered.
const PREFERRED_FREE = ['nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free'];

export const getKey = () => db.getSetting(KEY_ROW, '');
export const setKey = (k) => db.setSetting(KEY_ROW, k.trim());

const isFree = (id) => /:free$/.test(id || '');

// -> [{id, name}] the free text models currently on OpenRouter, strongest preferred first.
export async function listModels() {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`OpenRouter: ${res.status}`);
  const { data } = await res.json();
  const rank = (m) => PREFERRED_FREE.indexOf(m.id) + 1 || 50;
  return data
    .filter((m) => isFree(m.id) && Number(m.pricing?.prompt || 0) === 0 && Number(m.pricing?.completion || 0) === 0)
    .filter((m) => !/content-safety|code|vision|omni/i.test(m.id))
    .map((m) => ({ id: m.id, name: m.name || m.id }))
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export async function defaultModel() {
  if (isFree(state.settings.assistModel)) return state.settings.assistModel;
  try { return (await listModels())[0]?.id || PREFERRED_FREE[0]; } catch { return PREFERRED_FREE[0]; }
}

function promptFor({ term, sentence, prev, next }) {
  const L = langName(state.settings.lang), N = langName(state.settings.native);
  return {
    system:
      `You are a patient ${L} tutor. The learner's native language is ${N}. They looked up a word, read the ` +
      `dictionary and a translation, and still don't understand how it's used in this sentence. Explain it ` +
      `precisely for this sentence, in ${N}. Reply with JSON only, no markdown, with these keys: ` +
      `"gloss_in_context" (the meaning here, a few words), "lemma", "part_of_speech", ` +
      `"grammar_note" (form and why it's used here, max 40 words), "multiword_unit" (the expression it belongs to, or null), ` +
      `"explanation" (2-4 sentences: what it adds to this sentence, nuance, common confusions), ` +
      `"example" (one short new ${L} sentence using it the same way, with its ${N} translation).`,
    user: `${prev ? `Previous line: ${prev}\n` : ''}Sentence: ${sentence}\n${next ? `Next line: ${next}\n` : ''}Word: "${term}"`,
  };
}

// Lenient JSON: models sometimes wrap it in ``` fences or add reasoning before it.
export function parseJsonReply(text) {
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model didn’t return an explanation. Try again or pick another model.');
  return JSON.parse(clean.slice(start, end + 1));
}

// -> {result, model} ; throws Error with a user-facing message.
export async function askStronger(input) {
  if (window.__lingoAssist) return window.__lingoAssist(input); // smoke-test hook
  const key = await getKey();
  if (!key) throw new Error('Add your free OpenRouter key in Settings first.');
  const model = await defaultModel();
  if (!isFree(model)) throw new Error('Only free models are allowed. Pick one in Settings.'); // never spend money
  const cacheKey = `a|${model}|${state.settings.native}|${hash32(input.sentence)}|${input.term}`;
  const cached = await db.get('dict', cacheKey);
  if (cached) return { result: cached.result, model };
  const p = promptFor(input);
  let res;
  try {
    res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': 'Lingo Reader',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }],
      }),
    });
  } catch {
    throw new Error('Couldn’t reach OpenRouter (offline?).');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.statusText;
    if (res.status === 401) throw new Error('OpenRouter rejected the key. Check it in Settings.');
    if (res.status === 429) throw new Error('This free model is busy or you hit its daily limit. Try again later, or pick another model in Settings.');
    if (res.status === 402 || res.status === 404) throw new Error('This free model is no longer available. Pick another free model in Settings.');
    throw new Error(`OpenRouter: ${msg}`);
  }
  const result = parseJsonReply(data.choices?.[0]?.message?.content);
  await db.put('dict', { key: cacheKey, result, at: Date.now() });
  return { result, model };
}

// ChatGPT with the user's own subscription: open chatgpt.com with the question
// prefilled (and copy it, in case the prefill isn't picked up).
export function chatGptPrompt({ term, sentence, prev, next }) {
  const L = langName(state.settings.lang), N = langName(state.settings.native);
  return `I'm learning ${L} and I don't understand the word "${term}" in this sentence:\n\n"${sentence}"\n\n` +
    `${prev || next ? `Context around it: ${[prev, '[…]', next].filter(Boolean).join(' ')}\n\n` : ''}` +
    `Please explain in ${N}: what "${term}" means exactly here, its grammar (base form and why this form is used), ` +
    `whether it's part of an expression, and give 2 short example sentences in ${L} using it the same way, with translations.`;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// Returns whether the question was copied to the clipboard.
export async function openChatGpt(input) {
  const text = chatGptPrompt(input);
  const copied = await copy(text); // backup in case the prefill isn't picked up
  window.open(`https://chatgpt.com/?q=${encodeURIComponent(text)}`, '_blank', 'noopener');
  return copied;
}

// DeepSeek's web chat is free but can't be prefilled: copy the question, then open it.
export async function openDeepSeek(input) {
  const copied = await copy(chatGptPrompt(input));
  window.open('https://chat.deepseek.com/', '_blank', 'noopener');
  return copied;
}
