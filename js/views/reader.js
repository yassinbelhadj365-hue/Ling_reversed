// The reader: highlighted words, phrase selection, paging, and media sync.
import * as db from '../db.js';
import {
  state, statusOf, setStatusMany, applyEvents, undoAuto, markSeen, bumpActivity, removeLessonFromPool,
  speak, esc, toast, plural,
} from '../state.js';
import { tokenize, formatTime, sentenceAround } from '../text.js';
import { NEW, KNOWN, isLearning } from '../srs.js';
import { openPanel, closePanel, panelTerm } from '../panel.js';
import { createPlayer } from '../player.js';
import { buildTimeline, activeIndex } from '../sync.js';

function paginate(segments, pageSize, lang) {
  const pages = [];
  let cur = [];
  let count = 0;
  segments.forEach((seg, i) => {
    const n = tokenize(seg.text, lang).filter((t) => t.n).length;
    if (cur.length && count + n > pageSize) { pages.push(cur); cur = []; count = 0; }
    cur.push(i);
    count += n;
  });
  if (cur.length) pages.push(cur);
  return pages.length ? pages : [[]];
}

function statusClass(term) {
  const s = statusOf(term);
  return s === NEW ? 'st-0' : isLearning(s) ? `st-${s}` : '';
}

export async function renderReader(view, id) {
  const lesson = await db.get('lessons', Number(id));
  if (!lesson) {
    view.innerHTML = '<div class="empty">This lesson no longer exists. <a href="#/library">Back to library</a></div>';
    return;
  }
  lesson.openedAt = Date.now();
  await db.put('lessons', lesson);

  const pages = paginate(lesson.segments, state.settings.pageSize, lesson.lang);
  let page = Math.min(lesson.page || 0, pages.length - 1);
  let clicked = new Set();
  const media = await db.get('media', lesson.id);
  const timed = lesson.segments.some((s) => s.start != null);
  const cleanups = [];

  view.innerHTML = `
    <div class="reader-head">
      <h1 dir="auto">${esc(lesson.title)}</h1>
      <div class="row">
        <a class="badge session-chip" id="session-chip" href="#/vocab/auto" title="Automatic changes this session — tap to review or revert" hidden></a>
        <button class="btn small" id="tts" title="Read this page aloud">🔊 Listen</button>
        <button class="btn small danger" id="del">Delete</button>
      </div>
    </div>
    <div class="media-box" id="media"></div>
    <div class="legend">
      <span><i style="background:var(--w-new)"></i>New</span>
      <span><i style="background:var(--w-1)"></i>LingQ 1–4</span>
      <span><i style="background:var(--surface)"></i>Known</span>
      <span><i style="background:var(--surface);border-bottom:2px solid var(--w-phrase)"></i>Phrase</span>
    </div>
    <article class="reader" id="reader" lang="${esc(lesson.lang)}"></article>
    <div class="pager">
      <button class="btn" id="prev">← Back</button>
      <span class="muted small" id="pageinfo"></span>
      <button class="btn primary" id="next"></button>
    </div>
    <p class="muted small">${state.settings.autoStatus
      ? 'Tap words you don’t know. Words you read past without tapping become known; words you tapped level up as you meet them again.'
      : `Tap a word to look it up. ${state.settings.pagingKnown ? 'Turning the page marks the blue words you didn’t tap as <b>known</b>.' : ''}`}
      Select several words to save a phrase.</p>`;

  const reader = view.querySelector('#reader');

  // ---------- media ----------
  const mediaBox = view.querySelector('#media');
  const player = createPlayer(mediaBox, { youtubeId: lesson.youtubeId, blob: media?.blob, type: media?.type });
  const seek = player ? (t) => { player.seek(t); player.play(); } : null;
  const timeline = buildTimeline(lesson.segments);
  let activeIdx = -1;
  let raf = 0;

  function highlightTime(t) {
    const { idx } = activeIndex(timeline, t);
    if (idx === activeIdx) return;
    activeIdx = idx;
    reader.querySelectorAll('p.playing').forEach((p) => p.classList.remove('playing'));
    reader.querySelector(`p[data-i="${idx}"]`)?.classList.add('playing');
  }

  function tick() {
    highlightTime(player.getTime());
    raf = player.isPlaying() && !document.hidden ? requestAnimationFrame(tick) : 0;
  }

  if (player) {
    player.on('state', (playing) => { if (playing && !raf) raf = requestAnimationFrame(tick); else if (!playing) tick(); });
    cleanups.push(() => { cancelAnimationFrame(raf); player.destroy(); });
  }

  // ---------- rendering ----------
  function renderPage() {
    clicked = new Set();
    activeIdx = -1;
    reader.innerHTML = pages[page].map((i) => {
      const seg = lesson.segments[i];
      const time = timed && seek && seg.start != null
        ? `<button class="cue-time" data-t="${seg.start}" title="Play from here">▶ ${formatTime(seg.start)}</button>`
        : '';
      const words = tokenize(seg.text, lesson.lang)
        .map((t) => (t.n ? `<span class="w ${statusClass(t.n)}" data-n="${esc(t.n)}">${esc(t.t)}</span>` : esc(t.t)))
        .join('');
      return `<p class="cue" data-i="${i}" dir="auto">${time}${words}</p>`;
    }).join('') || '<p class="muted">This lesson is empty.</p>';
    markPhrases();
    view.querySelector('#pageinfo').textContent = `Page ${page + 1} of ${pages.length}`;
    view.querySelector('#prev').disabled = page === 0;
    view.querySelector('#next').textContent = page === pages.length - 1 ? 'Complete lesson ✓' : 'Next page →';
  }

  function markPhrases() {
    const phrases = [...state.vocab.values()]
      .filter((w) => w.isPhrase && isLearning(w.status))
      .map((w) => w.term.split(' '));
    if (!phrases.length) return;
    for (const p of reader.querySelectorAll('p')) {
      const spans = [...p.querySelectorAll('.w')];
      const terms = spans.map((s) => s.dataset.n);
      for (const ph of phrases) {
        for (let i = 0; i + ph.length <= terms.length; i++) {
          if (ph.every((part, j) => terms[i + j] === part)) {
            for (let j = 0; j < ph.length; j++) spans[i + j].classList.add('in-phrase');
          }
        }
      }
    }
  }

  // Re-colour after a status change (cheap: one page of spans).
  function refresh() {
    const active = panelTerm();
    for (const s of reader.querySelectorAll('.w')) {
      s.className = `w ${statusClass(s.dataset.n)}${s.dataset.n === active ? ' active' : ''}`;
    }
    markPhrases();
    track([]);
  }

  function open(term, p, spans) {
    reader.querySelectorAll('.w.active').forEach((n) => n.classList.remove('active'));
    spans.forEach((s) => s.classList.add('active'));
    const text = lesson.segments[Number(p.dataset.i)].text;
    const surface = spans.map((s) => s.textContent).join(' ');
    openPanel(term, { context: sentenceAround(text, spans.length > 1 ? spans[0].textContent : surface), onChange: refresh });
  }

  // Automatic changes made while this lesson is open: term -> {from, to}.
  const session = new Map();
  function track(changes) {
    for (const c of changes) session.set(c.term, { from: session.get(c.term)?.from ?? c.from, to: c.to });
    for (const [term, c] of session) if (statusOf(term) === c.from) session.delete(term); // undone
    const all = [...session.values()];
    const known = all.filter((c) => c.to === KNOWN).length;
    const added = all.filter((c) => isLearning(c.to) && !isLearning(c.from)).length;
    const up = all.filter((c) => isLearning(c.to) && isLearning(c.from) && c.to > c.from).length;
    const chip = view.querySelector('#session-chip');
    chip.textContent = [known && `+${known} known`, added && `+${added} LingQs`, up && `${up} ↑`].filter(Boolean).join(' · ');
    chip.hidden = !chip.textContent;
  }

  // A tap is a lookup: with automatic levels on, it makes the word a LingQ
  // (or drops a LingQ one level). Only the first tap per page counts.
  async function lookup(term) {
    const first = !clicked.has(term);
    clicked.add(term);
    if (first && state.settings.autoStatus) track(await applyEvents([{ term, type: 'lookup' }]));
  }

  reader.addEventListener('click', async (e) => {
    const cue = e.target.closest('.cue-time');
    if (cue) { seek?.(Number(cue.dataset.t)); return; }
    const span = e.target.closest('.w');
    if (!span) return;
    if (!getSelection().isCollapsed) return; // a phrase selection is being made
    await lookup(span.dataset.n);
    open(span.dataset.n, span.closest('p'), [span]);
    refresh();
  });

  // Phrase selection: drag (mouse) or long-press + handles (touch) across 2–10 words.
  async function onSelect() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !reader.contains(sel.anchorNode)) return;
    const spans = [...reader.querySelectorAll('.w')].filter((s) => sel.containsNode(s, true));
    if (spans.length < 2 || spans.length > 10) return;
    const p = spans[0].closest('p');
    if (spans.some((s) => s.closest('p') !== p)) return toast('Select a phrase within one paragraph.');
    sel.removeAllRanges();
    // The phrase is looked up; its words were seen while selecting, so they don't count as clean passes.
    spans.forEach((s) => clicked.add(s.dataset.n));
    const term = spans.map((s) => s.dataset.n).join(' ');
    await lookup(term);
    open(term, p, spans);
    refresh();
  }
  reader.addEventListener('mouseup', () => setTimeout(onSelect, 0));
  let selTimer;
  const onSelChange = () => { clearTimeout(selTimer); selTimer = setTimeout(onSelect, 700); };
  if (matchMedia('(pointer: coarse)').matches) {
    document.addEventListener('selectionchange', onSelChange);
    cleanups.push(() => { clearTimeout(selTimer); document.removeEventListener('selectionchange', onSelChange); });
  }

  // ---------- paging ----------
  // Returns the status changes caused by turning the page: [{term, from, to}].
  async function finishPage() {
    const spans = [...reader.querySelectorAll('.w')];
    const unique = new Set(spans.map((s) => s.dataset.n));
    let changes = [];
    if (state.settings.autoStatus) {
      const passed = [...unique].filter((t) => !clicked.has(t));
      changes = await applyEvents(passed.map((term) => ({ term, type: 'pass', kind: 'read' })));
    } else if (state.settings.pagingKnown) {
      const toKnow = [...unique].filter((t) => statusOf(t) === NEW && !clicked.has(t));
      await setStatusMany(toKnow, KNOWN);
      changes = toKnow.map((term) => ({ term, from: NEW, to: KNOWN }));
    }
    await markSeen(unique);
    await bumpActivity({ read: spans.length });
    return changes;
  }

  function summarize(changes) {
    const known = changes.filter((c) => c.to === KNOWN).length;
    const up = changes.filter((c) => isLearning(c.to) && c.to > c.from).length;
    return [known && `${plural(known, 'word')} moved to known`, up && `${plural(up, 'LingQ')} leveled up`]
      .filter(Boolean).join(' · ');
  }

  view.querySelector('#next').addEventListener('click', async () => {
    closePanel();
    const changes = await finishPage();
    track(changes);
    const msg = summarize(changes);
    const undoable = state.settings.autoStatus && changes.length;
    const undoAction = { label: 'Undo', onClick: async () => {
      const n = await undoAuto(changes.map((c) => c.term));
      refresh();
      track([]);
      toast(`${plural(n, 'change')} undone`);
    } };
    if (page < pages.length - 1) {
      page++;
      lesson.page = page;
      await db.put('lessons', lesson);
      renderPage();
      window.scrollTo(0, 0);
      if (msg) toast(msg, 3000, undoable ? undoAction : null);
    } else {
      lesson.completed = true;
      lesson.page = 0;
      await db.put('lessons', lesson);
      const learning = Object.keys(lesson.words).filter((t) => isLearning(statusOf(t))).length;
      reader.innerHTML = `
        <div class="empty">
          <p style="font-size:2rem;margin:0">🎉</p>
          <p><b>Lesson complete.</b>${msg ? ` ${esc(msg)}.` : ''}</p>
          <p>${plural(learning, 'LingQ')} from this lesson are waiting in review.</p>
          <div class="row" style="justify-content:center">
            <a class="btn primary" href="#/review">Review LingQs</a>
            <a class="btn" href="#/library">Library</a>
          </div>
        </div>`;
      view.querySelector('.pager').hidden = true;
    }
  });

  view.querySelector('#prev').addEventListener('click', async () => {
    if (page === 0) return;
    closePanel();
    page--;
    lesson.page = page;
    await db.put('lessons', lesson);
    renderPage();
    window.scrollTo(0, 0);
  });

  view.querySelector('#tts').addEventListener('click', () => {
    if (window.speechSynthesis?.speaking) return speechSynthesis.cancel();
    speak(pages[page].map((i) => lesson.segments[i].text).join(' '));
  });

  view.querySelector('#del').addEventListener('click', async () => {
    if (!confirm(`Delete “${lesson.title}”? Words you have studied stay in your vocabulary.`)) return;
    await removeLessonFromPool(lesson);
    await db.del('lessons', lesson.id);
    await db.del('media', lesson.id);
    toast('Lesson deleted');
    location.hash = '#/library';
  });

  renderPage();
  return () => cleanups.forEach((fn) => fn());
}
