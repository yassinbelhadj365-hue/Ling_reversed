// Automatic word levels from evidence (see docs/PLAN.md, C1).
// Pure functions: no DOM, no database. Each takes a word record and returns
// the new {status, ev} without mutating the word; state.js applies the result.
//
// Evidence kept on word.ev:
//   pre     points toward "already known" for a word never looked up
//   look    number of lookups (taps in the reader); lookAt = time of the last one
//   base    LingQ level set by the last lookup or manual choice
//   since   clean encounters (seen without a lookup) since then
//   rev     level earned through flashcard review
//   day/today  per-day encounter counter, for spacing
//   src     'manual' when you set the status yourself, otherwise 'auto'
//   prev, autoAt   one-level undo snapshot of the last automatic change
import { NEW, KNOWN, IGNORED, isLearning } from './srs.js';

export const RULES = {
  // An untapped pass while reading at your own pace is strong evidence that you
  // know the word; an untapped pass while a video plays is weaker
  // (reading needs ~98% coverage, listening ~95%: Hu & Nation 2000, van Zeeland & Schmitt 2013).
  readPass: 2,
  listenPass: { 1: 2, 2: 1, 3: 0.67 }, // keyed by settings.listenPasses → passes needed
  newToKnown: 2,
  // Clean encounters to climb 1→2→3→4→Known: ~10 in total
  // (≈8–10 encounters for incidental learning: Pellicer-Sánchez 2015).
  need: [2, 2, 3, 3],
  maxPerDay: 3,          // spaced exposure beats massed exposure (Cepeda et al. 2006)
  reviewKnownDays: 21,   // a review interval ≥ 21 days counts as known (Migaku's rule)
  relookupMinutes: 10,   // re-tapping within this window doesn't demote again
  pace: { cautious: 1.5, normal: 1, fast: 0.7 },
};

const MIN = 60 * 1000;

export function evOf(w) {
  const ev = { pre: 0, look: 0, lookAt: 0, base: 0, since: 0, rev: 0, day: '', today: 0, ...(w.ev || {}) };
  delete ev.prev;
  if (!w.ev && isLearning(w.status)) ev.base = w.status; // records created before this feature
  return ev;
}

export function needFor(pace = 'normal') {
  const f = RULES.pace[pace] || 1;
  return RULES.need.map((n) => Math.max(1, Math.round(n * f)));
}

export function levelFrom(base, since, pace) {
  const need = needFor(pace);
  let lvl = base;
  let left = since;
  while (lvl >= 1 && lvl < KNOWN && left >= need[lvl - 1]) {
    left -= need[lvl - 1];
    lvl++;
  }
  return lvl;
}

// Progress toward known for a LingQ: {done, total} clean encounters.
export function progress(w, pace) {
  const ev = evOf(w);
  const need = needFor(pace);
  const from = Math.max(1, Math.min(4, ev.base || 1));
  return { done: ev.since, total: need.slice(from - 1).reduce((a, b) => a + b, 0) };
}

export function computeStatus(ev, pace) {
  if (ev.look === 0 && ev.base === 0) return ev.pre >= RULES.newToKnown ? KNOWN : NEW;
  const lvl = Math.min(KNOWN, Math.max(levelFrom(ev.base, ev.since, pace), ev.rev || 0));
  return lvl >= KNOWN ? KNOWN : lvl;
}

const isPinned = (w, opts) =>
  w.status === IGNORED ||
  (w.ev?.src === 'manual' && (w.status === KNOWN || opts.autoAdjustManual === false));

function withUndo(w, ev, status, now) {
  if (status !== w.status) {
    const before = w.ev ? { ...w.ev } : undefined;
    if (before) delete before.prev;
    ev.prev = { status: w.status, ev: before };
    ev.autoAt = now;
  } else if (w.ev?.prev) {
    ev.prev = w.ev.prev;
  }
  return { status, ev };
}

// You tapped the word in the reader: it becomes (or drops back to) a LingQ.
export function onLookup(w, opts = {}) {
  const now = opts.now ?? Date.now();
  const ev = evOf(w);
  const recent = ev.lookAt && now - ev.lookAt < RULES.relookupMinutes * MIN;
  ev.look++;
  ev.lookAt = now;
  if (isPinned(w, opts) || (recent && isLearning(w.status))) return withUndo(w, ev, w.status, now);
  ev.base = w.status === NEW || w.status === KNOWN ? 1 : Math.max(1, w.status - 1);
  ev.since = 0;
  ev.rev = 0;
  ev.src = 'auto';
  return withUndo(w, ev, ev.base, now);
}

// You read (kind 'read') or heard (kind 'listen') the word without tapping it.
// Returns null when the pass doesn't count.
export function onPass(w, kind, opts = {}) {
  const now = opts.now ?? Date.now();
  if (isPinned(w, opts) || w.status === KNOWN) return null;
  const ev = evOf(w);
  if (ev.look === 0 && ev.base === 0) {
    const listen = RULES.listenPass[opts.listenPasses] ?? RULES.listenPass[2];
    ev.pre += kind === 'read' ? RULES.readPass : listen;
  } else {
    if (ev.day !== opts.day) { ev.day = opts.day; ev.today = 0; }
    if (ev.today >= RULES.maxPerDay) return null;
    ev.today++;
    ev.since++;
  }
  return withUndo(w, ev, computeStatus(ev, opts.pace), now);
}

// You set the status yourself in the panel, vocab list or review.
// Returns the new ev (undefined = start over with no evidence).
export function onManual(w, status) {
  if (status === NEW) return undefined;
  const ev = evOf(w);
  ev.src = 'manual';
  if (isLearning(status)) { ev.base = status; ev.since = 0; ev.rev = 0; }
  return ev;
}

// A flashcard grade. `graded` is srs.grade()'s result: {srs, status}.
export function onReview(w, g, graded, opts = {}) {
  const ev = evOf(w);
  if (g === 'again') { ev.base = 1; ev.since = 0; ev.rev = 1; }
  else ev.rev = Math.max(ev.rev || 0, graded.status);
  if (ev.base === 0) ev.base = 1;
  let status = computeStatus(ev, opts.pace);
  if ((g === 'good' || g === 'easy') && graded.srs.interval >= RULES.reviewKnownDays) status = KNOWN;
  if (g === 'again') status = 1;
  if (w.ev?.prev) ev.prev = w.ev.prev;
  return { status, ev };
}

// Restore the state from before the last automatic change.
export function undoPatch(w) {
  const prev = w.ev?.prev;
  return prev ? { status: prev.status, ev: prev.ev } : null;
}
