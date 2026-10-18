// Tokenizing and transcript/subtitle parsing.

// Languages where a short elided article/pronoun is glued on with an apostrophe
// (l'homme, dell'anno) and should count as its own word.
const ELISION_LANGS = new Set(['fr', 'it', 'ca']);

const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’\-‐][\p{L}\p{M}\p{N}]+)*/gu;
const ELISION_RE = /aujourd['’]hui|[\p{L}\p{M}]{1,4}['’](?=\p{L})|[\p{L}\p{M}\p{N}]+(?:[\-‐][\p{L}\p{M}\p{N}]+)*/giu;
const NUMBER_RE = /^[\p{N}]+$/u;

export function normalize(s) {
  return s.normalize('NFC').replace(/[’‘]/g, "'").replace(/‐/g, '-').toLocaleLowerCase();
}

// Splits text into tokens: {t: original text, n?: normalized word key}.
// Tokens without `n` are spaces, punctuation or numbers.
export function tokenize(text, lang) {
  const re = ELISION_LANGS.has(lang) ? ELISION_RE : WORD_RE;
  re.lastIndex = 0;
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    const w = m[0];
    out.push(NUMBER_RE.test(w) ? { t: w } : { t: w, n: normalize(w) });
    last = m.index + w.length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

export function countWords(segments, lang) {
  const counts = {};
  let total = 0;
  for (const seg of segments) {
    for (const tok of tokenize(seg.text, lang)) {
      if (!tok.n) continue;
      counts[tok.n] = (counts[tok.n] || 0) + 1;
      total++;
    }
  }
  return { counts, total };
}

// ---------- timestamps ----------

// "01:02:03,500", "1:02.5", "02:03" -> seconds
export function parseTime(s) {
  const parts = s.trim().replace(',', '.').split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

const TS_LINE = /^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d+)?)\]?\s*$/;
const TS_INLINE = /^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d+)?)\]?\s+(.+)$/;
// YouTube's transcript panel sometimes copies an accessibility label like "2 minutes, 5 seconds".
const DURATION_LABEL = /^\s*\d+\s+(?:seconds?|minutes?|hours?)(?:,\s*\d+\s+(?:seconds?|minutes?|hours?))*\s*$/i;

function cleanCaption(s) {
  return s
    .replace(/<[^>]+>/g, '')        // <c>, <i>, inline <00:00:01.000> timestamps
    .replace(/\{\\[^}]*\}/g, '')    // {\an8} SSA tags
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// One caption line with YouTube's inline word timestamps
// ("We're<00:00:19.039><c> no</c>...") -> {text, marks: [[charOffset, time], ...]}.
// `text` is identical to cleanCaption(raw).
function captionWithTimes(raw) {
  let text = '';
  const marks = [];
  const re = /<(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})>|<[^>]*>/g;
  let last = 0;
  const add = (piece) => {
    piece = cleanCaption(`\u0001${piece}\u0001`).slice(1, -1).replace(/\s+/g, ' '); // entities, SSA tags
    if (text.endsWith(' ') && piece.startsWith(' ')) piece = piece.slice(1);
    text += piece;
  };
  for (const m of raw.matchAll(re)) {
    add(raw.slice(last, m.index));
    if (m[1]) marks.push([text.length, parseTime(m[1])]);
    last = m.index + m[0].length;
  }
  add(raw.slice(last));
  const lead = text.length - text.trimStart().length;
  text = text.trim();
  return { text, marks: marks.map(([o, t]) => [Math.min(text.length, Math.max(0, o - lead + (text[o - lead] === ' ' ? 1 : 0))), t]) };
}

// SRT and WebVTT (including YouTube's auto-generated "rolling" captions, whose
// cues repeat the previous line — those repeats are dropped). Inline word
// timestamps become `marks` so the reader can follow speech word by word.
// Splits subtitles into cues: [[timingLine, ...textLines], ...]. Cues are delimited by
// their timing lines, not by blank lines: YouTube's auto-captions put whitespace-only
// lines inside cues. A cue id (SRT number or VTT id) is the line right before a timing
// line that follows a blank line, and is dropped.
function subtitleBlocks(raw) {
  const lines = raw.replace(/\r/g, '').split('\n');
  const blocks = [];
  for (let k = 0; k < lines.length; k++) {
    if (!lines[k].includes('-->')) {
      blocks.at(-1)?.push(lines[k]);
      continue;
    }
    const prev = blocks.at(-1);
    if (prev && prev.length > 1 && lines[k - 1]?.trim() && !lines[k - 2]?.trim()) prev.pop();
    blocks.push([lines[k]]);
  }
  return blocks;
}

