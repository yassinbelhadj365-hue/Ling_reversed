// App-wide state: settings, the in-memory vocabulary of the current language,
// activity tracking, text-to-speech and small DOM helpers.
import * as db from './db.js';
import { NEW, KNOWN, isLearning, freshSrs, grade } from './srs.js';
import { onLookup, onPass, onManual, onReview, undoPatch } from './knowledge.js';

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
  autoStatus: true,    // word levels follow your lookups, reading and listening (knowledge.js)
  autoPace: 'normal',  // 'cautious' | 'normal' | 'fast': encounters needed to level up
  autoAdjustManual: true, // evidence keeps moving LingQ levels you set yourself
  listenPasses: 2,     // untapped listens before a new word counts as known
  pagingKnown: true,   // only when autoStatus is off: turning a page marks untapped blue words known
  follow: true,        // listen mode: the transcript scrolls with playback
  pauseOnLookup: true, // tapping a word pauses the video...
  resumeAfterLookup: true, // ...and closing the panel resumes it
  dimOtherLines: true, // fade lines other than the one being spoken
  wordProgress: true,  // underline the words of the active line as they are spoken
  translateEmail: '',  // optional: sent to MyMemory to raise its free daily translation limit
  aiAuto: true,        // explain words automatically when Chrome's on-device AI is available
  assistModel: '',     // OpenRouter model for "Still unclear?" (free models only; '' = best available)
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

// `manual: true` when the user chose this status (pins it against automatic changes).
export async function setStatus(term, status, patch = {}, { manual = false } = {}) {
  const w = getWord(term) || newWord(term);
  Object.assign(w, patch);
  if (manual) w.ev = onManual(w, status);
  const d = applyStatus(w, status);
  w.updatedAt = Date.now();
  state.vocab.set(term, w);
  await db.put('words', w);
  await bumpActivity(d);
  return w;
}

export async function setStatusMany(terms, status, { manual = false } = {}) {
  const changed = [];
  const total = {};
  for (const term of terms) {
    const w = getWord(term) || newWord(term);
    if (manual) w.ev = onManual(w, status);
    const d = applyStatus(w, status);
    if (!Object.keys(d).length && !manual) continue;
    w.updatedAt = Date.now();
    state.vocab.set(term, w);
    changed.push(w);
    for (const [k, v] of Object.entries(d)) total[k] = (total[k] || 0) + v;
  }
  await db.putMany('words', changed);
  await bumpActivity(total);
  return changed.length;
}

// ---------- automatic levels (knowledge.js) ----------

function autoOpts() {
  const s = state.settings;
  return { pace: s.autoPace, autoAdjustManual: s.autoAdjustManual, listenPasses: s.listenPasses, day: dayKey(), now: Date.now() };
}

async function commit(words, total) {
  await db.putMany('words', words);
  await bumpActivity(total);
}

function addDelta(total, d) {
  for (const [k, v] of Object.entries(d)) total[k] = (total[k] || 0) + v;
}

// events: [{term, type: 'lookup'} | {term, type: 'pass', kind: 'read' | 'listen'}]
// Returns the status changes: [{term, from, to}].
export async function applyEvents(events) {
  const opts = autoOpts();
  const dirty = new Map();
  const changes = [];
  const total = {};
  for (const e of events) {
    const w = getWord(e.term) || newWord(e.term);
    const r = e.type === 'lookup' ? onLookup(w, opts) : onPass(w, e.kind, opts);
    if (!r) continue;
    const from = w.status;
    addDelta(total, applyStatus(w, r.status));
    w.ev = r.ev;
    w.updatedAt = opts.now;
    state.vocab.set(e.term, w);
    dirty.set(e.term, w);
    if (from !== w.status) changes.push({ term: e.term, from, to: w.status });
  }
  await commit([...dirty.values()], total);
  return changes;
}

// Undo the last automatic change of each term.
export async function undoAuto(terms) {
  const dirty = [];
  const total = {};
  for (const term of [].concat(terms)) {
    const w = getWord(term);
    const patch = w && undoPatch(w);
    if (!patch) continue;
    addDelta(total, applyStatus(w, patch.status));
    w.ev = patch.ev;
    w.updatedAt = Date.now();
    dirty.push(w);
  }
  await commit(dirty, total);
  return dirty.length;
}

// A flashcard answer: schedule it and let the result move the word's level.
export async function applyReview(w, g) {
  const graded = grade(w, g);
  const r = onReview(w, g, graded, autoOpts());
  w.srs = graded.srs;
  const total = applyStatus(w, r.status);
  w.srs = graded.srs; // applyStatus resets srs when a word re-enters learning; keep the graded schedule
  w.ev = r.ev;
  w.updatedAt = Date.now();
  state.vocab.set(w.term, w);
  addDelta(total, { reviews: 1 });
  await commit([w], total);
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
// action: optional {label, onClick} rendered as a button inside the toast.
export function toast(msg, ms = 2600, action = null) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  if (action) {
    const b = Object.assign(document.createElement('button'), { className: 'toast-action', textContent: action.label });
    b.addEventListener('click', () => { el.hidden = true; action.onClick(); });
    el.append(' ', b);
    ms = Math.max(ms, 6000);
  }
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
