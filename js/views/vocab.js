// The word pool: every word you have met in imported content, and where you stand with it.
import { state, lang, langName, setStatusMany, undoAuto, esc, toast, plural, download } from '../state.js';
import { countWords } from '../text.js';
import { NEW, KNOWN, IGNORED, isLearning } from '../srs.js';
import { progress } from '../knowledge.js';
import { openPanel } from '../panel.js';

const WEEK = 7 * 864e5;
const recentAuto = (w) => !!w.ev?.prev && w.ev.autoAt > Date.now() - WEEK;

const FILTERS = [
  ['auto', 'Auto-changed', recentAuto],
  ['new', 'New', (w) => w.status === NEW],
  ['lingq', 'LingQs', (w) => isLearning(w.status)],
  ['known', 'Known', (w) => w.status === KNOWN],
  ['ignored', 'Ignored', (w) => w.status === IGNORED],
  ['all', 'All', () => true],
];
const SORTS = [
  ['freq', 'Most frequent', (a, b) => (b.freq || 0) - (a.freq || 0)],
  ['recent', 'Recently changed', (a, b) => b.updatedAt - a.updatedAt],
  ['az', 'A → Z', (a, b) => a.term.localeCompare(b.term, lang())],
];
const STATUS_TEXT = { [NEW]: 'New', 1: 'LingQ 1', 2: 'LingQ 2', 3: 'LingQ 3', 4: 'LingQ 4', [KNOWN]: 'Known', [IGNORED]: 'Ignored' };
const STATUS_COLOR = { [NEW]: 'var(--w-new)', 1: 'var(--w-1)', 2: 'var(--w-2)', 3: 'var(--w-3)', 4: 'var(--w-4)', [KNOWN]: 'var(--good)', [IGNORED]: 'var(--surface-2)' };

export function poolStats() {
  let known = 0, learning = 0, fresh = 0, ignored = 0, occKnown = 0, occAll = 0;
  for (const w of state.vocab.values()) {
    if (w.isPhrase) { if (isLearning(w.status)) learning++; continue; }
    if (w.status === IGNORED) { ignored++; continue; }
    occAll += w.freq || 0;
    if (w.status === KNOWN) { known++; occKnown += w.freq || 0; }
    else if (isLearning(w.status)) learning++;
    else fresh++;
  }
  return { known, learning, fresh, ignored, size: known + learning + fresh, coverage: occAll ? occKnown / occAll : 0 };
}

