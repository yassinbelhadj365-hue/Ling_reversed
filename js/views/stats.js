import * as db from '../db.js';
import { state, lang, langName, dayKey, esc, plural, activityByDay, streakOf } from '../state.js';
import { isLearning } from '../srs.js';
import { poolStats } from './vocab.js';
import { thisWeekCard, knownCount, MILESTONES } from '../progress.js';

const METRICS = [
  ['mins', 'Minutes studied (reading, listening, review)'],
  ['known', 'Words learned (moved to known)'],
  ['lingqs', 'LingQs created'],
  ['reviews', 'Flashcards reviewed'],
  ['read', 'Words read'],
];
const DAYS = 30;

function lastDays(n) {
  const out = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push(x);
  }
  return out;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => m >= v);
}

export async function renderStats(view) {
  const byDate = await activityByDay();
  for (const r of byDate.values()) r.mins = Math.round(r.secs / 60);
  const today = byDate.get(dayKey()) || { known: 0, lingqs: 0, read: 0, reviews: 0, secs: 0, mins: 0 };
  const lessons = await db.byLang('lessons', lang());
  const pool = poolStats();
  const due = [...state.vocab.values()].filter((w) => isLearning(w.status) && (w.srs?.due ?? 0) <= Date.now()).length;

  const streak = streakOf(byDate);
  const totalHours = [...byDate.values()].reduce((s, r) => s + r.secs, 0) / 3600;

  const goal = state.settings.dailyMinutes;
  const todayMins = Math.floor(today.secs / 60);
  const goalPct = Math.min(100, Math.round((today.secs / 60 / goal) * 100));
  let metric = 'mins';
  const week = await thisWeekCard();
  const known = knownCount();
  const nextMilestone = MILESTONES.find((m) => m > known);

  view.innerHTML = `
    <h1>${esc(langName(lang()))} stats</h1>
    <div class="card">
      <div class="row spread"><b>Today’s goal${goalPct >= 100 ? ' ✓' : ''}</b><span class="small muted">${todayMins} / ${goal} minutes</span></div>
      <div class="goal" role="img" aria-label="${goalPct}% of daily goal"><div style="width:${goalPct}%"></div></div>
      <p class="small muted" style="margin:8px 0 0">${goalPct >= 100 ? 'Goal reached. Anything more is a bonus. ' : todayMins ? '' : 'Reading, listening and reviewing all count. '}Today: ${plural(Math.max(0, today.known), 'word')} learned · ${plural(today.lingqs, 'LingQ')} · ${plural(today.reviews, 'review')} · ${plural(today.read, 'word')} read</p>
    </div>
    ${week}
    <div class="tiles">
      <div class="tile"><div class="v">${pool.known.toLocaleString()}</div><div class="l">Known words${nextMilestone ? ` · next milestone ${nextMilestone.toLocaleString()}` : ''}</div></div>
      <div class="tile"><div class="v">${pool.learning.toLocaleString()}</div><div class="l">LingQs</div></div>
      <div class="tile"><div class="v">${Math.round(pool.coverage * 100)}%</div><div class="l">Coverage of your content</div></div>
      <div class="tile"><div class="v">${due.toLocaleString()}</div><div class="l">Reviews due</div></div>
      <div class="tile"><div class="v">${streak.days}</div><div class="l">Day streak${streak.saved ? ` (${plural(streak.saved, 'day')} saved)` : ''}</div></div>
      <div class="tile"><div class="v">${totalHours < 10 ? totalHours.toFixed(1) : Math.round(totalHours)} h</div><div class="l">Time studied</div></div>
      <div class="tile"><div class="v">${lessons.length}</div><div class="l">Lessons</div></div>
    </div>
    <h2 id="chart-title"></h2>
    <div class="segmented" role="group" aria-label="Metric" style="margin-bottom:8px">
      ${METRICS.map(([k, label]) => `<button data-m="${k}">${label.split(' (')[0]}</button>`).join('')}
    </div>
    <div class="chart" id="chart"><svg aria-hidden="true"></svg><div class="tooltip" hidden></div></div>
    <details style="margin-top:8px"><summary class="small">Show as table</summary><div class="table-wrap" id="chart-table"></div></details>`;

  const chart = view.querySelector('#chart');
  const svg = chart.querySelector('svg');
  const tip = chart.querySelector('.tooltip');
  const days = lastDays(DAYS);

  function draw() {
    view.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === metric));
    const label = METRICS.find((m) => m[0] === metric)[1];
    view.querySelector('#chart-title').textContent = `${label} — last ${DAYS} days`;
    const values = days.map((day) => Math.max(0, byDate.get(dayKey(day))?.[metric] || 0));
    const fmtDay = (day) => day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    const W = Math.max(280, svg.clientWidth || chart.clientWidth - 32);
    const H = 180, left = 32, bottom = 22, top = 8;
    const plotW = W - left, plotH = H - bottom - top;
    const max = niceMax(Math.max(...values));
    const band = plotW / DAYS;
    const barW = Math.max(2, band - 2); // 2px gap between bars
    const y = (v) => top + plotH - (v / max) * plotH;

    const ticks = [0, max / 2, max];
    let out = `<g class="grid">${ticks.map((t) => `<line x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>`;
    out += `<g class="axis">${ticks.map((t) => `<text x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t).toLocaleString()}</text>`).join('')}`;
    days.forEach((day, i) => {
      if (i % 7 === (DAYS - 1) % 7) out += `<text x="${left + i * band + band / 2}" y="${H - 4}" text-anchor="middle">${fmtDay(day)}</text>`;
    });
    out += '</g>';
    values.forEach((v, i) => {
      const x = left + i * band + (band - barW) / 2;
      const h = Math.max(0, y(0) - y(v));
      const r = Math.min(4, h, barW / 2);
      const bar = v > 0
        ? `<path class="bar" fill="var(--bar)" d="M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + barW - r} Q${x + barW},${y(v)} ${x + barW},${y(v) + r} V${y(0)} Z"/>`
        : '';
      out += `<g class="col" data-i="${i}">${bar}<rect class="hit" x="${left + i * band}" y="${top}" width="${band}" height="${plotH}"/></g>`;
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
    chart.setAttribute('aria-label', `${label}, last ${DAYS} days. Total ${values.reduce((a, b) => a + b, 0)}.`);

    svg.onpointermove = (e) => {
      const col = e.target.closest?.('g.col');
      if (!col) { tip.hidden = true; return; }
      const i = Number(col.dataset.i);
      const box = chart.getBoundingClientRect();
      const sbox = svg.getBoundingClientRect();
      tip.hidden = false;
      tip.textContent = `${fmtDay(days[i])}: ${values[i].toLocaleString()}`;
      tip.style.left = `${sbox.left - box.left + ((left + i * band + band / 2) / W) * sbox.width}px`;
      tip.style.top = `${sbox.top - box.top + (y(values[i]) / H) * sbox.height}px`;
    };
    svg.onpointerleave = () => { tip.hidden = true; };

    view.querySelector('#chart-table').innerHTML = `<table><thead><tr><th>Day</th><th>${esc(label)}</th></tr></thead><tbody>${
      days.map((day, i) => `<tr><td>${fmtDay(day)}</td><td>${values[i].toLocaleString()}</td></tr>`).reverse().join('')}</tbody></table>`;
  }

  view.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { metric = b.dataset.m; draw(); }));
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  draw();
  return () => window.removeEventListener('resize', onResize);
}
