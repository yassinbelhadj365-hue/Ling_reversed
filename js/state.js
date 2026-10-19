// App-wide state: settings, the in-memory vocabulary of the current language,
// activity tracking, text-to-speech and small DOM helpers.
import * as db from './db.js';
import { NEW, KNOWN, IGNORED, isLearning, freshSrs, grade } from './srs.js';
import { onLookup, onPass, onManual, onReview, undoPatch, evOf } from './knowledge.js';
import { countWords } from './text.js';

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
  playerSize: 'large', // listen mode: 'normal' | 'large' | 'theater'
  asrModel: 'base',    // AI transcription model: 'base' | 'small' (asr.js MODELS)
  aiAuto: true,        // ask the AI automatically on tap (otherwise the panel shows an Explain button)
  lookAhead: false,   // look up a page's words in the background, so taps answer at once (explain.js prefetch; uses quota)
  geminiModel: '',     // Gemini model for translations and explanations ('' = newest free Flash, ai.js)
  sentenceMode: false, // reader: one sentence at a time
  dailyMinutes: 10,    // daily goal: minutes of reading, listening or review (state.startStudyTimer)
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

// ---------- meanings (senses) ----------
// A word keeps the meanings the learner has met, each with the sentence it came from
// (the AI's "meaning here", read from that transcript). Meeting the word with a meaning
// that isn't on the list makes it a fresh LingQ, even when it was known or pinned:
// knowing one meaning of a word doesn't mean knowing the others.
// r: an explain() answer for `term` in `sentence`.
// -> null (nothing to record) | {isNew: false} (first meaning) | {isNew: true, before: [meaning], undo()}
export async function recordSense(term, sentence, r) {
  const w = getWord(term);
  const meaning = String(r?.meaning_native || '').trim();
  if (!w || !meaning || !sentence || w.status === IGNORED) return null;
  const senses = w.senses || [];
  if (senses.some((s) => s.context === sentence)) return null;
  const same = Number(r.same_meaning_as) || 0;
  if (senses.length && same >= 1 && same <= senses.length) return null;
  const sense = { meaning, explain: String(r.meaning_target || ''), context: sentence, contextTr: String(r.translation || ''), at: Date.now() };
  // The first meaning, or another one while the word is still new: just remember it.
  if (!senses.length || w.status === NEW) {
    w.senses = [...senses, sense];
    if (!w.hint) w.hint = meaning;
    await saveWord(w);
    return { isNew: false };
  }
  const before = { status: w.status, srs: w.srs, lingqAt: w.lingqAt, hint: w.hint, context: w.context, contextTr: w.contextTr, ev: w.ev, senses };
  w.senses = [...senses, sense];
  Object.assign(w, { hint: meaning, context: sentence, contextTr: sense.contextTr });
  const total = applyStatus(w, 1);
  w.srs = freshSrs();
  w.lingqAt = Date.now();
  total.lingqs = 1; // a new meaning counts as a new LingQ
  w.ev = { ...evOf(w), base: 1, since: 0, rev: 0, src: 'auto' };
  w.updatedAt = Date.now();
  state.vocab.set(term, w);
  await commit([w], total);
  return {
    isNew: true,
    before: senses.map((s) => s.meaning),
    async undo() {
      const back = applyStatus(w, before.status);
      back.lingqs = (back.lingqs || 0) - 1;
      Object.assign(w, before, { updatedAt: Date.now() });
      state.vocab.set(term, w);
      await commit([w], back);
    },
  };
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

// Replace the text of one lesson line (a transcript correction) and keep the
// lesson's word counts and the word pool in step. Timing marks inside the line
// no longer match the new text, so they are dropped; the line's start/end stay.
export async function updateLessonLine(lesson, i, newText) {
  const seg = lesson.segments[i];
  const before = countWords([seg], lesson.lang).counts;
  const after = countWords([{ text: newText }], lesson.lang).counts;
  seg.text = newText;
  delete seg.marks;
  if (lesson.flags) delete lesson.flags[i]; // transcript-check flags point into the old text
  const changed = [];
  for (const term of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[term] || 0) - (before[term] || 0);
    if (!delta) continue;
    const left = (lesson.words[term] || 0) + delta;
    if (left > 0) lesson.words[term] = left; else delete lesson.words[term];
    lesson.wordCount += delta;
    let w = getWord(term);
    if (!w && delta > 0) w = newWord(term);
    if (!w) continue;
    w.freq = Math.max(0, (w.freq || 0) + delta);
    if (left > 0 && !w.lessons.includes(lesson.id)) w.lessons.push(lesson.id);
    if (left <= 0) w.lessons = w.lessons.filter((id) => id !== lesson.id);
    if (w.status === NEW && !w.lessons.length && !w.hint) {
      state.vocab.delete(term);
      await db.del('words', w.key);
    } else {
      w.updatedAt = Date.now();
      state.vocab.set(term, w);
      changed.push(w);
    }
  }
  lesson.edited = (lesson.edited || 0) + 1;
  lesson.updatedAt = Date.now();
  await db.putMany('words', changed);
  await db.put('lessons', lesson);
}

