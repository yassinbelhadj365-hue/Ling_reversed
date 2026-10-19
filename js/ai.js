// The one AI behind every translation and explanation: Google Gemini, free tier.
// Two ways to reach it, tried in order:
//   1. The user's own free key (Google AI Studio), stored only on this device
//      (kv `secret:gemini`, never synced or backed up), called directly.
//   2. The shared key of the sync server's `ai` Edge Function
//      (supabase/functions/ai/index.ts), for signed-in users with no key of their own.
// When Gemini is busy or used up, the user's optional free Mistral or Groq key answers instead
// (BACKUPS). Free-tier models only; nothing here can spend money.
import * as db from './db.js';
import { state, langName } from './state.js';
import { hash32 } from './text.js';
import { callFunction, cloudConfig, activeAccount, isSignedIn } from './cloud.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
export const FALLBACK_MODEL = 'gemini-3.6-flash';
// Gemma runs on the same key with its own free limit, so it can still answer when every Flash
// model is busy. It is weaker, so it comes last. Preferred first.
const GEMMA_MODELS = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it', 'gemma-3-27b-it'];
const isGemma = (id) => /^gemma-/.test(id);
const CACHE_DAYS = 60;

// Each provider's key is kept on this device (kv `secret:<provider>`) and, unless the user
// turns it off, copied to the synced kv row `aikeys` ({on, gemini, mistral, groq}) so the other
// devices of the same account get it (the owner chose this: the app is for family and friends).
// `aikeys` never goes into backup files. A key typed on this device wins.
const SYNCED_KEYS = 'aikeys';
const KEY_IDS = ['gemini', 'mistral', 'groq'];
const syncedKeys = () => db.getSetting(SYNCED_KEYS, null);
export async function getProviderKey(id) {
  const own = await db.getSetting(`secret:${id}`, '');
  if (own) return own;
  const shared = await syncedKeys();
  return (shared?.on !== false && shared?.[id]) || '';
}
export async function setProviderKey(id, k) {
  await db.setSetting(`secret:${id}`, k.trim());
  const shared = await syncedKeys();
  if (shared?.on !== false) await db.setSetting(SYNCED_KEYS, { ...shared, on: true, [id]: k.trim() });
}
export const keysSynced = async () => (await syncedKeys())?.on !== false;
// On: copies this device's keys to the account (keeping keys other devices added). Off: removes
// them from the account; every device keeps only the keys typed on it.
export async function setKeysSynced(on) {
  const shared = (await syncedKeys()) || {};
  if (!on) return db.setSetting(SYNCED_KEYS, { on: false });
  const keys = { ...shared, on: true };
  for (const id of KEY_IDS) keys[id] = (await db.getSetting(`secret:${id}`, '')) || (shared.on !== false && shared[id]) || '';
  if (KEY_IDS.every((id) => keys[id] === shared[id]) && shared.on === true) return; // nothing new to send
  return db.setSetting(SYNCED_KEYS, keys);
}
export const getKey = () => getProviderKey('gemini');
export const setKey = (k) => setProviderKey('gemini', k);

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
    return v ? -(v[0] * 100 + v[1]) * 2 + v[2] : isGemma(id) ? 2000 : 1000; // stable flash first, lite after the full model, Gemma last
  };
  return models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }))
    .filter((m) => (/^gemini-/.test(m.id) || GEMMA_MODELS.includes(m.id)) && !/embedding|image|tts|audio|live|vision/i.test(m.id))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

// This key's models, fetched once per session.
let listed = null;
const modelsOf = (key) => {
  if (listed?.key !== key) listed = { key, p: listModels(key).catch((e) => { listed = null; throw e; }) };
  return listed.p;
};

// The chosen model, else the newest stable Flash this key can use.
export async function pickModel(key) {
  if (state.settings.geminiModel) return state.settings.geminiModel;
  try {
    return (await modelsOf(key)).find((m) => version(m.id) && !version(m.id)[2])?.id || FALLBACK_MODEL;
  } catch {
    return FALLBACK_MODEL;
  }
}

