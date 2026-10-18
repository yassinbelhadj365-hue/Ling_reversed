// Visible progress: known-word milestones (with a small celebration) and the weekly recap.
import * as db from './db.js';
import { state, lang, langName, dayKey, esc, activityByDay, onKnownChange } from './state.js';
import { KNOWN } from './srs.js';

export const MILESTONES = [100, 250, 500, 1000, 2000, 3000, 5000, 10000];

// Known single words in the current language (phrases don't count).
export function knownCount() {
  let n = 0;
  for (const w of state.vocab.values()) if (!w.isPhrase && w.status === KNOWN) n++;
  return n;
}

// The highest milestone at or below n, or 0.
export const milestoneFor = (n) => MILESTONES.filter((m) => m <= n).pop() || 0;

// Progress from the last milestone to the next one (people push harder as a goal gets
// close, so the bar shows this stretch, not the whole way). -> {known, from, to, pct, left} | null
export function milestoneProgress(known = knownCount()) {
  const to = MILESTONES.find((m) => m > known);
  if (!to) return null;
  const from = milestoneFor(known);
  return { known, from, to, left: to - known, pct: Math.floor(((known - from) / (to - from)) * 100) };
}

export function milestoneBarHtml(known) {
  const p = milestoneProgress(known);
  if (!p) return '';
  return `<div class="milestone-bar">
    <div class="row spread small"><span><b>${p.left.toLocaleString()}</b> ${p.left === 1 ? 'word' : 'words'} to ${p.to.toLocaleString()} known</span>
      <span class="muted">${p.known.toLocaleString()} / ${p.to.toLocaleString()}</span></div>
    <div class="goal" role="img" aria-label="${p.pct}% of the way to ${p.to} known words"><div style="width:${p.pct}%"></div></div>
  </div>`;
}

const ROW = () => `milestone|${lang()}`; // synced, so a milestone is celebrated once, not per device

// Celebrates a milestone the first time it's reached. The first check for a language only
// records where the learner already is, so existing progress doesn't trigger a burst.
export async function checkMilestone() {
  const reached = milestoneFor(knownCount());
  const seen = await db.getSetting(ROW(), null);
  if (seen === null) return db.setSetting(ROW(), reached);
  if (reached <= seen) return;
  await db.setSetting(ROW(), reached);
  const next = MILESTONES.find((m) => m > reached);
  showCelebration({
    title: `${reached.toLocaleString()} ${langName(lang())} words known!`,
    body: next ? `Every one of them came from your own reading and listening. Next stop: ${next.toLocaleString()}.`
      : 'Every one of them came from your own reading and listening.',
  });
}

export function showCelebration({ title, body }) {
  document.querySelector('.celebrate')?.remove();
  const el = document.createElement('div');
  el.className = 'celebrate';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', title);
  const bits = Array.from({ length: 24 }, (_, i) =>
    `<i style="left:${(i * 37) % 100}%;animation-delay:${(i % 8) * 0.12}s;--c:${['var(--accent)', 'var(--good)', 'var(--w-1)', 'var(--w-phrase)'][i % 4]}"></i>`).join('');
  el.innerHTML = `<div class="confetti" aria-hidden="true">${bits}</div>
    <div class="card celebrate-card">
      <p class="celebrate-emoji" aria-hidden="true">🎉</p>
      <h2>${esc(title)}</h2>
      <p>${esc(body)}</p>
      <button class="btn primary" data-close>Keep going</button>
    </div>`;
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
  document.body.append(el);
  el.querySelector('[data-close]').focus();
}

// ---------- weekly recap ----------

// Monday 00:00 of the week containing d (local time).
export function weekStart(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

// What happened between start (inclusive) and end (exclusive):
// {learned: [term] (newest first), lingqs, mins, days}
export function recapOf(byDate, start, end) {
  const from = dayKey(start), to = dayKey(end);
  let lingqs = 0, secs = 0, days = 0;
  for (const r of byDate.values()) {
    if (r.date < from || r.date >= to) continue;
    lingqs += r.lingqs || 0;
    secs += r.secs || 0;
    if (r.known > 0 || r.lingqs > 0 || r.read > 0 || r.reviews > 0 || r.secs > 0) days++;
  }
  const learned = [...state.vocab.values()]
    .filter((w) => !w.isPhrase && w.status === KNOWN && w.knownAt >= start.getTime() && w.knownAt < end.getTime())
    .sort((a, b) => b.knownAt - a.knownAt)
    .map((w) => w.term);
  return { learned, lingqs, mins: Math.round(secs / 60), days };
}

const recapHtml = (r, heading, extra = '') => `
  <div class="card recap">
    <div class="row spread"><h3>${heading}</h3>${extra}</div>
    <div class="recap-nums">
      <span><b>${r.learned.length}</b> ${r.learned.length === 1 ? 'word' : 'words'} learned</span>
      <span><b>${r.mins}</b> min studied</span>
      <span><b>${r.days}</b> of 7 days</span>
      <span><b>${r.lingqs}</b> new LingQs</span>
    </div>
    ${r.learned.length ? `<p class="small recap-words" dir="auto">${r.learned.slice(0, 12).map(esc).join(' · ')}${r.learned.length > 12 ? ` · +${r.learned.length - 12} more` : ''}</p>` : ''}
  </div>`;

const DISMISS = () => `local:recap-closed|${lang()}`; // per device

// Last week's recap for the top of the Library, until it's closed. '' when there's nothing to show.
export async function lastWeekCard() {
  const thisWeek = weekStart();
  const lastWeek = new Date(thisWeek);
  lastWeek.setDate(lastWeek.getDate() - 7);
  if ((await db.getSetting(DISMISS(), '')) === dayKey(thisWeek)) return '';
  const r = recapOf(await activityByDay(), lastWeek, thisWeek);
  if (!r.days) return '';
  return recapHtml(r, 'Last week', '<button class="btn small" data-act="close-recap" aria-label="Close the recap">✕</button>');
}

export async function closeLastWeekCard() {
  await db.setSetting(DISMISS(), dayKey(weekStart()));
}

// This week so far, for Stats.
export async function thisWeekCard() {
  const start = weekStart();
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return recapHtml(recapOf(await activityByDay(), start, end), 'This week so far');
}

// Check after every change to the number of known words.
onKnownChange(() => { checkMilestone().catch(() => {}); });
