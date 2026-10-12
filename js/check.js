// Transcript check: compare each transcript line with what AI speech recognition
// heard in the same time window, and flag the words that differ. Pure functions.
import { tokenize } from './text.js';

const PAD_SEC = 0.5;        // ASR timing is approximate: look a little before/after the line
const MIN_MATCHED = 0.4;    // if less of the line matches, the ASR probably failed here (music, noise)

const words = (text, lang) => {
  const out = [];
  let o = 0;
  for (const t of tokenize(text, lang)) {
    if (t.n) out.push({ n: t.n, t: t.t, o });
    o += t.t.length;
  }
  return out;
};

// Longest common subsequence of two token lists -> matched index pairs [[i, j], ...].
export function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return pairs;
}

// -> [{o, len, said, heard}] for one line: o/len = character range in the line.
// heard = what the audio seems to say there ('' = nothing heard).
export function compareLine(lineText, heardText, lang) {
  const A = words(lineText, lang);
  const B = words(heardText, lang);
  if (!A.length || !B.length) return [];
  const pairs = lcsPairs(A.map((w) => w.n), B.map((w) => w.n));
  if (pairs.length < MIN_MATCHED * A.length) return [];
  const flags = [];
  const anchors = [[-1, -1], ...pairs, [A.length, B.length]];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [a0, b0] = anchors[k];
    const [a1, b1] = anchors[k + 1];
    if (a1 - a0 <= 1) continue; // no transcript words between these anchors
    const gapA = A.slice(a0 + 1, a1);
    let gapB = B.slice(b0 + 1, b1);
    // At the line's edges the heard text also holds words from neighbouring lines:
    // keep only as many as the transcript gap, next to the anchor.
    if (k === 0) gapB = gapB.slice(-gapA.length);
    if (k + 1 === anchors.length - 1) gapB = gapB.slice(0, gapA.length);
    const first = gapA[0], last = gapA.at(-1);
    flags.push({
      o: first.o,
      len: last.o + last.t.length - first.o,
      said: lineText.slice(first.o, last.o + last.t.length),
      heard: gapB.map((w) => w.t).join(' '),
    });
  }
  return flags;
}

// What the ASR heard during [start, end]: cues that substantially overlap the
// (slightly padded) line, so a neighbouring line's words can't mask a mistake.
export function heardBetween(cues, start, end) {
  const lo = start - PAD_SEC, hi = end + PAD_SEC;
  return cues
    .filter((c) => {
      const overlap = Math.min(c.end, hi) - Math.max(c.start, lo);
      return overlap > 0 && (overlap >= 0.3 * (c.end - c.start) || overlap >= 0.5 * (end - start));
    })
    .map((c) => c.text)
    .join(' ');
}

// -> {segmentIndex: [flags]} for every timed line.
export function checkTranscript(segments, timeline, cues, lang) {
  const out = {};
  for (const entry of timeline) {
    const flags = compareLine(segments[entry.i].text, heardBetween(cues, entry.start, entry.end), lang);
    if (flags.length) out[entry.i] = flags;
  }
  return out;
}