// Each model has its own free limit. A model that used its limit up is skipped until it
// resets (a minute, or Google's midnight in California for the daily one) and the next one
// answers instead, so the AI runs out only when every free Flash model has.
const spent = new Map(); // model -> when to try it again
const MAX_MODELS = 4;
function nextDailyReset() {
  const d = new Date();
  d.setUTCHours(8, 0, 0, 0); // midnight Pacific (standard time; an hour late in summer)
  if (+d <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  return +d;
}
const isDaily = (data) => /PerDay/i.test(JSON.stringify(data.error?.details || []));
// A per-minute limit says how long to wait ("14s").
const retryDelay = (data) => {
  const d = (data.error?.details || []).find((x) => x.retryDelay)?.retryDelay;
  return d ? Math.max(10, parseFloat(d) || 0) * 1000 : 60_000;
};
// Google's servers are overloaded ("high demand"): not the user's limit, and usually brief.
const BUSY = new Set([500, 502, 503, 504]);
const isBusy = (status) => BUSY.has(status);
// When to try a model again after this error.
function skipUntil(status, data) {
  if (status === 404 || (status === 429 && isDaily(data))) return nextDailyReset();
  if (status === 429) return Date.now() + retryDelay(data);
  return Date.now() + 60_000; // busy
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> model ids to try, in order: the chosen or automatic one, the other stable Flash models,
// then Gemma (not for videos: it can't watch them).
async function modelsToTry(key, req = {}) {
  const first = await pickModel(key);
  let ids = [];
  try { ids = (await modelsOf(key)).map((m) => m.id); } catch { /* offline: just the first */ }
  const open = (id) => !(spent.get(id) > Date.now());
  const flash = [first, ...ids.filter((id) => version(id) && id !== first)].filter(open);
  const gemma = req.video ? null : GEMMA_MODELS.find((id) => ids.includes(id) && id !== first && open(id));
  return [...(flash.length || gemma ? flash : [first]).slice(0, MAX_MODELS), ...(gemma ? [gemma] : [])];
}

function errorText(status, msg = '') {
  if (isBusy(status)) return 'Google’s AI is busy right now (many people are using it). Try again in a minute, or add a free Mistral or Groq key in Settings as a backup.';
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

// A public YouTube video as input, optionally one part of it ({url, start, end} in seconds).
export function videoPart(video) {
  if (!video) return [];
  const clip = video.end ? { videoMetadata: { startOffset: `${video.start || 0}s`, endOffset: `${video.end}s` } } : {};
  return [{ fileData: { fileUri: video.url }, ...clip }];
}

// A Gemini schema as an example of the JSON wanted, for models that can't take a schema
// (Gemma, the backups): {type: OBJECT, properties: {a: STRING}} -> '{"a":""}'.
function shapeOf(s) {
  if (!s) return '';
  if (s.type === 'OBJECT') return Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, shapeOf(v)]));
  if (s.type === 'ARRAY') return [shapeOf(s.items)];
  if (s.type === 'INTEGER' || s.type === 'NUMBER') return 0;
  if (s.type === 'BOOLEAN') return false;
  return '';
}
export const jsonShape = (schema) => !schema ? '\n\nReply with JSON only.'
  : `\n\nReply with JSON only, exactly this shape with every field filled in:\n${JSON.stringify(shapeOf(schema))}`;

