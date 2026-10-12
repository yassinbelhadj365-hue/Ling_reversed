// The reader: highlighted words, phrase selection, paging, and media sync.
//
// Two layouts:
//   page mode   - text lessons (and timed lessons without media): paginated,
//                 turning a page counts as a read pass for untapped words.
//   listen mode - timed lessons with a video/audio player: one continuous
//                 transcript that follows playback (docs/PLAN.md, C4).
import * as db from '../db.js';
import {
  state, statusOf, setStatusMany, applyEvents, undoAuto, markSeen, bumpActivity, removeLessonFromPool,
  saveSettings, speak, esc, toast, plural,
} from '../state.js';
import { tokenize, formatTime, sentenceAround } from '../text.js';
import { NEW, KNOWN, isLearning } from '../srs.js';
import { openPanel, closePanel, panelTerm } from '../panel.js';
import { createPlayer } from '../player.js';
import { buildTimeline, activeIndex } from '../sync.js';

const SYNC_STEP = 0.25;          // seconds per sync-offset click
const JUMP_BACK = -0.3;          // clock moving back more than this = a seek
const JUMP_FWD = 1.5;            // ... or forward more than this
const REFOLLOW_AFTER_MS = 6000;  // resume following after this long without user scrolling
const SAVE_POS_MS = 10000;

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

  const media = await db.get('media', lesson.id);
  const timed = lesson.segments.some((s) => s.start != null);
  const hasMedia = !!(lesson.youtubeId || media?.blob);
  const listen = timed && hasMedia;
  const pages = listen ? [lesson.segments.map((_, i) => i)] : paginate(lesson.segments, state.settings.pageSize, lesson.lang);
  let page = listen ? 0 : Math.min(lesson.page || 0, pages.length - 1);
  let clicked = new Set();
  const cleanups = [];
  const S = state.settings;

  const footer = listen ? `
    <div class="follow-bar" role="toolbar" aria-label="Playback">
      <button class="btn small" data-ctl="prev" title="Previous line (←)">⏮</button>
      <button class="btn small" data-ctl="replay" title="Replay line (R)">⟲</button>
      <button class="btn small primary" data-ctl="toggle" title="Play / pause (Space)">⏯</button>
      <button class="btn small" data-ctl="next" title="Next line (→)">⏭</button>
      <label class="small follow-toggle"><input type="checkbox" id="follow" ${S.follow ? 'checked' : ''}> Follow</label>
      <button class="btn small" data-ctl="more" aria-expanded="false" title="More">⋯</button>
      <button class="btn small" data-ctl="resume" id="resume" hidden></button>
      <div class="follow-more" id="follow-more" hidden>
        <span class="sync small" title="Shift the text if it runs ahead of or behind the audio">Text timing
          <button class="btn small" data-ctl="sync-" aria-label="Text earlier">−</button>
          <span id="sync-val">${(lesson.syncOffset || 0).toFixed(2)}s</span>
          <button class="btn small" data-ctl="sync+" aria-label="Text later">+</button>
        </span>
        <button class="btn small" id="next">Finish lesson ✓</button>
      </div>
    </div>
    <button class="btn primary follow-btn" id="follow-btn" hidden>⤓ Follow video</button>` : `
    <div class="pager">
      <button class="btn" id="prev">← Back</button>
      <span class="muted small" id="pageinfo"></span>
      <button class="btn primary" id="next"></button>
    </div>`;

  view.classList.toggle('listen', listen);
  view.classList.toggle('dim', listen && S.dimOtherLines);
  document.body.classList.toggle('listen-mode', listen);
  cleanups.push(() => { view.classList.remove('listen', 'dim'); document.body.classList.remove('listen-mode'); });

  view.innerHTML = `
    <div class="reader-head">
      <h1 dir="auto">${esc(lesson.title)}</h1>
      <div class="row">
        <a class="badge session-chip" id="session-chip" href="#/vocab/auto" title="Automatic changes this session — tap to review or revert" hidden></a>
        ${listen ? '' : '<button class="btn small" id="tts" title="Read this page aloud">🔊 Listen</button>'}
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
    ${footer}
    <p class="muted small">${S.autoStatus
      ? 'Tap words you don’t know. Words you read past without tapping become known; words you tapped level up as you meet them again.'
      : `Tap a word to look it up. ${S.pagingKnown ? 'Turning the page marks the blue words you didn’t tap as <b>known</b>.' : ''}`}
      Select several words to save a phrase.${listen ? ' Keys: Space play/pause, ← → previous/next line, R replay.' : ''}</p>`;

  const reader = view.querySelector('#reader');
  const $ = (sel) => view.querySelector(sel);

  // ---------- media ----------
  const mediaBox = $('#media');
  const player = createPlayer(mediaBox, { youtubeId: lesson.youtubeId, blob: media?.blob, type: media?.type });
  const timeline = buildTimeline(lesson.segments);
  const offset = () => lesson.syncOffset || 0;
  let dead = false;
  let activeIdx = -1;      // lesson segment index of the active line
  let activePos = -1;      // its position in the timeline
  let lastT = null;
  let segPlayed = 0;       // seconds of normal playback within the active line
  let raf = 0;

  // Seek to a line (timeline position) and follow it.
  function playLine(pos) {
    if (!player || !timeline.length) return;
    pos = Math.max(0, Math.min(timeline.length - 1, pos));
    setFollow(true);
    player.seek(timeline[pos].start - offset());
    player.play();
  }
  const seekTo = player ? (t) => { setFollow(true); player.seek(t - offset()); player.play(); } : null;

  function setActive(idx) {
    reader.querySelector('p.playing')?.classList.remove('playing');
    reader.querySelector(`p[data-i="${idx}"]`)?.classList.add('playing');
  }

  function step() {
    const t = player.getTime() + offset();
    const playing = player.isPlaying();
    const jump = lastT !== null && (t - lastT < JUMP_BACK || t - lastT > JUMP_FWD);
    if (!jump && playing && lastT !== null) segPlayed += Math.max(0, t - lastT);
    const { pos, idx } = activeIndex(timeline, t);
    if (idx !== activeIdx) {
      const prevPos = activePos;
      if (!jump && prevPos >= 0 && pos === prevPos + 1) {
        const seg = timeline[prevPos];
        if (segPlayed >= 0.6 * (seg.end - seg.start)) onSegmentPassed(seg.i);
      }
      activeIdx = idx;
      activePos = pos;
      segPlayed = 0;
      setActive(idx);
      if (listen) {
        if (!following && Date.now() - lastUserScroll > REFOLLOW_AFTER_MS) setFollow(true, false);
        followTo(idx, jump || Math.abs(pos - prevPos) > 1);
      }
    }
    lastT = t;
  }

  function tick() {
    if (dead) return;
    step();
    raf = player.isPlaying() && !document.hidden ? requestAnimationFrame(tick) : 0;
  }

  // Filled in by C5: a line that played through counts as a listening pass.
  function onSegmentPassed() {}

  if (player) {
    player.on('state', (playing) => {
      if (playing && !raf) raf = requestAnimationFrame(tick);
      else if (!playing) step();
      if (listen && !playing) savePosition();
    });
    player.on('ended', () => {
      if (listen) toast('End of the video.', 6000, { label: 'Finish lesson', onClick: () => $('#next').click() });
    });
    cleanups.push(() => { dead = true; cancelAnimationFrame(raf); savePosition(); player.destroy(); });
  }

  // ---------- follow (listen mode) ----------
  let following = listen && S.follow;
  let lastUserScroll = 0;

  function setFollow(on, scroll = true) {
    if (!listen) return;
    following = on && $('#follow').checked;
    $('#follow-btn').hidden = following || !$('#follow').checked;
    if (following && scroll && activeIdx >= 0) followTo(activeIdx, true);
  }

  function followTo(idx, instant) {
    if (!following) return;
    const p = reader.querySelector(`p[data-i="${idx}"]`);
    if (!p) return;
    const box = mediaBox.getBoundingClientRect();
    const sideBySide = box.right <= reader.getBoundingClientRect().left + 1;
    const topbar = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const anchor = sideBySide ? topbar : Math.max(topbar, box.bottom);
    const panel = document.getElementById('word-panel');
    const panelH = !panel.hidden && innerWidth <= 720 ? panel.getBoundingClientRect().height : 0;
    const bottom = Math.min(innerHeight - panelH, $('.follow-bar').getBoundingClientRect().top);
    const target = anchor + 0.3 * Math.max(0, bottom - anchor);
    const delta = p.getBoundingClientRect().top - target;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (Math.abs(delta) > 8) window.scrollBy({ top: delta, behavior: instant || reduce ? 'auto' : 'smooth' });
  }

  if (listen) {
    // Only real user input pauses following; our own scrollBy never does.
    const hold = (e) => {
      if (e.target.closest?.('#word-panel, .follow-bar, .media-box')) return;
      lastUserScroll = Date.now();
      if (following) setFollow(false);
    };
    const holdKeys = (e) => { if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) hold(e); };
    window.addEventListener('wheel', hold, { passive: true });
    window.addEventListener('touchmove', hold, { passive: true });
    window.addEventListener('keydown', holdKeys);
    cleanups.push(() => {
      window.removeEventListener('wheel', hold);
      window.removeEventListener('touchmove', hold);
      window.removeEventListener('keydown', holdKeys);
    });

    $('#follow-btn').addEventListener('click', () => setFollow(true));
    $('#follow').addEventListener('change', (e) => {
      saveSettings({ follow: e.target.checked });
      setFollow(e.target.checked);
    });

    // Line controls and keyboard.
    const control = (name) => {
      if (!player && name !== 'more') return;
      const cur = Math.max(0, activePos);
      if (name === 'prev') playLine(activePos <= 0 ? 0 : cur - 1);
      else if (name === 'next') playLine(activePos < 0 ? 0 : cur + 1);
      else if (name === 'replay') playLine(cur);
      else if (name === 'toggle') player.isPlaying() ? player.pause() : player.play();
      else if (name === 'resume') { $('#resume').hidden = true; seekTo(lesson.lastTime); }
      else if (name === 'more') {
        const more = $('#follow-more');
        more.hidden = !more.hidden;
        view.querySelector('[data-ctl="more"]').setAttribute('aria-expanded', String(!more.hidden));
      }
      else if (name === 'sync-' || name === 'sync+') {
        lesson.syncOffset = Math.round((offset() + (name === 'sync+' ? SYNC_STEP : -SYNC_STEP)) * 100) / 100;
        $('#sync-val').textContent = `${lesson.syncOffset.toFixed(2)}s`;
        db.put('lessons', lesson);
        lastT = null;
        step();
      }
    };
    view.querySelector('.follow-bar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ctl]');
      if (b) control(b.dataset.ctl);
    });
    const onKey = (e) => {
      if (panelTerm() || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(document.activeElement?.tagName)) return;
      const map = { ' ': 'toggle', ArrowLeft: 'prev', ArrowRight: 'next', r: 'replay', R: 'replay' };
      if (!map[e.key]) return;
      e.preventDefault();
      control(map[e.key]);
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));

    // Remember where you were; offer to jump back (no autoplay).
    if (lesson.lastTime > 5) {
      $('#resume').hidden = false;
      $('#resume').textContent = `↻ ${formatTime(lesson.lastTime)}`;
      $('#resume').title = `Resume where you left off (${formatTime(lesson.lastTime)})`;
    }
    const posTimer = setInterval(() => { if (player?.isPlaying()) savePosition(); }, SAVE_POS_MS);
    cleanups.push(() => clearInterval(posTimer));
  }

  function savePosition() {
    if (!player || !listen) return;
    const t = player.getTime();
    if (t > 0 && Math.abs(t - (lesson.lastTime || 0)) > 1) {
      lesson.lastTime = t;
      db.put('lessons', lesson);
    }
  }

  // ---------- rendering ----------
  function renderPage() {
    clicked = new Set();
    activeIdx = -1;
    activePos = -1;
    reader.innerHTML = pages[page].map((i) => {
      const seg = lesson.segments[i];
      const time = timed && player && seg.start != null
        ? `<button class="cue-time" data-t="${seg.start}" title="Play from here">▶ ${formatTime(seg.start)}</button>`
        : '';
      const words = tokenize(seg.text, lesson.lang)
        .map((t) => (t.n ? `<span class="w ${statusClass(t.n)}" data-n="${esc(t.n)}">${esc(t.t)}</span>` : esc(t.t)))
        .join('');
      return `<p class="cue" data-i="${i}" dir="auto">${time}${words}</p>`;
    }).join('') || '<p class="muted">This lesson is empty.</p>';
    markPhrases();
    if (!listen) {
      $('#pageinfo').textContent = `Page ${page + 1} of ${pages.length}`;
      $('#prev').disabled = page === 0;
      $('#next').textContent = page === pages.length - 1 ? 'Complete lesson ✓' : 'Next page →';
    }
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

  // Re-colour after a status change.
  function refresh() {
    const active = panelTerm();
    for (const s of reader.querySelectorAll('.w')) {
      s.className = `w ${statusClass(s.dataset.n)}${s.dataset.n === active ? ' active' : ''}`;
    }
    markPhrases();
    track([]);
  }

  // While a word is open, playback pauses; closing the panel resumes it.
  let pausedForLookup = false;
  function pauseForLookup() {
    if (listen && player?.isPlaying() && S.pauseOnLookup) {
      player.pause();
      pausedForLookup = true;
    }
  }
  function onPanelClose() {
    if (pausedForLookup && !dead && S.resumeAfterLookup) player.play();
    pausedForLookup = false;
  }

  function open(term, p, spans) {
    reader.querySelectorAll('.w.active').forEach((n) => n.classList.remove('active'));
    spans.forEach((s) => s.classList.add('active'));
    const text = lesson.segments[Number(p.dataset.i)].text;
    const surface = spans.map((s) => s.textContent).join(' ');
    openPanel(term, {
      context: sentenceAround(text, spans.length > 1 ? spans[0].textContent : surface),
      onChange: refresh,
      onClose: onPanelClose,
    });
    if (listen) requestAnimationFrame(() => followTo(activeIdx, true));
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
    const chip = $('#session-chip');
    chip.textContent = [known && `+${known} known`, added && `+${added} LingQs`, up && `${up} ↑`].filter(Boolean).join(' · ');
    chip.hidden = !chip.textContent;
  }

  // A tap is a lookup: with automatic levels on, it makes the word a LingQ
  // (or drops a LingQ one level). Only the first tap per page counts.
  async function lookup(term) {
    const first = !clicked.has(term);
    clicked.add(term);
    if (first && S.autoStatus) track(await applyEvents([{ term, type: 'lookup' }]));
  }

  reader.addEventListener('click', async (e) => {
    const cue = e.target.closest('.cue-time');
    if (cue) { seekTo?.(Number(cue.dataset.t)); return; }
    const span = e.target.closest('.w');
    if (!span) return;
    if (!getSelection().isCollapsed) return; // a phrase selection is being made
    pauseForLookup();
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
    pauseForLookup();
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

  // ---------- paging / finishing ----------
  // Returns the status changes caused by turning the page: [{term, from, to}].
  async function finishPage() {
    const spans = [...reader.querySelectorAll('.w')];
    const unique = new Set(spans.map((s) => s.dataset.n));
    let changes = [];
    if (S.autoStatus) {
      const passed = [...unique].filter((t) => !clicked.has(t));
      changes = await applyEvents(passed.map((term) => ({ term, type: 'pass', kind: 'read' })));
    } else if (S.pagingKnown) {
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

  function showComplete(msg) {
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
    view.querySelector('.pager, .follow-bar').hidden = true;
  }

  $('#next').addEventListener('click', async () => {
    closePanel();
    if (listen) {
      // Listening already counted line by line; finishing never bulk-promotes.
      player?.pause();
      lesson.completed = true;
      await db.put('lessons', lesson);
      showComplete(summarize([...session.entries()].map(([term, c]) => ({ term, ...c }))));
      return;
    }
    const changes = await finishPage();
    track(changes);
    const msg = summarize(changes);
    const undoable = S.autoStatus && changes.length;
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
      showComplete(msg);
    }
  });

  $('#prev')?.addEventListener('click', async () => {
    if (page === 0) return;
    closePanel();
    page--;
    lesson.page = page;
    await db.put('lessons', lesson);
    renderPage();
    window.scrollTo(0, 0);
  });

  $('#tts')?.addEventListener('click', () => {
    if (window.speechSynthesis?.speaking) return speechSynthesis.cancel();
    speak(pages[page].map((i) => lesson.segments[i].text).join(' '));
  });

  $('#del').addEventListener('click', async () => {
    if (!confirm(`Delete “${lesson.title}”? Words you have studied stay in your vocabulary.`)) return;
    await removeLessonFromPool(lesson);
    await db.del('lessons', lesson.id);
    await db.del('media', lesson.id);
    toast('Lesson deleted');
    location.hash = '#/library';
  });

  renderPage();
  if (listen) $('#follow-btn').hidden = true;
  return () => cleanups.forEach((fn) => fn());
}