export function parseSubtitles(raw) {
  const cues = [];
  let prevLines = new Set();
  for (const lines of subtitleBlocks(raw)) {
    const i = 0;
    const [left, right = ''] = lines[i].split('-->');
    const start = parseTime(left);
    const end = parseTime(right.trim().split(/\s+/)[0] || '');
    const textLines = lines.slice(i + 1).map((l) => ({ raw: l, clean: cleanCaption(l) })).filter((l) => l.clean);
    const fresh = textLines.filter((l) => !prevLines.has(l.clean));
    prevLines = new Set(textLines.map((l) => l.clean));
    let text = '';
    const marks = [[0, start]];
    for (const l of fresh) {
      const c = captionWithTimes(l.raw);
      const off = text ? text.length + 1 : 0;
      text = text ? `${text} ${c.text}` : c.text;
      for (const [o, t] of c.marks) if (t > marks.at(-1)[1]) marks.push([off + o, t]);
    }
    if (!text) continue;
    const cue = end != null && end > start ? { start, end, text } : { start, text };
    if (marks.length > 1) cue.marks = marks;
    cues.push(cue);
  }
  return cues;
}

// Text copied from YouTube's "Show transcript" panel (or any "0:12 text" style transcript).
export function parseTimestampedText(raw) {
  const cues = [];
  let pending = null;
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    if (!line.trim() || DURATION_LABEL.test(line)) continue;
    let m = line.match(TS_LINE);
    if (m) { pending = parseTime(m[1]); continue; }
    m = line.match(TS_INLINE);
    if (m) { cues.push({ start: parseTime(m[1]), text: cleanCaption(m[2]) }); pending = null; continue; }
    const text = cleanCaption(line);
    if (!text) continue;
    if (pending !== null) { cues.push({ start: pending, text }); pending = null; }
    else if (cues.length) cues[cues.length - 1].text += ' ' + text;
    else cues.push({ start: 0, text });
  }
  return cues;
}

export function parsePlainText(raw) {
  const text = raw.replace(/\r/g, '').trim();
  const byBlank = text.split(/\n\s*\n/);
  const paras = byBlank.length > 1 ? byBlank : text.split('\n');
  return paras.map((p) => ({ text: p.replace(/\s*\n\s*/g, ' ').trim() })).filter((p) => p.text);
}

// Short caption cues read badly one per line; merge them into sentence-sized
// chunks. Each merged line keeps `marks` ([[charOffset, start], ...]) so the
// reader can still tell which part of the line is being spoken.
// Auto-captions without any punctuation give no sentence ends to merge up to, so their
// lines stay short (unpunctuatedMax) instead of becoming paragraph-sized.
export function mergeCues(cues, maxChars = 220, unpunctuatedMax = 90) {
  const out = [];
  for (const cue of cues) {
    const last = out[out.length - 1];
    const lastEnded = last && /[.!?…。？！»"”)]\s*$/.test(last.text);
    const own = cue.marks || [[0, cue.start]];
    const max = last && !/[.!?…。？！,;:]/.test(last.text + cue.text) ? unpunctuatedMax : maxChars;
    if (last && !lastEnded && last.text.length + cue.text.length < max) {
      const off = last.text.length + 1;
      last.marks.push(...own.map(([o, t]) => [off + o, t]));
      last.text += ' ' + cue.text;
      if (cue.end != null) last.end = cue.end; else delete last.end;
    } else {
      out.push({ ...cue, marks: own.map((m) => [...m]) });
    }
  }
  for (const seg of out) if (seg.marks.length < 2 || seg.marks.some(([, t]) => t == null)) delete seg.marks;
  return out;
}

// Detects the format and returns {segments, timed}.
export function parseAny(raw, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'srt' || ext === 'vtt' || /-->/.test(raw)) {
    const cues = parseSubtitles(raw);
    if (cues.length) return { segments: cues, timed: true };
  }
  const tsLines = raw.split('\n').filter((l) => TS_LINE.test(l) || TS_INLINE.test(l)).length;
  if (tsLines >= 3) {
    const cues = parseTimestampedText(raw);
    if (cues.length) return { segments: cues, timed: true };
  }
  return { segments: parsePlainText(raw), timed: false };
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, nav, header, footer, noscript').forEach((n) => n.remove());
  const blocks = [...doc.querySelectorAll('h1, h2, h3, h4, p, li, blockquote')]
    .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return blocks.length ? blocks.join('\n\n') : (doc.body?.textContent || '').trim();
}