// The request body Gemini expects (supabase/functions/ai builds the same one).
export function requestBody({ system, user, schema, fast = false, video = null, temperature = 0 }, model = '') {
  // Gemma takes no system instruction, JSON mode or schema: all of it goes into the text.
  if (isGemma(model)) {
    return {
      contents: [{ role: 'user', parts: [{ text: `${system}${jsonShape(schema)}\n\n${user}` }] }],
      generationConfig: { temperature },
    };
  }
  const thinking = fast && thinkingLight(model);
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [...videoPart(video), { text: user }] }],
    generationConfig: {
      temperature, responseMimeType: 'application/json',
      // Low resolution: the sound is what matters, and it uses a third of the free quota.
      ...(video ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
      ...(schema ? { responseSchema: schema } : {}),
      ...(thinking ? { thinkingConfig: thinking } : {}),
    },
  };
}

async function ask(key, model, req) {
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
  return { res, data };
}

// One answer with the user's own key. -> {result, model}
// Used-up, missing or busy models are skipped for a while and the next one answers; a busy
// model gets one quick second try first (a tap is waiting, so only once per answer).
export async function direct(key, req) {
  let failed = null, retried = false;
  for (const model of await modelsToTry(key, req)) {
    let { res, data } = await ask(key, model, req);
    if (isBusy(res.status) && !retried) {
      retried = true;
      await sleep(window.__lingoBusyWait ?? 800 + Math.random() * 400);
      ({ res, data } = await ask(key, model, req));
    }
    if (res.status === 429 || res.status === 404 || isBusy(res.status)) {
      spent.set(model, skipUntil(res.status, data));
      failed ||= { res, data };
      continue;
    }
    if (!res.ok) throw new Error(errorText(res.status, data.error?.message));
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return { result: parseJsonReply(text), model };
  }
  throw new Error(errorText(failed.res.status, failed.data.error?.message));
}

// Test hook: forget the model list and the used-up models.
export function _resetModels() { listed = null; spent.clear(); }

async function shared(req) {
  const r = await callFunction('ai', {}, { body: { ...req, model: state.settings.geminiModel || '' } });
  if (!r) throw new Error('Couldn’t reach the shared AI (offline, or not set up on the sync server). You can add your own free key in Settings.');
  if (!r.ok) throw new Error(r.status ? errorText(r.status, r.error) : r.error || 'AI error');
  // An older function ignores the video, and the answer would be made up.
  if (req.video && !r.video) throw new Error('The shared AI on your sync server is too old to watch videos: redeploy its “ai” function (docs/SYNC_SETUP.md), or add your own free key in Settings.');
  return { result: parseJsonReply(r.text), model: r.model };
}

// The shared key is only for people logged in to this sync server.
const canShare = () => { const a = activeAccount(); return !!(cloudConfig() && a && isSignedIn(a)); };

// ---------- backups: other free AIs with the user's own key ----------
// Both have a free tier without a card, accept calls from a browser and speak the OpenAI
// chat format. They can't watch videos. Keys stay on this device like the Gemini one.
export const BACKUPS = [
  { id: 'mistral', name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b',
    extra: { reasoning_effort: 'low' }, keyUrl: 'https://console.groq.com/keys' },
];
const backupsWithKeys = async () =>
  (await Promise.all(BACKUPS.map(async (p) => ({ p, key: await getProviderKey(p.id) })))).filter((b) => b.key);

