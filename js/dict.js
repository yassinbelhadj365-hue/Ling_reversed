// Dictionary lookups from free, CORS-enabled sources, cached in IndexedDB.
//   - Wiktionary REST API: definitions (English-language glosses)
//   - MyMemory: short machine/memory translation into the user's native language
import * as db from './db.js';

const CACHE_DAYS = 60;

function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent.replace(/\s+/g, ' ').trim();
}

export async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function wiktionary(term, lang) {
  const tries = [term];
  const lower = term.toLocaleLowerCase();
  if (lower !== term) tries.push(lower);
  for (const t of tries) {
    const data = await fetchJson(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(t)}?redirect=true`
    );
    const entries = data?.[lang];
    if (!entries?.length) continue;
    const out = [];
    for (const e of entries) {
      for (const d of e.definitions || []) {
        const text = stripHtml(d.definition || '');
        if (text) out.push({ source: 'Wiktionary', pos: e.partOfSpeech, text });
      }
    }
    if (out.length) return out.slice(0, 8);
  }
  return [];
}

async function myMemory(term, from, to) {
  if (from === to) return [];
  const data = await fetchJson(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(term)}&langpair=${from}|${to}`
  );
  if (!data) return [];
  const seen = new Set();
  const out = [];
  const add = (t) => {
    t = (t || '').trim();
    const k = t.toLocaleLowerCase();
    if (!t || seen.has(k) || k === term.toLocaleLowerCase() || /MYMEMORY WARNING/i.test(t)) return;
    seen.add(k);
    out.push({ source: 'MyMemory', pos: 'translation', text: t });
  };
  add(data.responseData?.translatedText);
  for (const m of data.matches || []) add(m.translation);
  return out.slice(0, 4);
}

export async function lookup(term, lang, native) {
  const key = `${lang}|${native}|${term.toLocaleLowerCase()}`;
  const cached = await db.get('dict', key);
  if (cached && Date.now() - cached.at < CACHE_DAYS * 864e5) return cached.results;
  const [defs, trans] = await Promise.all([wiktionary(term, lang), myMemory(term, lang, native)]);
  const results = [...trans, ...defs];
  if (results.length) await db.put('dict', { key, results, at: Date.now() });
  return results;
}

export function externalLinks(term, lang, native) {
  const q = encodeURIComponent(term);
  return [
    ['Google Translate', `https://translate.google.com/?sl=${lang}&tl=${native}&text=${q}&op=translate`],
    ['DeepL', `https://www.deepl.com/translator#${lang}/${native}/${q}`],
    ['Wiktionary', `https://en.wiktionary.org/wiki/${encodeURIComponent(term.toLocaleLowerCase())}`],
    ['Reverso', `https://context.reverso.net/translation/${q}`],
  ];
}
