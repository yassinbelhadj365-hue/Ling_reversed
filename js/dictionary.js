// An offline French → English word list, so a tap shows a dictionary meaning at once (no
// internet, no AI quota) while the AI works out the meaning in this sentence and replaces it.
// Built from English Wiktionary by kaikki.org (data/README.md, tools/build-dict.ps1).
// The file has one line per word form, sorted by UTF-16 code unit like JS strings:
//   "form\tmeaning|meaning"   where an item "@lemma" means "a form of lemma" (see its line).
// It is loaded once (about 2 MB compressed) and searched in place, without building a map.

const FILES = { 'fr|en': new URL('../data/fr-en.tsv', import.meta.url).href };

let loaded = null; // {file, text, starts: Uint32Array} once ready
let loading = null; // {file, promise}

export const hasDictionary = (lang, native) => !!FILES[`${lang}|${native}`];

// Starts loading the list for this language pair (the reader calls it when a lesson opens).
export function loadDictionary(lang, native) {
  const file = FILES[`${lang}|${native}`];
  if (!file) return Promise.resolve(null);
  if (loaded?.file === file) return Promise.resolve(loaded);
  if (loading?.file === file) return loading.promise;
  const promise = fetch(file)
    .then((r) => (r.ok ? r.text() : ''))
    .then((text) => {
      const starts = [0];
      for (let i = text.indexOf('\n'); i !== -1 && i < text.length - 1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
      loaded = text ? { file, text, starts: Uint32Array.from(starts) } : null;
      return loaded;
    })
    .catch(() => null)
    .finally(() => { loading = null; });
  loading = { file, promise };
  return promise;
}

// The items of a word's line, or null.
function itemsOf(d, word) {
  let lo = 0, hi = d.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = d.starts[mid];
    const tab = d.text.indexOf('\t', start);
    const key = d.text.slice(start, tab);
    if (key === word) {
      const end = d.text.indexOf('\n', tab);
      return d.text.slice(tab + 1, end === -1 ? undefined : end).split('|');
    }
    if (key < word) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

// -> [{meaning, lemma?}] (at most two), or null when unknown or the list isn't loaded yet.
// term: a normalized word key (text.js normalize), as the reader uses.
export function lookupNow(term, lang, native) {
  const d = loaded;
  if (!d || d.file !== FILES[`${lang}|${native}`]) return null;
  const out = [];
  for (const item of itemsOf(d, term) || []) {
    if (out.length === 2) break;
    if (!item.startsWith('@')) { out.push({ meaning: item }); continue; }
    const lemma = item.slice(1);
    const meaning = (itemsOf(d, lemma) || []).find((x) => x && !x.startsWith('@'));
    if (meaning && !out.some((o) => o.lemma === lemma)) out.push({ meaning, lemma });
  }
  return out.length ? out : null;
}

// The same, loading the list first if needed.
export async function lookupWord(term, lang, native) {
  await loadDictionary(lang, native);
  return lookupNow(term, lang, native);
}
