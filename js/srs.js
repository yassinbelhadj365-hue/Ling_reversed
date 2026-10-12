// Spaced repetition (a simplified SM-2) tied to LingQ-style word statuses.
//
// Status: 0 = new (in your pool, not yet studied), 1–4 = LingQ learning levels,
//         5 = known, -1 = ignored (names, junk).
export const NEW = 0;
export const KNOWN = 5;
export const IGNORED = -1;
export const isLearning = (s) => s >= 1 && s <= 4;

const DAY = 864e5;

export function freshSrs() {
  return { due: Date.now(), interval: 0, ease: 2.5, reps: 0 };
}

// grade: 'again' | 'hard' | 'good' | 'easy'
// Returns {srs, status}: the new schedule and the word's new status.
export function grade(word, g) {
  const s = { ...(word.srs || freshSrs()) };
  let status = isLearning(word.status) ? word.status : 1;
  const now = Date.now();

  if (g === 'again') {
    s.reps = 0;
    s.interval = 0;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.due = now + 10 * 60 * 1000;
    status = 1;
  } else if (g === 'hard') {
    s.interval = Math.max(1, Math.round(s.interval * 1.2));
    s.ease = Math.max(1.3, s.ease - 0.15);
    s.reps += 1;
    s.due = now + s.interval * DAY;
  } else {
    const base = s.reps === 0 ? 1 : s.reps === 1 ? 3 : Math.round(Math.max(1, s.interval) * s.ease);
    s.interval = g === 'easy' ? Math.round(base * 1.4) + 1 : base;
    if (g === 'easy') s.ease += 0.15;
    s.reps += 1;
    s.due = now + s.interval * DAY;
    status = Math.min(4, status + (g === 'easy' ? 2 : 1));
  }
  return { srs: s, status };
}

export function previewInterval(word, g) {
  const { srs } = grade(word, g);
  const ms = srs.due - Date.now();
  if (ms < DAY) return `${Math.max(1, Math.round(ms / 60000))}m`;
  const d = Math.round(ms / DAY);
  return d < 30 ? `${d}d` : d < 365 ? `${Math.round(d / 30)}mo` : `${(d / 365).toFixed(1)}y`;
}
