// Sentence translation, free by default (docs/PLAN.md, C7):
//   1. Chrome's on-device Translator API, when the language pair is installed
//   2. MyMemory (free, keyless; daily quota, raised by an optional email)
// Results are cached in the `dict` store under `s|from|to|hash`.
import * as db from './db.js';
import { state } from './state.js';
import { hash32 } from './text.js';
import { fetchJson } from './dict.js';

const CACHE_DAYS = 60;
const MYMEMORY_MAX_BYTES = 450; // MyMemory rejects queries over 500 bytes
const translators = new Map();

// 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported'
export async function onDeviceStatus(from, to) {
  if (!('Translator' in self)) return 'unsupported';
  try {
    return await self.Translator.availability({ sourceLanguage: from, targetLanguage: to });
  } catch {
    return 'unsupported';
  }
}

// Downloading a language pack needs a user gesture: call this from a click.
export async function installOnDevice(from, to, onProgress) {
  const t = await self.Translator.create({
    sourceLanguage: from,
    targetLanguage: to,
    monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded)); },
  });
  translators.set(`${from}|${to}`, t);
}

async function onDevice(text, from, to) {
  const key = `${from}|${to}`;
  let t = translators.get(key);
  if (!t) {
    if ((await onDeviceStatus(from, to)) !== 'available') return null;
    t = await self.Translator.create({ sourceLanguage: from, targetLanguage: to });
    translators.set(key, t);
  }
  return { text: await t.translate(text), source: 'On-device' };
}

// Split at punctuation, then at spaces, so no chunk exceeds maxBytes (UTF-8).
export function chunkForMyMemory(text, maxBytes = MYMEMORY_MAX_BYTES) {
  const enc = new TextEncoder();
  const size = (s) => enc.encode(s).length;
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const part of text.match(/[^.!?…;:,]+[.!?…;:,]*\s*|[.!?…;:,]+\s*/g) || [text]) {
    if (size(cur + part) <= maxBytes) { cur += part; continue; }
    flush();
    if (size(part) <= maxBytes) { cur = part; continue; }
    for (const w of part.split(/(\s+)/)) {
      if (size(cur + w) > maxBytes) flush();
      cur += w;
    }
  }
  flush();
  return chunks;
}

function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

// MyMemory's top answer can be a fuzzy translation-memory match for a *different*
// sentence (e.g. one missing the last word). Prefer, in order: a memory entry for
// exactly this text, the machine translation of this text, then the top answer.
export function pickMyMemory(data, query) {
  const norm = (s) => (s || '').toLocaleLowerCase().replace(/[\s.!?…,;:"'«»¿¡-]+/g, ' ').trim();
  const q = norm(query);
  const matches = data.matches || [];
  const exact = matches.find((m) => norm(m.segment) === q && m['created-by'] !== 'MT!' && m.translation);
  const mt = matches.find((m) => /^MT/.test(m['created-by'] || '') && m.translation);
  return (exact || mt)?.translation || data.responseData?.translatedText || '';
}

async function myMemory(text, from, to) {
  const email = state.settings.translateEmail;
  const out = [];
  for (const chunk of chunkForMyMemory(text)) {
    const data = await fetchJson(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${from}|${to}` +
      (email ? `&de=${encodeURIComponent(email)}` : '')
    );
    if (!data) return { error: 'unavailable' };
    const top = data.responseData?.translatedText || '';
    if (Number(data.responseStatus) === 429 || /MYMEMORY WARNING/i.test(top)) return { error: 'quota' };
    const tr = pickMyMemory(data, chunk);
    if (!tr) return { error: 'unavailable' };
    out.push(decodeEntities(tr));
  }
  return { text: out.join(' '), source: 'MyMemory' };
}

// -> {text, source} | {error: 'quota' | 'unavailable'} | null (nothing to translate)
export async function translateSentence(text, from, to) {
  text = (text || '').trim();
  if (!text || from === to) return null;
  if (window.__lingoTranslate) return window.__lingoTranslate(text, from, to); // smoke-test hook
  const key = `s|${from}|${to}|${hash32(text)}`;
  const cached = await db.get('dict', key);
  if (cached && Date.now() - cached.at < CACHE_DAYS * 864e5) return cached.result;
  let result = null;
  try { result = await onDevice(text, from, to); } catch { /* fall through to MyMemory */ }
  if (!result) result = await myMemory(text, from, to);
  if (result?.text) await db.put('dict', { key, result, at: Date.now() });
  return result;
}

export const ERROR_TEXT = {
  quota: 'Today’s free translation limit is used up. Use the links below, or add an email in Settings to raise it.',
  unavailable: 'Translation unavailable right now (offline?). Use the links below.',
};

export function sentenceLinks(sentence, from, to) {
  const q = encodeURIComponent(sentence);
  return [
    ['Google Translate', `https://translate.google.com/?sl=${from}&tl=${to}&text=${q}&op=translate`],
    ['DeepL', `https://www.deepl.com/translator#${from}/${to}/${q}`],
  ];
}