// ---------- activity (per day, per language) ----------

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Called after known words increase (progress.js listens, for milestones).
const knownListeners = [];
export const onKnownChange = (fn) => knownListeners.push(fn);

export async function bumpActivity(delta) {
  if (!delta || !Object.keys(delta).length) return;
  const date = dayKey();
  const device = db.deviceId(); // one row per device and day, summed in the stats, so syncing never loses counts
  const key = `${date}|${lang()}|${device}`;
  await db.update('activity', key, (row) => {
    row = row || { key, date, lang: lang(), device, known: 0, lingqs: 0, read: 0, reviews: 0, secs: 0 };
    for (const [k, v] of Object.entries(delta)) row[k] = (row[k] || 0) + v;
    return row;
  });
  if (delta.known > 0) knownListeners.forEach((fn) => fn());
}

// ---------- study time and the daily goal ----------

// The activity of the current language added up per day (one row per device and day).
// -> Map(date -> {date, known, lingqs, read, reviews, secs})
export async function activityByDay() {
  const byDate = new Map();
  for (const r of await db.byLang('activity', lang())) {
    const sum = byDate.get(r.date) || { date: r.date, known: 0, lingqs: 0, read: 0, reviews: 0, secs: 0 };
    for (const k of ['known', 'lingqs', 'read', 'reviews', 'secs']) sum[k] += r[k] || 0;
    byDate.set(r.date, sum);
  }
  return byDate;
}

// Counts study time (reading, listening, reviewing) in 15-second steps while the page is
// visible and the learner is active: media playing, or a tap, scroll or key in the last
// minute. Shows a toast the moment the daily goal (settings.dailyMinutes) is reached.
// onStep(seconds) is called for each counted step (e.g. to time one lesson visit). -> stop()
const STUDY_STEP = 15;
export function startStudyTimer(isPlaying = () => false, onStep = null) {
  let lastInput = Date.now();
  const onInput = () => { lastInput = Date.now(); };
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  events.forEach((e) => window.addEventListener(e, onInput, { passive: true, capture: true }));
  const timer = setInterval(async () => {
    if (document.hidden || !(isPlaying() || Date.now() - lastInput < 60000)) return;
    onStep?.(STUDY_STEP);
    await bumpActivity({ secs: STUDY_STEP });
    const goal = state.settings.dailyMinutes * 60;
    const secs = (await activityByDay()).get(dayKey())?.secs || 0;
    if (secs >= goal && secs - STUDY_STEP < goal) toast(`🎯 Daily goal reached: ${state.settings.dailyMinutes} minutes today. Nice!`, 5000);
  }, STUDY_STEP * 1000);
  return () => {
    clearInterval(timer);
    events.forEach((e) => window.removeEventListener(e, onInput, { capture: true }));
  };
}

// Consecutive days with any study, counting back from today (today still counts if you
// study later). Forgiving: one missed day per week is "saved" instead of breaking it.
// byDate: activityByDay(). -> {days, saved}
export function streakOf(byDate, now = new Date()) {
  const active = (r) => !!r && (r.known > 0 || r.lingqs > 0 || r.read > 0 || r.reviews > 0 || r.secs > 0);
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  if (!active(byDate.get(dayKey(d)))) d.setDate(d.getDate() - 1);
  let days = 0, saved = 0, lastSave = -Infinity;
  for (let i = 0; i < 3650; i++, d.setDate(d.getDate() - 1)) {
    if (active(byDate.get(dayKey(d)))) { days++; continue; }
    if (i - lastSave < 7) break; // already saved a day this week
    const before = new Date(d);
    before.setDate(before.getDate() - 1);
    if (!active(byDate.get(dayKey(before)))) break; // two missed days in a row
    lastSave = i;
    saved++;
  }
  return { days, saved };
}

// ---------- text to speech ----------

// The speech engine (tests put a fake one in window.__lingoSpeech), or null.
export const tts = () => window.__lingoSpeech || ('speechSynthesis' in window ? window.speechSynthesis : null);

// An utterance in the lesson language, with the chosen voice and speed.
export function utterance(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang();
  u.rate = state.settings.ttsRate;
  const voices = (tts()?.getVoices?.() || []).filter((v) => v.lang.toLowerCase().startsWith(lang()));
  const v = voices.find((x) => x.voiceURI === state.settings.voice) || voices[0];
  if (v) u.voice = v;
  return u;
}

export function speak(text) {
  const engine = tts();
  if (!engine) return toast('Text-to-speech is not supported on this device.');
  engine.cancel();
  engine.speak(utterance(text));
}

// ---------- DOM helpers ----------

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer;
// action: optional {label, onClick} rendered as a button inside the toast.
export function toast(msg, ms = 2600, action = null) {
  const el = document.getElementById('toast');
  if (!el) return;
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
