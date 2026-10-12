// App-wide state: settings, the in-memory vocabulary of the current language,
// activity tracking, text-to-speech and small DOM helpers.
import * as db from './db.js';
import { NEW, KNOWN, isLearning, freshSrs } from './srs.js';

export const LANGS = [
  ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
  ['en', 'English'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'],
  ['fi', 'Finnish'], ['pl', 'Polish'], ['cs', 'Czech'], ['sk', 'Slovak'], ['ro', 'Romanian'],
  ['hu', 'Hungarian'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['el', 'Greek'], ['tr', 'Turkish'],
  ['ar', 'Arabic'], ['he', 'Hebrew'], ['fa', 'Persian'], ['hi', 'Hindi'], ['id', 'Indonesian'],
  ['ms', 'Malay'], ['vi', 'Vietnamese'], ['sw', 'Swahili'], ['ca', 'Catalan'], ['eo', 'Esperanto'],
];
export const langName = (code) => (LANGS.find((l) => l[0] === code) || [code, code])[1];

const DEFAULTS = {
  lang: 'es',
  native: 'en',
  pageSize: 250,       // words per reader page
  pagingKnown: true,   // turning a page marks unclicked blue words as known
  dailyGoal: 20,       // LingQs created per day
  ttsRate: 0.9,
  voice: '',
  mergeCues: true,
};

export const state = {
  settings: { ...DEFAULTS },
  vocab: new Map(),    // term -> word record, for the current language only
};

export const lang = () => state.settings.lang;

export async function loadSettings() {
  state.settings = { ...DEFAULTS, ...(await db.getSetting('settings', {})) };
}
export async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  await db.setSetting('settings', state.settings);
}
export async function loadVocab() {
  const rows = await db.byLang('words', lang());
  state.vocab = new Map(rows.map((w) => [w.term, w]));
}

// ---------- words ----------

export function newWord(term) {
  const now = Date.now();
  return {
    key: `${lang()}|${term}`, lang: lang(), term, status: NEW, hint: '', context: '',
    freq: 0, lessons: [], seen: 0, isPhrase: term.includes(' '), createdAt: now, updatedAt: now,
  };
}
export const getWord = (term) => state.vocab.get(term) || null;
export const statusOf = (term) => state.vocab.get(term)?.status ?? NEW;

// Mutates the word's status and returns the activity delta it causes.
function applyStatus(w, status) {
  const old = w.status;
  if (old === status) return {};
  const d = {};
  w.status = status;
  if (isLearning(status) && !isLearning(old)) {
    d.lingqs = 1;
    w.srs = freshSrs();
    w.lingqAt = Date.now();
  }
  if (status === KNOWN) { d.known = 1; w.knownAt = Date.now(); }
  if (old === KNOWN) d.known = -1;
  return d;
}

export async function setStatus(term, status, patch = {}) {
  const w = getWord(term) || newWord(term);
  Object.assign(w, patch);
  const d = applyStatus(w, status);
  w.updatedAt = Date.now();
  state.vocab.set(term, w);
  await db.put('words', w);
  await bumpActivity(d);
  return w;
}

export async function setStatusMany(terms, status) {
  const changed = [];
  const total = {};
  for (const term of terms) {
    const w = getWord(term) || newWord(term);
    const d = applyStatus(w, status);
    if (!Object.keys(d).length) continue;
    w.updatedAt = Date.now();
    state.vocab.set(term, w);
    changed.push(w);
    for (const [k, v] of Object.entries(d)) total[k] = (total[k] || 0) + v;
  }
  await db.putMany('words', changed);
  await bumpActivity(total);
  return changed.length;
}

export async function saveWord(w) {
  w.updatedAt = Date.now();
  state.vocab.set(w.term, w);
  await db.put('words', w);
}

export async function markSeen(terms) {
  const changed = [];
  for (const t of terms) {
    const w = getWord(t);
    if (w) { w.seen = (w.seen || 0) + 1; changed.push(w); }
  }
  await db.putMany('words', changed);
}

// ---------- the passive vocabulary pool ----------
// Every word of every imported lesson is recorded with how often it occurs and
// in which lessons, whether or not you have studied it yet.

export async function addLessonToPool(lesson) {
  const changed = [];
  let added = 0;
  for (const [term, count] of Object.entries(lesson.words)) {
    let w = getWord(term);
    if (!w) { w = newWord(term); added++; }
    w.freq = (w.freq || 0) + count;
    if (!w.lessons.includes(lesson.id)) w.lessons.push(lesson.id);
    state.vocab.set(term, w);
    changed.push(w);
  }
  await db.putMany('words', changed);
  return added;
}

export async function removeLessonFromPool(lesson) {
  const changed = [];
  for (const [term, count] of Object.entries(lesson.words)) {
    const w = getWord(term);
    if (!w) continue;
    w.freq = Math.max(0, (w.freq || 0) - count);
    w.lessons = w.lessons.filter((id) => id !== lesson.id);
    if (w.status === NEW && !w.lessons.length && !w.hint) {
      state.vocab.delete(term);
      await db.del('words', w.key);
    } else {
      changed.push(w);
    }
  }
  await db.putMany('words', changed);
}

// ---------- activity (per day, per language) ----------

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function bumpActivity(delta) {
  if (!delta || !Object.keys(delta).length) return;
  const date = dayKey();
  const key = `${date}|${lang()}`;
  await db.update('activity', key, (row) => {
    row = row || { key, date, lang: lang(), known: 0, lingqs: 0, read: 0, reviews: 0 };
    for (const [k, v] of Object.entries(delta)) row[k] = (row[k] || 0) + v;
    return row;
  });
}

// ---------- text to speech ----------

export function speak(text) {
  if (!('speechSynthesis' in window)) return toast('Text-to-speech is not supported on this device.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang();
  u.rate = state.settings.ttsRate;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang()));
  const v = voices.find((x) => x.voiceURI === state.settings.voice) || voices[0];
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

// ---------- DOM helpers ----------

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
