// Free AI help beyond the on-device layers. Everything here is free or uses the
// user's existing subscription; paid models are never offered.
//   1. OpenRouter free models (`:free` only; free account key, no card) — used by explain.js
//   2. DeepSeek's free web chat and ChatGPT (the user's subscription), opened in the
//      browser with the question written for them
// The OpenRouter key is stored only in this browser (kv `secret:openrouter`, excluded from backups).
import * as db from './db.js';
import { state, langName } from './state.js';

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

// Lenient JSON: models sometimes wrap it in ``` fences or add reasoning before it.
export function parseJsonReply(text) {
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model didn’t return an explanation. Try again or pick another model.');
  return JSON.parse(clean.slice(start, end + 1));
}

// One request to a free OpenRouter model that answers in JSON.
// -> {result, model} ; throws Error with a user-facing message.
export async function openRouterJson({ system, user }) {
  if (window.__lingoAssist) return window.__lingoAssist({ system, user }); // smoke-test hook
  const key = await getKey();
  if (!key) throw new Error('Add your free OpenRouter key in Settings first.');
  const model = await defaultModel();
  if (!isFree(model)) throw new Error('Only free models are allowed. Pick one in Settings.'); // never spend money
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
        max_tokens: 1600,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
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
  return { result: parseJsonReply(data.choices?.[0]?.message?.content), model };
}

// ---------- hand-offs to chat websites ----------

const CHATGPT_CONTEXT_CHARS = 2500;  // the question travels in the URL, so keep it short
const DEEPSEEK_CONTEXT_CHARS = 30000; // pasted from the clipboard: the whole transcript fits

function excerpt(transcript, sentence, max) {
  if (!transcript || transcript.length <= max) return transcript || '';
  const at = Math.max(0, transcript.indexOf(sentence));
  const start = Math.max(0, Math.min(at - Math.floor(max / 2), transcript.length - max));
  return `…${transcript.slice(start, start + max)}…`;
}

// The question for ChatGPT / DeepSeek: explanation in the target language first,
// with example sentences, then the native-language version.
// input: {kind: 'word' | 'passage', term, sentence, transcript}
export function handoffPrompt(input, maxChars) {
  const L = langName(state.settings.lang), N = langName(state.settings.native);
  const ctx = excerpt(input.transcript, input.sentence, maxChars);
  const ask = input.kind === 'passage'
    ? `I don't fully understand this passage:\n\n"${input.term}"`
    : `I don't understand "${input.term}" in this sentence:\n\n"${input.sentence}"`;
  return `I'm learning ${L} (my native language is ${N}). It comes from a video I'm watching. ${ask}\n\n` +
    `Please answer in this order:\n` +
    `1. Explain it in simple ${L}, the way a teacher would explain it in ${L} (meaning here, a simpler paraphrase).\n` +
    `2. Explain the grammar or structure in simple ${L}.\n` +
    `3. Give 4 natural example sentences in ${L} that use ${input.kind === 'passage' ? 'the same structure' : 'it the same way'} (typical uses).\n` +
    `4. Then, under a heading "${N}", translate the explanation and the examples, and the ${input.kind === 'passage' ? 'passage' : 'sentence'}.` +
    `${ctx ? `\n\nTranscript, for context:\n"""\n${ctx}\n"""` : ''}`;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// Opens a ChatGPT temporary (private) chat — not saved in the history — with the
// question prefilled. Also copies it, in case the prefill isn't picked up.
export async function openChatGpt(input) {
  const text = handoffPrompt(input, CHATGPT_CONTEXT_CHARS);
  const copied = await copyText(text);
  window.open(`https://chatgpt.com/?temporary-chat=true&q=${encodeURIComponent(text)}`, '_blank', 'noopener');
  return { text, copied };
}

// DeepSeek's web chat is free but can't be prefilled: copy the question (with the
// whole transcript), then open it so the user can paste.
export async function openDeepSeek(input) {
  const text = handoffPrompt(input, DEEPSEEK_CONTEXT_CHARS);
  const copied = await copyText(text);
  window.open('https://chat.deepseek.com/', '_blank', 'noopener');
  return { text, copied };
}
