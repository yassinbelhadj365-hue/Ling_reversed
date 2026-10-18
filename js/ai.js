// The one AI behind every translation and explanation: Google Gemini, free tier.
// Two ways to reach it, tried in order:
//   1. The user's own free key (Google AI Studio), stored only on this device
//      (kv `secret:gemini`, never synced or backed up), called directly.
//   2. The shared key of the sync server's `ai` Edge Function
//      (supabase/functions/ai/index.ts), for signed-in users with no key of their own.
// Free-tier models only; nothing here can spend money.
import * as db from './db.js';
import { state, langName } from './state.js';
import { hash32 } from './text.js';
import { callFunction, cloudConfig, activeAccount, isSignedIn } from './cloud.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY_ROW = 'secret:gemini';
export const FALLBACK_MODEL = 'gemini-2.5-flash';
const CACHE_DAYS = 60;

export const getKey = () => db.getSetting(KEY_ROW, '');
export const setKey = (k) => db.setSetting(KEY_ROW, k.trim());

// "gemini-2.5-flash" -> [2, 5]; anything that isn't a plain stable model -> null.
const version = (id) => {
  const m = /^gemini-(\d+)(?:\.(\d+))?-flash(-lite)?$/.exec(id);
  return m ? [Number(m[1]), Number(m[2] || 0), m[3] ? 1 : 0] : null;
};

// -> [{id, name}] Gemini text models usable with generateContent, newest stable Flash first.
export async function listModels(key) {
  const res = await fetch(`${API}/models?pageSize=200&key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(errorText(res.status));
  const { models = [] } = await res.json();
  const rank = (id) => {
    const v = version(id);
    return v ? -(v[0] * 100 + v[1]) * 2 + v[2] : 1000; // stable flash first, lite after the full model
  };
  return models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }))
    .filter((m) => /^gemini-/.test(m.id) && !/embedding|image|tts|audio|live|vision/i.test(m.id))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

let autoModel = null;
// The chosen model, else the newest stable Flash this key can use.
export async function pickModel(key) {
  if (state.settings.geminiModel) return state.settings.geminiModel;
  if (autoModel) return autoModel;
  try {
    const best = (await listModels(key)).find((m) => version(m.id) && !version(m.id)[2]);
    autoModel = best?.id || FALLBACK_MODEL;
  } catch {
    return FALLBACK_MODEL;
  }
  return autoModel;
}

function errorText(status, msg = '') {
  if (status === 429) return 'Today’s free AI limit is used up (or too many taps in a minute). Wait a little, or add your own free key in Settings.';
  if (status === 400 && /API key/i.test(msg)) return 'Google rejected the AI key. Check it in Settings.';
  if (status === 401 || status === 403) return 'Google rejected the AI key. Check it in Settings.';
  if (status === 404) return 'This AI model isn’t available any more. Pick another one in Settings.';
  return `AI error${status ? ` (${status})` : ''}${msg ? `: ${msg}` : ''}`;
}

// Lenient JSON: models occasionally wrap it in ``` fences.
export function parseJsonReply(text) {
  const clean = String(text || '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The AI didn’t return an answer. Try again.');
  return JSON.parse(clean.slice(start, end + 1));
}

// Quick lookups get only a little "thinking" (which can take seconds): enough to pick the right
// meaning, not a long deliberation. Gemini 2.5 takes a thinking budget, later models a level.
export function thinkingLight(model) {
  if (/^gemini-2\.5-/.test(model)) return /pro/.test(model) ? null : { thinkingBudget: 512 };
  if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
  return null;
}

// The request body Gemini expects (supabase/functions/ai builds the same one).
export function requestBody({ system, user, schema, fast = false }, model = '') {
  const thinking = fast && thinkingLight(model);
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0, responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
      ...(thinking ? { thinkingConfig: thinking } : {}),
    },
  };
}

async function direct(key, req) {
  const model = await pickModel(key);
  const send = (body) => fetch(`${API}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let res, data;
  try {
    res = await send(requestBody(req, model));
    data = await res.json().catch(() => ({}));
    // A model that doesn't accept the thinking setting: ask again without it.
    if (res.status === 400 && req.fast && /think/i.test(data.error?.message || '')) {
      res = await send(requestBody({ ...req, fast: false }, model));
      data = await res.json().catch(() => ({}));
    }
  } catch {
    throw new Error('Couldn’t reach the AI (offline?).');
  }
  if (!res.ok) throw new Error(errorText(res.status, data.error?.message));
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return { result: parseJsonReply(text), model };
}

async function shared(req) {
  const r = await callFunction('ai', {}, { body: { ...req, model: state.settings.geminiModel || '' } });
  if (!r) throw new Error('Couldn’t reach the shared AI (offline, or not set up on the sync server). You can add your own free key in Settings.');
  if (!r.ok) throw new Error(r.status ? errorText(r.status, r.error) : r.error || 'AI error');
  return { result: parseJsonReply(r.text), model: r.model };
}

// The shared key is only for people logged in to this sync server.
const canShare = () => { const a = activeAccount(); return !!(cloudConfig() && a && isSignedIn(a)); };

// Is any AI reachable without asking the user for anything?
export async function hasProvider() {
  return !!(window.__lingoGemini || (await getKey()) || canShare());
}

// One JSON answer from Gemini. -> {result, model}
// Throws Error('no-provider') when there is neither a key nor a sync server.
export async function geminiJson(req) {
  if (window.__lingoGemini) return window.__lingoGemini(req); // smoke-test hook
  const key = await getKey();
  if (key) return direct(key, req);
  if (canShare()) return shared(req);
  throw new Error('no-provider');
}

export const sourceLabel = (model) => `${model || 'Gemini'} (free)`;

// ---------- line translation (the reader's "translate" button) ----------

const LINE_SCHEMA = { type: 'OBJECT', properties: { translation: { type: 'STRING' } }, required: ['translation'] };

// -> {text, source} | {error: 'quota' | 'unavailable' | 'none', msg} | null (nothing to translate)
export async function translateSentence(text, from, to) {
  text = (text || '').trim();
  if (!text || from === to) return null;
  const key = `s|${from}|${to}|${hash32(text)}`;
  const cached = await db.get('dict', key);
  if (cached && Date.now() - cached.at < CACHE_DAYS * 864e5) return cached.result;
  let result;
  try {
    const { result: r, model } = await geminiJson({
      system: `Translate the user's ${langName(from)} text into natural ${langName(to)}. Keep the meaning and tone; don't explain. Reply with JSON: {"translation": ""}`,
      user: text,
      schema: LINE_SCHEMA,
      fast: true,
    });
    result = { text: String(r.translation || '').trim(), source: sourceLabel(model) };
  } catch (err) {
    if (err.message === 'no-provider') return { error: 'none' };
    return { error: /limit/i.test(err.message) ? 'quota' : 'unavailable', msg: err.message };
  }
  if (result.text) await db.put('dict', { key, result, at: Date.now() });
  return result;
}

export const ERROR_TEXT = {
  quota: 'Today’s free AI limit is used up. Try again later, or add your own free key in Settings.',
  unavailable: 'Translation unavailable right now (offline?).',
  none: 'No AI is set up yet: add a free Gemini key in Settings, or log in to your account.',
};

export function sentenceLinks(sentence, from, to) {
  const q = encodeURIComponent(sentence);
  return [
    ['Google Translate', `https://translate.google.com/?sl=${from}&tl=${to}&text=${q}&op=translate`],
    ['DeepL', `https://www.deepl.com/translator#${from}/${to}/${q}`],
  ];
}
