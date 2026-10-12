// Transcript timeline: which line is being spoken at time t, and how far into it.
// Pure functions (see docs/PLAN.md, C3).

const SEC_PER_WORD = 0.5;

// segments: [{text, start?, end?, marks?}] -> [{i, start, end}] for the timed segments, in order.
// A line ends at its own end time, the next line's start, or after a cap
// (so long pauses between captions read as gaps rather than one endless line).
export function buildTimeline(segments, { maxLine = 12 } = {}) {
  const timed = segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => typeof s.start === 'number' && !Number.isNaN(s.start))
    .sort((a, b) => a.s.start - b.s.start);
  return timed.map(({ s, i }, k) => {
    const next = timed[k + 1]?.s.start ?? Infinity;
    const words = s.text.split(/\s+/).filter(Boolean).length;
    const cap = s.start + Math.max(maxLine, words * SEC_PER_WORD);
    const end = Math.min(s.end ?? Infinity, next, cap);
    return { i, start: s.start, end: end > s.start ? end : s.start + 0.5 };
  });
}

// -> {pos, idx, inGap}: pos indexes the timeline, idx the lesson segment; -1 before the first line.
export function activeIndex(tl, t) {
  let lo = 0, hi = tl.length - 1, pos = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tl[mid].start <= t) { pos = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (pos === -1) return { pos: -1, idx: -1, inGap: false };
  return { pos, idx: tl[pos].i, inGap: t > tl[pos].end };
}

// Character offset reached in a line at time t, interpolating between cue marks
// ([[charOffset, startTime], ...], kept when short captions were merged).
export function charAt(seg, entry, t) {
  const marks = seg.marks?.length ? seg.marks : [[0, entry.start]];
  const len = seg.text.length;
  if (t <= marks[0][1]) return 0;
  for (let k = 0; k < marks.length; k++) {
    const [c0, t0] = marks[k];
    const [c1, t1] = marks[k + 1] || [len, entry.end];
    if (t < t1 || k === marks.length - 1) {
      if (t1 <= t0) return c1;
      return Math.round(c0 + (c1 - c0) * Math.min(1, (t - t0) / (t1 - t0)));
    }
  }
  return len;
}
