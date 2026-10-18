// The reader: highlighted words, phrase selection, paging, and media sync.
//
// Two layouts:
//   page mode   - text lessons (and timed lessons without media): paginated,
//                 turning a page counts as a read pass for untapped words.
//   listen mode - timed lessons with a video/audio player: one continuous
//                 transcript that follows playback (docs/PLAN.md, C4).
import * as db from '../db.js';
import {
  state, statusOf, setStatusMany, applyEvents, undoAuto, markSeen, bumpActivity, removeLessonFromPool, updateLessonLine,
  saveSettings, speak, esc, toast, plural, startStudyTimer, activityByDay, dayKey,
} from '../state.js';
import { lessonLevel } from './library.js';
import { tokenize, formatTime, sentenceAt, contextAt } from '../text.js';
import { translateSentence, ERROR_TEXT } from '../ai.js';
import { NEW, KNOWN, isLearning } from '../srs.js';
import { openPanel, closePanel, panelTerm } from '../panel.js';
import { createPlayer } from '../player.js';
import { buildTimeline, activeIndex, charAt } from '../sync.js';
import { fetchYouTubeAudio, decodeAudio, transcribe, progressText, AUDIO_ERRORS } from '../asr.js';
import { checkTranscript } from '../check.js';
import { fetchLessonMedia } from '../cloud.js';

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
  const lesson = await db.get('lessons', decodeURIComponent(id || ''));
  if (!lesson) {
    view.innerHTML = '<div class="empty">This lesson no longer exists. <a href="#/library">Back to library</a></div>';
    return;
  }
  lesson.openedAt = Date.now();
  await db.put('lessons', lesson);

  // Audio/video files sync separately; fetch this lesson's from the cloud if needed.
  const media = (await db.get('media', lesson.id)) || (lesson.hasMedia ? await fetchLessonMedia(lesson.id) : null);
  const timed = lesson.segments.some((s) => s.start != null);
  const hasMedia = !!(lesson.youtubeId || media?.blob);
  const listen = timed && hasMedia;
  const pages = listen ? [lesson.segments.map((_, i) => i)] : paginate(lesson.segments, state.settings.pageSize, lesson.lang);
  let page = listen ? 0 : Math.min(lesson.page || 0, pages.length - 1);
  let clicked = new Set();
  // The lesson's word levels when you opened it, for the end-of-lesson summary.
  const startStatus = new Map(Object.keys(lesson.words || {}).map((t) => [t, statusOf(t)]));
  const startLevel = lessonLevel(lesson.words);
  const cleanups = [];
  const S = state.settings;

  const footer = listen ? `
    <div class="follow-bar" role="toolbar" aria-label="Playback">
      <button class="btn small" data-ctl="prev" title="Previous line (←)">⏮</button>
      <button class="btn small" data-ctl="replay" title="Replay line (R)">⟲</button>
      <button class="btn small primary" data-ctl="toggle" title="Play / pause (Space)">⏯</button>
      <button class="btn small" data-ctl="next" title="Next line (→)">⏭</button>
      <label class="small follow-toggle"><input type="checkbox" id="follow" ${S.follow ? 'checked' : ''}> Follow</label>
      <button class="btn small" data-ctl="size" title="Player size: normal → large → theater">⤢</button>
      <button class="btn small" data-ctl="more" aria-expanded="false" title="More">⋯</button>
      <button class="btn small" data-ctl="resume" id="resume" hidden></button>
      <div class="follow-more" id="follow-more" hidden>
        <span class="sync small" title="Shift the text if it runs ahead of or behind the audio">Text timing
          <button class="btn small" data-ctl="sync-" aria-label="Text earlier">−</button>
          <span id="sync-val">${(lesson.syncOffset || 0).toFixed(2)}s</span>
          <button class="btn small" data-ctl="sync+" aria-label="Text later">+</button>
        </span>
        <label class="small follow-toggle"><input type="checkbox" id="auto-tr" ${lesson.showTr ? 'checked' : ''}> Translate the current line</label>
        <span class="check-row">
          <button class="btn small" data-ctl="check" title="Listen to the audio with AI and flag transcript words that don't match">🎙 Check transcript against the audio</button>
          <span id="check-status" class="small muted"></span>
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
  const applySize = () => {
    for (const s of ['large', 'theater']) view.classList.toggle(`size-${s}`, listen && S.playerSize === s);
    document.body.classList.toggle('listen-theater', listen && S.playerSize === 'theater');
  };
  applySize();
  cleanups.push(() => {
    view.classList.remove('listen', 'dim', 'size-large', 'size-theater');
    document.body.classList.remove('listen-mode', 'listen-theater');
  });

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
  // Reading and listening time count toward the daily goal; this visit's time goes in the summary.
  let visitSecs = 0;
  cleanups.push(startStudyTimer(() => !!player?.isPlaying?.(), (s) => { visitSecs += s; }));
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
    if (listen && lesson.showTr) {
      reader.querySelectorAll('.tr[data-auto]').forEach((b) => b.remove());
      if (idx >= 0) toggleLineTr(idx, { open: true, auto: true });
    }
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
      reader.querySelectorAll('.w.spoken').forEach((s) => s.classList.remove('spoken'));
      spokenUpTo = -1;
      if (listen) {
        if (!following && Date.now() - lastUserScroll > REFOLLOW_AFTER_MS) setFollow(true, false);
        followTo(idx, jump || Math.abs(pos - prevPos) > 1);
      }
    }
    if (listen && S.wordProgress && activePos >= 0) markSpoken(t);
    lastT = t;
  }

  // Underline the words of the active line that have been spoken so far
  // (interpolated between caption marks, so approximate).
  let spokenUpTo = -1;
  function markSpoken(t) {
    const entry = timeline[activePos];
    const c = charAt(lesson.segments[entry.i], entry, t);
    if (c === spokenUpTo) return;
    spokenUpTo = c;
    const p = reader.querySelector(`p[data-i="${entry.i}"]`);
    p?.querySelectorAll('.w').forEach((s) => s.classList.toggle('spoken', Number(s.dataset.o) < c));
  }

  function tick() {
    if (dead) return;
    step();
    raf = player.isPlaying() && !document.hidden ? requestAnimationFrame(tick) : 0;
  }

  // A line that played through at normal pace counts as a listening pass for the
  // words in it you didn't tap there (once per line per visit).
  const passedSegs = new Set();
  const clickedBySeg = new Map(); // segment index -> Set of terms looked up in it
  async function onSegmentPassed(i) {
    if (!listen || passedSegs.has(i) || document.visibilityState !== 'visible') return;
    passedSegs.add(i);
    const tapped = clickedBySeg.get(i) || new Set();
    const tokens = tokenize(lesson.segments[i].text, lesson.lang).filter((t) => t.n);
    const terms = [...new Set(tokens.map((t) => t.n))].filter((t) => !tapped.has(t));
    if (S.autoStatus) track(await applyEvents(terms.map((term) => ({ term, type: 'pass', kind: 'listen' }))));
    await markSeen(new Set(tokens.map((t) => t.n)));
    await bumpActivity({ read: tokens.length });
    refresh();
  }

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
    $('#auto-tr').addEventListener('change', (e) => {
      lesson.showTr = e.target.checked;
      db.put('lessons', lesson);
      reader.querySelectorAll('.tr[data-auto]').forEach((b) => b.remove());
      if (lesson.showTr && activeIdx >= 0) toggleLineTr(activeIdx, { open: true, auto: true });
    });
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
      else if (name === 'size') {
        const order = ['normal', 'large', 'theater'];
        const next = order[(order.indexOf(S.playerSize) + 1) % order.length];
        saveSettings({ playerSize: next });
        applySize();
        toast(`Player: ${next}`, 1500);
        requestAnimationFrame(() => followTo(activeIdx, true));
      }
      else if (name === 'check') runCheck();
      else if (name === 'clear-flags') { lesson.flags = {}; saveLesson(); rerender(); showFlagCount(); }
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
      let o = 0; // character offset of each word, for word-by-word progress
      const flags = lesson.flags?.[i] || [];
      const words = tokenize(seg.text, lesson.lang).map((t) => {
        const k = flags.findIndex((f) => o >= f.o && o < f.o + f.len);
        const flag = k >= 0 ? ` data-flag="${k}" title="The audio may say: ${esc(flags[k].heard || '(nothing)')}"` : '';
        const html = t.n ? `<span class="w ${statusClass(t.n)}" data-n="${esc(t.n)}" data-o="${o}"${flag}>${esc(t.t)}</span>` : esc(t.t);
        o += t.t.length;
        return html;
      }).join('');
      const tools = `<span class="line-tools">
        <button class="tr-btn" data-explain="${i}" title="Explain this line" aria-label="Explain this line">💬</button>
        <button class="tr-btn" data-tr="${i}" title="Translate this line" aria-label="Translate this line">⇄</button>
        <button class="tr-btn" data-edit="${i}" title="Correct this line" aria-label="Correct this line">✎</button></span>`;
      return `<p class="cue" data-i="${i}" dir="auto">${time}${words}${tools}</p>`;
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

  // Segment i joined with its neighbours when it has no sentence punctuation (auto-captions),
  // each part keeping its caption-line marks. shift = where segment i starts in the result.
  function withNeighbours(i) {
    const seg = lesson.segments[i];
    if (/[.!?…。？！]/.test(seg.text)) return { seg, shift: 0 };
    let text = '', shift = 0;
    const marks = [];
    for (const k of [i - 1, i, i + 1]) {
      const s = lesson.segments[k];
      if (!s || (k !== i && /[.!?…。？！]/.test(s.text))) continue;
      if (text) text += ' ';
      if (k === i) shift = text.length;
      marks.push(...(s.marks || [[0, s.start ?? null]]).map(([o, t]) => [text.length + o, t]));
      text += s.text;
    }
    return { seg: { text, marks }, shift };
  }

  function open(term, p, spans) {
    reader.querySelectorAll('.w.active').forEach((n) => n.classList.remove('active'));
    spans.forEach((s) => s.classList.add('active'));
    // The context of the occurrence you tapped (its sentence, or a few caption lines around it), with the word's position in it.
    const i = Number(p.dataset.i);
    const seg = lesson.segments[i];
    const from = Number(spans[0].dataset.o);
    const last = spans[spans.length - 1];
    const to = Number(last.dataset.o) + last.textContent.length;
    // Auto-captions have short, unpunctuated chunks: look into the neighbouring ones too.
    const wide = withNeighbours(i);
    let { sentence, start } = contextAt(wide.seg, from + wide.shift);
    start -= wide.shift; // back to this segment's offsets (negative when it starts in the previous one)
    // A phrase that runs past the short context: use its whole sentence instead.
    if (to - start > sentence.length) ({ sentence, start } = sentenceAt(seg.text, from));
    const mark = from - start >= 0 && to - start <= sentence.length ? [from - start, to - start] : null;
    const around = { prev: lesson.segments[i - 1]?.text.slice(-200) || '', next: lesson.segments[i + 1]?.text.slice(0, 200) || '' };
    const flag = spans.length === 1 && spans[0].dataset.flag !== undefined ? flagActions(i, Number(spans[0].dataset.flag)) : null;
    openPanel(term, {
      context: sentence, mark, around, flag, transcript: transcriptText(),
      onFlag: flag ? null : () => flagRanges(rangesOf(spans)),
      onChange: refresh, onClose: onPanelClose,
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
  async function lookup(term, p) {
    const seg = Number(p.dataset.i);
    if (!clickedBySeg.has(seg)) clickedBySeg.set(seg, new Set());
    for (const t of [term, ...term.split(' ')]) clickedBySeg.get(seg).add(t);
    const first = !clicked.has(term);
    clicked.add(term);
    if (first && S.autoStatus) track(await applyEvents([{ term, type: 'lookup' }]));
  }

  // ---------- transcript check: flag words the audio doesn't seem to say ----------
  const saveLesson = () => { lesson.updatedAt = Date.now(); return db.put('lessons', lesson); };
  const rerender = () => { const y = scrollY; renderPage(); scrollTo(0, y); };
  const flagCount = () => Object.values(lesson.flags || {}).reduce((a, f) => a + f.length, 0);
  function showFlagCount(msg) {
    const el = $('#check-status');
    if (!el) return;
    const n = flagCount();
    el.innerHTML = msg ? esc(msg) : n
      ? `${plural(n, 'possible mistake')} flagged <button class="btn small" data-ctl="clear-flags">Clear flags</button>`
      : (lesson.flagsAt ? 'No mismatches found.' : '');
  }

  let checking = false;
  async function runCheck() {
    if (checking || !player) return;
    checking = true;
    const show = (p) => showFlagCount(progressText(p));
    try {
      show({ stage: 'audio' });
      const raw = lesson.youtubeId ? await fetchYouTubeAudio(lesson.youtubeId) : await media.blob.arrayBuffer();
      show({ stage: 'decode' });
      const audio = await decodeAudio(raw);
      const cues = await transcribe(audio, { lang: lesson.lang, onProgress: show });
      lesson.flags = checkTranscript(lesson.segments, timeline, cues, lesson.lang);
      lesson.flagsAt = Date.now();
      await saveLesson();
      if (!dead) { rerender(); showFlagCount(); toast(flagCount() ? `${plural(flagCount(), 'possible mistake')} flagged — tap an underlined word` : 'The transcript matches the audio.', 5000); }
    } catch (err) {
      showFlagCount(AUDIO_ERRORS[err.message] || `Check failed: ${err.message}`);
    } finally {
      checking = false;
    }
  }

  // Panel actions for a flagged word.
  function flagActions(i, k) {
    const f = lesson.flags[i][k];
    const drop = () => {
      lesson.flags[i].splice(k, 1);
      if (!lesson.flags[i].length) delete lesson.flags[i];
    };
    return {
      ...f,
      replace: async () => {
        const text = lesson.segments[i].text;
        const delta = f.heard.length - f.len;
        drop();
        const rest = (lesson.flags[i] || []).map((g) => (g.o > f.o ? { ...g, o: g.o + delta } : g));
        await updateLessonLine(lesson, i, text.slice(0, f.o) + f.heard + text.slice(f.o + f.len));
        if (rest.length) lesson.flags[i] = rest;
        await saveLesson();
        closePanel(); rerender(); showFlagCount(); toast('Transcript corrected');
      },
      dismiss: async () => { drop(); await saveLesson(); closePanel(); rerender(); showFlagCount(); },
      edit: () => editLine(i),
    };
  }

  // Correct a transcript line in place; the lesson and word pool are updated.
  function editLine(i) {
    const p = reader.querySelector(`p[data-i="${i}"]`);
    if (!p || p.querySelector('.line-edit')) return;
    closePanel();
    if (listen && player?.isPlaying()) player.pause();
    p.innerHTML = `<span class="line-edit">
      <textarea class="line-edit-text" dir="auto" rows="2">${esc(lesson.segments[i].text)}</textarea>
      <span class="row"><button class="btn small primary" data-save>Save</button><button class="btn small" data-cancel>Cancel</button></span></span>`;
    const ta = p.querySelector('textarea');
    ta.focus();
    p.querySelector('[data-cancel]').addEventListener('click', rerender);
    p.querySelector('[data-save]').addEventListener('click', async () => {
      const text = ta.value.replace(/\s+/g, ' ').trim();
      if (text && text !== lesson.segments[i].text) {
        await updateLessonLine(lesson, i, text);
        toast('Line corrected');
      }
      rerender();
    });
  }

  // Line translations: hidden by default (reading the original is the point), one tap away.
  async function toggleLineTr(i, { open = false, auto = false } = {}) {
    const p = reader.querySelector(`p[data-i="${i}"]`);
    if (!p) return;
    let box = p.querySelector('.tr');
    if (box) { if (!open) box.remove(); return; }
    box = Object.assign(document.createElement('span'), { className: 'tr', dir: 'auto', textContent: 'Translating…' });
    if (auto) box.dataset.auto = '1';
    p.append(box);
    const r = await translateSentence(lesson.segments[i].text, lesson.lang, S.native);
    box.textContent = r?.text || ERROR_TEXT[r?.error] || ERROR_TEXT.unavailable;
  }

  reader.addEventListener('click', async (e) => {
    const cue = e.target.closest('.cue-time');
    if (cue) { seekTo?.(Number(cue.dataset.t)); return; }
    const explainBtn = e.target.closest('[data-explain]');
    if (explainBtn) {
      const i = Number(explainBtn.dataset.explain);
      pauseForLookup();
      openSelection([{ i, o: 0, len: lesson.segments[i].text.length, said: lesson.segments[i].text }]);
      return;
    }
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) { editLine(Number(editBtn.dataset.edit)); return; }
    if (e.target.closest('.line-edit')) return;
    const trBtn = e.target.closest('[data-tr]');
    if (trBtn) { toggleLineTr(Number(trBtn.dataset.tr)); return; }
    const span = e.target.closest('.w');
    if (!span) return;
    if (!getSelection().isCollapsed) return; // a phrase selection is being made
    pauseForLookup();
    // Tapping a flagged word is checking the transcript, not admitting you don't know it.
    if (span.dataset.flag === undefined) await lookup(span.dataset.n, span.closest('p'));
    else clicked.add(span.dataset.n);
    open(span.dataset.n, span.closest('p'), [span]);
    refresh();
  });

  // The transcript ranges covered by a set of word spans: [{i, o, len, said}], one per line.
  function rangesOf(spans) {
    return [...new Set(spans.map((s) => s.closest('p')))].map((p) => {
      const ss = spans.filter((s) => s.closest('p') === p);
      const o = Number(ss[0].dataset.o);
      const last = ss.at(-1);
      const len = Number(last.dataset.o) + last.textContent.length - o;
      const i = Number(p.dataset.i);
      return { i, o, len, said: lesson.segments[i].text.slice(o, o + len) };
    });
  }

  // Flag text you think is wrong in the transcript (shown with the same wavy underline).
  async function flagRanges(ranges) {
    lesson.flags ||= {};
    for (const r of ranges) {
      const list = (lesson.flags[r.i] || []).filter((f) => f.o + f.len <= r.o || f.o >= r.o + r.len);
      list.push({ o: r.o, len: r.len, said: r.said, heard: '', manual: true });
      lesson.flags[r.i] = list.sort((a, b) => a.o - b.o);
    }
    await saveLesson();
    closePanel(); rerender(); showFlagCount();
    toast('Flagged as wrong. Fix it with ✎, or tap the underlined text later.', 4000);
  }

  // Selecting text: 2–10 words in one line = a phrase; anything longer (sentences,
  // several lines) opens the selected-text panel. Nothing is saved until you choose.
  async function onSelect() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !reader.contains(sel.anchorNode)) return;
    const spans = [...reader.querySelectorAll('.w')].filter((s) => sel.containsNode(s, true));
    if (spans.length < 2) return;
    sel.removeAllRanges();
    pauseForLookup();
    // Words seen while selecting don't count as clean passes.
    spans.forEach((s) => clicked.add(s.dataset.n));
    const ranges = rangesOf(spans);
    if (ranges.length === 1 && spans.length <= 10) {
      open(spans.map((s) => s.dataset.n).join(' '), spans[0].closest('p'), spans);
    } else {
      openSelection(ranges);
    }
    refresh();
  }

  function openSelection(ranges) {
    const first = ranges[0].i, last = ranges.at(-1).i;
    openPanel(ranges.map((r) => r.said).join(' '), {
      mode: 'selection',
      context: ranges.map((r) => r.said).join(' '),
      around: { prev: lesson.segments[first - 1]?.text.slice(-200) || '', next: lesson.segments[last + 1]?.text.slice(0, 200) || '' },
      transcript: transcriptText(),
      onFlag: () => flagRanges(ranges),
      onClose: onPanelClose,
    });
  }

  const transcriptText = () => lesson.segments.map((s) => s.text).join('\n');
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

  // The end-of-lesson summary: what this visit did, how much more of the lesson you now
  // know, and today's goal. Words are compared with their level when the lesson opened.
  async function showComplete() {
    let lingqs = 0, known = 0, learning = 0;
    for (const [t, before] of startStatus) {
      const now = statusOf(t);
      if (isLearning(now)) learning++;
      if (isLearning(now) && !isLearning(before)) lingqs++;
      if (now === KNOWN && before !== KNOWN) known++;
    }
    const level = lessonLevel(lesson.words);
    const mins = Math.max(1, Math.round(visitSecs / 60));
    const goal = S.dailyMinutes;
    const todayMins = Math.floor(((await activityByDay()).get(dayKey())?.secs || 0) / 60);
    const goalPct = Math.min(100, Math.round((todayMins / goal) * 100));
    reader.innerHTML = `
      <div class="card lesson-done">
        <p class="done-title">🎉 Lesson complete</p>
        <div class="tiles">
          <div class="tile"><div class="v">${mins}</div><div class="l">${mins === 1 ? 'minute' : 'minutes'}</div></div>
          <div class="tile"><div class="v">${lingqs}</div><div class="l">${lingqs === 1 ? 'new LingQ' : 'new LingQs'}</div></div>
          <div class="tile"><div class="v">${known}</div><div class="l">${known === 1 ? 'word now known' : 'words now known'}</div></div>
        </div>
        <p>You now know <b>${level.pct}%</b> of this lesson${level.pct > startLevel.pct ? ` (up from ${startLevel.pct}%)` : ''}.
          <span class="level ${level.cls}">${level.label}</span></p>
        <div class="row spread small"><span>Today’s goal${goalPct >= 100 ? ' ✓' : ''}</span><span class="muted">${todayMins} / ${goal} minutes</span></div>
        <div class="goal" role="img" aria-label="${goalPct}% of daily goal"><div style="width:${goalPct}%"></div></div>
        <div class="row" style="justify-content:center;margin-top:12px">
          ${learning ? `<a class="btn primary" href="#/review">Review ${plural(learning, 'LingQ')}</a>` : ''}
          <button class="btn ${learning ? '' : 'primary'}" id="again" title="Meeting the same words again helps them stick">${listen ? 'Listen again' : 'Read again'}</button>
          <a class="btn" href="#/library">Library</a>
        </div>
      </div>`;
    view.querySelector('.pager, .follow-bar').hidden = true;
    $('#again').addEventListener('click', () => window.dispatchEvent(new HashChangeEvent('hashchange'))); // reopen it from the start
  }

  $('#next').addEventListener('click', async () => {
    closePanel();
    if (listen) {
      // Listening already counted line by line; finishing never bulk-promotes.
      player?.pause();
      lesson.completed = true;
      await db.put('lessons', lesson);
      showComplete();
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
      showComplete();
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
  if (listen) { $('#follow-btn').hidden = true; showFlagCount(); }
  return () => cleanups.forEach((fn) => fn());
}
