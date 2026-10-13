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

// ---------- monolingual dictionary: the Wiktionary written in the language you're learning ----------
// (fr.wiktionary.org for French, es.wiktionary.org for Spanish, …). Free, no AI, definitions and
// examples in the target language. Only the section for that language is fetched.

const MONO_DEFS = 6;
const endonym = (lang) => {
  try { return new Intl.DisplayNames([lang], { type: 'language' }).of(lang); } catch { return lang; }
};
const textOf = (el) => el.textContent.replace(/\s+/g, ' ').replace(/\s+([,.;:!?)])/g, '$1').trim();

// Parse one language section of a Wiktionary page (HTML) into
// [{pos, defs: [{text, example, formOf}]}]. Works across editions: definitions are the
// items of top-level numbered lists (or dt/dd lists), grouped under the nearest heading.
export function parseMonolingual(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector('.mw-parser-output') || doc.body;
  const entries = [];
  let pos = '';
  let count = 0;
  const add = (text, example, formOf) => {
    if (!text || count >= MONO_DEFS) return;
    let entry = entries.at(-1);
    if (!entry || entry.pos !== pos) entries.push((entry = { pos, defs: [] }));
    entry.defs.push({ text, example, formOf });
    count++;
  };
  const isFormHeading = () => /^(forme|forma|flexion|flektierte|konjugierte|deklinierte|form of|inflected)/i.test(pos);
  for (const el of root.children) {
    const heading = el.matches('.mw-heading, h3, h4, h5') ? el.querySelector('h3, h4, h5') || el : null;
    if (heading && /^H[345]$/.test(heading.tagName)) {
      pos = textOf(heading).replace(/\[.*?\]/g, '').trim();
      continue;
    }
    if (el.tagName === 'OL') {
      for (let li of el.children) {
        if (li.tagName !== 'LI') continue;
        // it.wiktionary: the first item is the headword line, with the senses nested under it.
        if (li.firstElementChild?.tagName === 'B') {
          const nested = li.querySelector(':scope > ol, :scope > ul, :scope > dl');
          if (nested) {
            for (const sub of nested.querySelectorAll(':scope > li, :scope > dd')) {
              const c = sub.cloneNode(true);
              c.querySelectorAll('ul, ol, dl, figure, .reference, sup, style').forEach((n) => n.remove());
              const ex = sub.querySelector(':scope > ul li');
              add(textOf(c), ex ? textOf(ex).slice(0, 180) : '', '');
            }
          }
          continue;
        }
        const clone = li.cloneNode(true);
        clone.querySelectorAll('ul, ol, dl, .reference, sup, style').forEach((n) => n.remove());
        const text = textOf(clone);
        // The shortest of the first few examples: literary quotes can be very long.
        const exs = [...li.querySelectorAll(':scope > ul .example q')].slice(0, 4);
        if (!exs.length) exs.push(...[li.querySelector(':scope > ul .example, :scope > dl dd, :scope > ul li')].filter(Boolean));
        let example = exs.map((x) => textOf(x).replace(/\s*—.*$/, '')).sort((a, b) => a.length - b.length)[0] || '';
        if (example.length > 180) example = `${example.slice(0, 177)}…`;
        const links = [...clone.querySelectorAll('a[title]')].filter((a) => !a.getAttribute('title').includes(':'));
        add(text, example, isFormHeading() && links.length ? links.at(-1).getAttribute('title') : '');
      }
    } else if (el.tagName === 'DL' && el.querySelector(':scope > dd') && (
      el.querySelector(':scope > dt') || // es.wiktionary: <dt>1</dt><dd>…</dd>
      /^(bedeutungen|significados?|significato|betekenissen?)\s*:?$/i.test(textOf(el.previousElementSibling || el)) // de.wiktionary
    )) {
      for (const dd of el.querySelectorAll(':scope > dd')) {
        const clone = dd.cloneNode(true);
        clone.querySelectorAll('ul, ol, dl, .reference, sup, style').forEach((n) => n.remove());
        add(textOf(clone).replace(/^\[\d+[a-z]?\]\s*/, ''), '', '');
      }
    }
  }
  return entries;
}

async function monolingualFetch(term, lang) {
  const api = `https://${lang}.wiktionary.org/w/api.php`;
  const q = (params) => fetchJson(`${api}?${new URLSearchParams({ format: 'json', formatversion: '2', redirects: '1', origin: '*', ...params })}`);
  const name = endonym(lang).toLocaleLowerCase(lang);
  for (const page of [...new Set([term, term.toLocaleLowerCase(lang)])]) {
    const s = await q({ action: 'parse', page, prop: 'sections' });
    if (s === null) return undefined; // couldn't reach Wiktionary (offline): don't cache a "not found"
    const sections = s?.parse?.sections;
    if (!sections) continue;
    const plain = (line) => line.replace(/<[^>]+>/g, '').toLocaleLowerCase(lang);
    const sec = sections.find((x) => x.toclevel === 1 && plain(x.line).includes(name))
      || sections.find((x) => plain(x.line).includes(name));
    if (!sec) continue;
    const t = await q({ action: 'parse', page, section: sec.index, prop: 'text' });
    const entries = t?.parse?.text ? parseMonolingual(t.parse.text) : [];
    if (entries.length) return { source: `${lang}.wiktionary.org`, url: `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(page)}`, entries };
  }
  return null;
}

// -> {source, url, entries} | null (cached for 60 days, negative results too)
export async function monolingual(term, lang) {
  if (window.__lingoMono) return window.__lingoMono(term, lang); // smoke-test hook
  const key = `m|${lang}|${term.toLocaleLowerCase()}`;
  const cached = await db.get('dict', key);
  if (cached && Date.now() - cached.at < CACHE_DAYS * 864e5) return cached.value;
  const value = await monolingualFetch(term, lang).catch(() => undefined);
  if (value === undefined) return null;
  await db.put('dict', { key, value, at: Date.now() });
  return value;
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