export function youTubeId(url) {
  if (!url) return null;
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

// The sentence containing the character at `offset` (the word you actually tapped).
// Text without sentence punctuation (e.g. auto-captions) returns the whole text.
// -> {sentence, start}: start = index of the sentence's first character in `text`.
export function sentenceAt(text, offset) {
  const re = /[^.!?…。？！]+[.!?…。？！]*["'»”)\]]*\s*/g;
  let m;
  while ((m = re.exec(text))) {
    if (offset < m.index + m[0].length || re.lastIndex >= text.length) {
      const lead = m[0].length - m[0].trimStart().length;
      return { sentence: m[0].trim(), start: m.index + lead };
    }
  }
  const lead = text.length - text.trimStart().length;
  return { sentence: text.trim(), start: lead };
}

// The piece of text a lookup is about, for the panel and the AI: enough to understand
// the word (about minWords–maxWords words), but not a whole paragraph.
// - Text with punctuation: the sentence (sentenceAt), when it isn't too long.
// - Auto-captions (no punctuation): whole caption lines around the word, found through
//   `marks` (one per caption cue), added one at a time until there are about minWords.
// - Otherwise: about `window` words on each side of the word.
// Never crosses caption tags like [Musique] or ♪.
// seg: {text, marks?}; offset: the tapped word's character offset in seg.text.
// -> {sentence, start}: start = index of the context's first character in seg.text.
const TAG = /\[[^\]\n]{0,40}\]|\([A-ZÀ-Ý][^)\n]{0,30}\)|[♪♫]+/g;
const SENTENCE_END = /[.!?…。？！]/;
export function contextAt(seg, offset, { minWords = 20, maxWords = 40, window = 15 } = {}) {
  const text = seg.text;
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  let a, b;
  const s = sentenceAt(text, offset);
  if (SENTENCE_END.test(text) && words(s.sentence) <= maxWords) {
    a = s.start; b = s.start + s.sentence.length;
  } else if (seg.marks?.length > 1) {
    const starts = [...new Set(seg.marks.map(([o]) => o))].sort((x, y) => x - y);
    let lo = Math.max(0, starts.findLastIndex((o) => o <= offset)), hi = lo + 1;
    const span = (l, h) => text.slice(starts[l], starts[h] ?? text.length);
    // Add the next line, then the previous one, and so on, while it stays short enough.
    for (let grew = true; grew && words(span(lo, hi)) < minWords;) {
      grew = false;
      for (const [l, h] of [[lo, hi + 1], [lo - 1, hi]]) {
        if (words(span(lo, hi)) >= minWords || l < 0 || h > starts.length || words(span(l, h)) > maxWords) continue;
        [lo, hi] = [l, h];
        grew = true;
      }
    }
    a = starts[lo];
    b = starts[hi] ?? text.length;
  } else if (words(s.sentence) <= maxWords) {
    a = s.start; b = s.start + s.sentence.length;
  } else {
    const before = text.slice(0, offset).split(/(\s+)/);
    let n = 0, i = before.length;
    while (i > 0 && n < window) { i--; if (before[i].trim()) n++; }
    a = before.slice(0, i).join('').length;
    const after = new RegExp(`^(\\s*\\S+){0,${window + 1}}`).exec(text.slice(offset))[0];
    b = offset + after.length;
  }
  // Cut at caption tags, keeping the side the word is on.
  const a0 = a;
  for (const m of text.slice(a, b).matchAll(TAG)) {
    const ts = a0 + m.index, te = ts + m[0].length;
    if (te <= offset) a = Math.max(a, te);
    else if (ts > offset) { b = Math.min(b, ts); break; }
  }
  const raw = text.slice(a, b);
  const lead = raw.length - raw.trimStart().length;
  return { sentence: raw.trim(), start: a + lead };
}

// Candidate multi-word expressions around the word at `offset` in `sentence`:
// runs of 3 and 2 adjacent words (separated only by spaces) that contain it,
// longest first, at most 5. -> [{surface, terms}] (terms = normalized keys).
export function expressionCandidates(sentence, offset, lang) {
  const words = [];
  let pos = 0;
  for (const t of tokenize(sentence, lang)) {
    if (t.n) words.push({ t: t.t, n: t.n, at: pos, gapBefore: words.length ? sentence.slice(words.at(-1).end, pos) : '' });
    if (t.n) words.at(-1).end = pos + t.t.length;
    pos += t.t.length;
  }
  const i = words.findIndex((w) => offset >= w.at && offset < w.end);
  if (i === -1) return [];
  const out = [];
  for (const len of [3, 2]) {
    for (let s = i - len + 1; s <= i; s++) {
      const run = words.slice(Math.max(0, s), s + len);
      if (s < 0 || run.length !== len || run.slice(1).some((w) => !/^\s+$/.test(w.gapBefore))) continue;
      out.push({ surface: run.map((w) => w.t.toLocaleLowerCase()).join(' '), terms: run.map((w) => w.n) });
    }
  }
  return out.slice(0, 5);
}

// FNV-1a: a short stable hash for cache keys.
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// The sentence around a word, used as the context line on flashcards.
export function sentenceAround(text, term) {
  const sentences = text.match(/[^.!?…。？！]+[.!?…。？！]*/g) || [text];
  const needle = normalize(term);
  const hit = sentences.find((s) => normalize(s).includes(needle)) || text;
  const s = hit.trim();
  return s.length > 240 ? s.slice(0, 237) + '…' : s;
}