// One answer from a backup. -> {result, model}
export async function backup(p, key, { system, user, schema, temperature = 0 }) {
  let res, data;
  try {
    res = await fetch(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: p.model, temperature, response_format: { type: 'json_object' }, ...p.extra,
        messages: [{ role: 'system', content: system + jsonShape(schema) }, { role: 'user', content: user }],
      }),
    });
    data = await res.json().catch(() => ({}));
  } catch {
    throw new Error(`Couldn’t reach ${p.name} (offline?).`);
  }
  if (!res.ok) {
    if (res.status === 429 || isBusy(res.status)) spent.set(p.id, Date.now() + 60_000);
    const msg = res.status === 401 || res.status === 403 ? `${p.name} rejected its key. Check it in Settings.`
      : res.status === 429 ? `${p.name}’s free limit is used up for now.`
      : isBusy(res.status) ? `${p.name} is busy right now.`
      : `${p.name} error (${res.status})${data.error?.message ? `: ${data.error.message}` : ''}`;
    throw new Error(msg);
  }
  return { result: parseJsonReply(data.choices?.[0]?.message?.content), model: p.model.replace(/^.*\//, '') };
}

// ---------- setup helpers (the Settings AI card) ----------

export const PROVIDERS = [
  { id: 'gemini', name: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey' },
  ...BACKUPS,
];
// Which provider a pasted key belongs to, from its look; null when it isn't recognizable.
export function keyKind(text) {
  const k = String(text || '').trim();
  if (/^AIza[\w-]{30,}$/.test(k)) return 'gemini';
  if (/^gsk_\w{20,}$/.test(k)) return 'groq';
  if (/^[A-Za-z0-9]{32}$/.test(k)) return 'mistral';
  return null;
}

// One tiny request to one provider with this key. -> {ok, msg}
export async function testProvider(id, key) {
  const ping = {
    system: 'Translate the user\'s French text into natural English. Reply with JSON: {"translation": ""}',
    user: 'Bonjour à tous.',
    schema: LINE_SCHEMA,
  };
  try {
    const { result, model } = id === 'gemini' ? await direct(key, ping) : await backup(BACKUPS.find((p) => p.id === id), key, ping);
    return { ok: true, msg: `Works (${model}): “${result.translation || ''}”` };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
}

// The shared `ai` function on the sync server: what state is it in?
// -> 'none' (no sync server) | 'missing' (not deployed) | 'old' (needs redeploying) | 'nokey' | 'ok'
export const AI_FUNCTION_VERSION = '2026-10-19'; // bump with supabase/functions/ai/index.ts `VERSION`
export async function sharedStatus() {
  if (!cloudConfig()) return 'none';
  const r = await callFunction('ai', { ping: '1' });
  if (!r?.ping) return 'missing';
  if (!(r.version >= AI_FUNCTION_VERSION)) return 'old';
  return r.key === false ? 'nokey' : 'ok';
}
// The Supabase dashboard of the configured sync server, or null.
export function dashboardUrl(page = '') {
  const host = cloudConfig() && new URL(cloudConfig().url).hostname;
  const ref = host && /^([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1];
  return ref ? `https://supabase.com/dashboard/project/${ref}${page}` : null;
}

// Is any AI reachable without asking the user for anything? (Videos need Gemini.)
export async function hasProvider({ video = false } = {}) {
  return !!(window.__lingoGemini || (await getKey()) || canShare() || (!video && (await backupsWithKeys()).length));
}

// One JSON answer: Gemini, else (busy, used up, any failure) the backups in order. -> {result, model}
// Throws Error('no-provider') when nothing is set up; otherwise Gemini's error comes first.
export async function geminiJson(req) {
  if (window.__lingoGemini) return window.__lingoGemini(req); // smoke-test hook
  const key = await getKey();
  let error = null;
  if (key || canShare()) {
    try { return await (key ? direct(key, req) : shared(req)); } catch (err) { error = err; }
  }
  if (!req.video) {
    for (const { p, key: k } of await backupsWithKeys()) {
      if (spent.get(p.id) > Date.now()) continue;
      try { return await backup(p, k, req); } catch (err) { error ||= err; }
    }
  }
  throw error || new Error('no-provider');
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
    return { error: /limit/i.test(err.message) ? 'quota' : /busy/i.test(err.message) ? 'busy' : 'unavailable', msg: err.message };
  }
  if (result.text) await db.put('dict', { key, result, at: Date.now() });
  return result;
}

export const ERROR_TEXT = {
  quota: 'Today’s free AI limit is used up. Try again later, or add your own free key in Settings.',
  busy: 'Google’s AI is busy right now. Try again in a minute, or add a free Mistral or Groq key in Settings as a backup.',
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
