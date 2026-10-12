// Dictionary lookups from free, CORS-enabled sources, cached in IndexedDB.
//   - Wiktionary REST API: definitions (English-language glosses)
//   - MyMemory: short machine/memory translation into the user's native language
import * as db from './db.js';

const CACHE_DAYS = 60;

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

// One Wiktionary definition: an inflected form ("first-person plural ... of hablar")
// is marked with formOf = its lemma, read from the form-of link in the markup.
export function parseDefinition(html, pos) {
  const div = document.createElement('div');
  div.innerHTML = html;
  const text = div.textContent.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const link = div.querySelector('.form-of-definition-link a[title], .form-of-definition a[title]:not([title^="Appendix:"])');
  const def = { source: 'Wiktionary', pos, text };
  if (link) def.formOf = link.getAttribute('title');
  return def;
}

async function wiktionary(term, lang, { exactOnly = false } = {}) {
  const tries = [term];
  const lower = term.toLocaleLowerCase();
  if (!exactOnly && lower !== term) tries.push(lower);
  for (const t of tries) {
    const data = await fetchJson(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(t.replace(/ /g, '_'))}?redirect=true`
    );
    const entries = data?.[lang];
    if (!entries?.length) continue;
    const out = [];
    for (const e of entries) {
      for (const d of e.definitions || []) {
        const def = parseDefinition(d.definition || '', e.partOfSpeech);
        if (def) out.push(def);
      }
    }
    if (out.length) return out.slice(0, 8);
  }
  return [];
}

// A multi-word expression ("a pesar de"), looked up as its own Wiktionary entry.
// Negative results are cached too, so each candidate costs one request per month.
export async function lookupExpression(surface, lang) {
  if (window.__lingoExpr) return window.__lingoExpr(surface, lang); // smoke-test hook
  const key = `w|${lang}|${surface}`;
  const cached = await db.get('dict', key);
  if (cached && Date.now() - cached.at < 30 * 864e5) return cached.results;
  const results = (await wiktionary(surface, lang, { exactOnly: true })).filter((d) => !d.formOf);
  await db.put('dict', { key, results, at: Date.now() });
  return results;
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

// -> [{source, pos, text, formOf?, lemma?}]: translations, then definitions; when the
// word is an inflected form, the lemma's own definitions follow (marked `lemma`).
export async function lookup(term, lang, native) {
  if (window.__lingoDict) return window.__lingoDict(term, lang, native); // smoke-test hook
  const key = `v2|${lang}|${native}|${term.toLocaleLowerCase()}`;
  const cached = await db.get('dict', key);
  if (cached && Date.now() - cached.at < CACHE_DAYS * 864e5) return cached.results;
  const [defs, trans] = await Promise.all([wiktionary(term, lang), myMemory(term, lang, native)]);
  const lemma = defs.find((d) => d.formOf)?.formOf;
  const lemmaDefs = lemma && lemma.toLocaleLowerCase() !== term.toLocaleLowerCase()
    ? (await wiktionary(lemma, lang)).filter((d) => !d.formOf).slice(0, 4).map((d) => ({ ...d, lemma }))
    : [];
  const results = [...trans, ...defs, ...lemmaDefs];
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