export async function renderVocab(view, initialFilter) {
  let filter = FILTERS.some((f) => f[0] === initialFilter) ? initialFilter : 'new';
  let sort = 'freq';
  let query = '';
  let limit = 200;

  const s = poolStats();
  view.innerHTML = `
    <h1>${esc(langName(lang()))} word pool</h1>
    <p class="muted small">Every word from everything you import lands here, with how often it appears.
      Words become <b>known</b> when you mark them or page past them; <b>LingQs</b> are the ones you are learning.</p>
    <div class="tiles">
      <div class="tile"><div class="v">${s.size.toLocaleString()}</div><div class="l">Words in pool</div></div>
      <div class="tile"><div class="v">${s.known.toLocaleString()}</div><div class="l">Known</div></div>
      <div class="tile"><div class="v">${s.learning.toLocaleString()}</div><div class="l">LingQs (learning)</div></div>
      <div class="tile"><div class="v">${s.fresh.toLocaleString()}</div><div class="l">Not yet known</div></div>
      <div class="tile" title="Share of all word occurrences in your imported content that you know">
        <div class="v">${Math.round(s.coverage * 100)}%</div><div class="l">Text coverage</div></div>
    </div>
    <h2>Words</h2>
    <div class="row" style="margin-bottom:8px">
      <div class="segmented" role="group" aria-label="Filter">${FILTERS.map(([k, label]) => `<button data-f="${k}">${label}</button>`).join('')}</div>
      <select id="sort" aria-label="Sort" style="width:auto">${SORTS.map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}</select>
    </div>
    <div class="field"><input type="search" id="q" placeholder="Search words or hints…" aria-label="Search words"></div>
    <div id="table"></div>
    <div class="row" style="margin-top:8px">
      <button class="btn small" id="more" hidden>Show more</button>
      <button class="btn small" id="bulk" hidden></button>
      <button class="btn small" id="csv">Export CSV</button>
    </div>
    <details class="card" style="margin-top:16px">
      <summary><b>Add words you already know</b></summary>
      <p class="small muted">Paste a list of words (or any text). Every word in it is marked as known, so lessons start with an accurate picture of your vocabulary.</p>
      <textarea id="known-text" style="min-height:100px"></textarea>
      <button class="btn" id="known-go" style="margin-top:8px">Mark as known</button>
    </details>`;

  const $ = (sel) => view.querySelector(sel);

  function visible() {
    const f = FILTERS.find((x) => x[0] === filter)[2];
    const q = query.toLocaleLowerCase();
    return [...state.vocab.values()]
      .filter((w) => f(w) && (!q || w.term.includes(q) || (w.hint || '').toLocaleLowerCase().includes(q)))
      .sort(filter === 'auto' ? (a, b) => b.ev.autoAt - a.ev.autoAt : SORTS.find((x) => x[0] === sort)[2]);
  }

  function encounters(w) {
    if (!isLearning(w.status) || !state.settings.autoStatus) return '';
    const p = progress(w, state.settings.autoPace);
    return `${Math.min(p.done, p.total)} / ${p.total}`;
  }

  function changeText(w) {
    if (!recentAuto(w)) return '';
    return `${STATUS_TEXT[w.ev.prev.status]} → ${STATUS_TEXT[w.status]}`;
  }

  function draw() {
    view.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
    const rows = visible();
    $('#table').innerHTML = rows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Word</th><th>Status</th><th>Hint</th><th>Encounters to known</th><th>Seen in text</th><th>Lessons</th><th>Auto change</th></tr></thead>
        <tbody>${rows.slice(0, limit).map((w) => `
          <tr>
            <td><a href="javascript:void 0" data-term="${esc(w.term)}" dir="auto">${esc(w.term)}</a></td>
            <td><span class="dot" style="background:${STATUS_COLOR[w.status]}"></span>${STATUS_TEXT[w.status]}</td>
            <td class="hint" dir="auto">${esc(w.hint || '')}</td>
            <td>${encounters(w)}</td>
            <td>${(w.freq || 0).toLocaleString()}×</td>
            <td>${w.lessons?.length || 0}</td>
            <td>${recentAuto(w) ? `${changeText(w)} <button class="btn small" data-revert="${esc(w.term)}">Revert</button>` : ''}</td>
          </tr>`).join('')}
        </tbody></table></div>
      <p class="small muted">${rows.length > limit ? `Showing ${limit.toLocaleString()} of ` : ''}${plural(rows.length, 'word')}</p>`
      : '<div class="empty">No words here yet.</div>';
    $('#more').hidden = rows.length <= limit;
    const bulk = $('#bulk');
    bulk.hidden = filter !== 'new' || !rows.length;
    bulk.textContent = `Mark all ${rows.length.toLocaleString()} shown as known`;
  }

  view.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; limit = 200; draw(); }));
  $('#sort').addEventListener('change', (e) => { sort = e.target.value; draw(); });
  $('#q').addEventListener('input', (e) => { query = e.target.value.trim(); limit = 200; draw(); });
  $('#more').addEventListener('click', () => { limit += 500; draw(); });
  $('#table').addEventListener('click', async (e) => {
    const rev = e.target.closest('[data-revert]');
    if (rev) {
      await undoAuto(rev.dataset.revert);
      toast(`Reverted “${rev.dataset.revert}”`);
      return draw();
    }
    const a = e.target.closest('[data-term]');
    if (!a) return;
    e.preventDefault();
    const w = state.vocab.get(a.dataset.term);
    openPanel(a.dataset.term, { context: w?.context || '', onChange: draw });
  });

  $('#bulk').addEventListener('click', async () => {
    const rows = visible();
    if (!confirm(`Mark ${rows.length.toLocaleString()} words as known?`)) return;
    const n = await setStatusMany(rows.map((w) => w.term), KNOWN, { manual: true });
    toast(`${plural(n, 'word')} marked as known`);
    renderVocab(view);
  });

  $('#known-go').addEventListener('click', async () => {
    const { counts } = countWords([{ text: $('#known-text').value }], lang());
    const terms = Object.keys(counts);
    if (!terms.length) return toast('No words found.');
    const n = await setStatusMany(terms, KNOWN, { manual: true });
    toast(`${plural(n, 'word')} marked as known`);
    renderVocab(view);
  });

  $('#csv').addEventListener('click', () => {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['term', 'status', 'hint', 'context', 'frequency', 'lessons'].join(',')];
    for (const w of visible()) {
      lines.push([w.term, STATUS_TEXT[w.status], w.hint, w.context, w.freq || 0, w.lessons?.length || 0].map(cell).join(','));
    }
    download(`${lang()}-${filter}-words.csv`, '﻿' + lines.join('\n'), 'text/csv');
  });

  draw();
}
