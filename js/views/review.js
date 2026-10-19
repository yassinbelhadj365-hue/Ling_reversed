import { state, setStatus, applyReview, bumpActivity, speak, esc, plural, startStudyTimer } from '../state.js';
import { previewInterval, isLearning, KNOWN, IGNORED } from '../srs.js';

const GRADES = [['again', 'Again'], ['hard', 'Hard'], ['good', 'Good'], ['easy', 'Easy']];

function highlight(context, term) {
  const safe = esc(context);
  const words = term.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${words.join('[\\s\\S]{0,3}')})`, 'giu');
  return safe.replace(re, '<mark>$1</mark>');
}

export async function renderReview(view) {
  let queue = [];
  let idx = 0;
  let shown = false;
  let done = 0;

  const learning = () => [...state.vocab.values()].filter((w) => isLearning(w.status));
  const dueNow = () => learning().filter((w) => (w.srs?.due ?? 0) <= Date.now()).sort((a, b) => (a.srs?.due ?? 0) - (b.srs?.due ?? 0));

  function start(words) {
    queue = words.slice(0, 100);
    idx = 0;
    shown = false;
    draw();
  }

  function draw() {
    const w = queue[idx];
    if (!w) {
      const all = learning();
      view.innerHTML = `
        <h1>Review</h1>
        <div class="empty card">
          <p style="font-size:2rem;margin:0">${done ? '✅' : '🃏'}</p>
          <p>${done ? `Session done — ${plural(done, 'card')} reviewed.` : 'Nothing due right now.'}</p>
          <p class="small">${plural(all.length, 'LingQ')} in total${all.length ? `, next due ${nextDue(all)}` : ''}.</p>
          <div class="row" style="justify-content:center">
            ${all.length ? '<button class="btn" id="all">Practise all LingQs anyway</button>' : ''}
            <a class="btn primary" href="#/library">Read something</a>
          </div>
        </div>`;
      view.querySelector('#all')?.addEventListener('click', () => start([...all].sort(() => Math.random() - 0.5)));
      return;
    }
    view.innerHTML = `
      <div class="row spread"><h1>Review</h1><span class="muted small">${idx + 1} / ${queue.length}</span></div>
      <div class="card flash${shown ? '' : ' to-reveal'}">
        <div class="term" dir="auto">${esc(w.term)}</div>
        <div><button class="btn small" id="speak">🔊 Listen</button> <span class="badge">LingQ ${w.status}</span></div>
        ${w.context ? `<p class="ctx" dir="auto">${highlight(w.context, w.term)}</p>` : ''}
        ${shown
          ? `<div class="answer" dir="auto">${w.hint ? esc(w.hint) : '<span class="muted">No hint saved — tap the word in a lesson to add one.</span>'}</div>
             ${w.contextTr ? `<p class="ctx small" dir="auto">${esc(w.contextTr)}</p>` : ''}
             ${otherMeanings(w)}`
          : '<p class="muted small" id="show">Tap the card to show the meaning</p>'}
      </div>
      ${shown ? `
        <div class="grade-row grade-dock">
          ${GRADES.map(([g, label], i) => `<button class="btn" data-g="${g}">${label}<small><span class="key">${i + 1} · </span>${previewInterval(w, g)}</small></button>`).join('')}
        </div>
        <div class="row" style="margin-top:8px;justify-content:center">
          <button class="btn small" data-s="${KNOWN}">✓ I know this (K)</button>
          <button class="btn small" data-s="${IGNORED}">Ignore (X)</button>
        </div>` : ''}`;
    view.querySelector('#speak').addEventListener('click', (e) => { e.stopPropagation(); speak(w.term); });
    // The whole card reveals the meaning: no small button to aim for.
    if (!shown) view.querySelector('.flash').addEventListener('click', reveal);
    view.classList.toggle('grading', shown);
    view.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => answer(b.dataset.g)));
    view.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => setTo(Number(b.dataset.s))));
  }

  function reveal() { shown = true; draw(); }

  async function answer(g) {
    const w = queue[idx];
    await applyReview(w, g);
    if (g === 'again') queue.push(w); // see it again this session
    next();
  }

  async function setTo(status) {
    await setStatus(queue[idx].term, status, {}, { manual: true });
    await bumpActivity({ reviews: 1 });
    next();
  }

  function next() { done++; idx++; shown = false; draw(); }

  const onKey = (e) => {
    if (!queue[idx] || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    if (!shown && (k === ' ' || k === 'enter')) reveal();
    else if (shown && ['1', '2', '3', '4'].includes(k)) answer(GRADES[Number(k) - 1][0]);
    else if (shown && k === 'k') setTo(KNOWN);
    else if (shown && k === 'x') setTo(IGNORED);
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  start(dueNow());
  const stopTimer = startStudyTimer(); // review time counts toward the daily goal
  return () => { document.removeEventListener('keydown', onKey); stopTimer(); view.classList.remove('grading'); };
}

// The card is about the meaning met most recently (its sentence and hint); the word's
// earlier meanings are listed after the answer, so the two aren't confused.
function otherMeanings(w) {
  const others = (w.senses || []).filter((s) => s.context !== w.context).map((s) => s.meaning);
  return others.length ? `<p class="small muted">Also met as: ${others.map((m) => `“${esc(m)}”`).join(', ')}</p>` : '';
}

function nextDue(words) {
  const t = Math.min(...words.map((w) => w.srs?.due ?? Date.now()));
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins < 60) return `in ${Math.max(1, mins)} min`;
  if (mins < 1440) return `in ${Math.round(mins / 60)} h`;
  return `in ${Math.round(mins / 1440)} days`;
}
