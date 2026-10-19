// Transcripts for any public YouTube video, written by Gemini from the video itself.
// The fallback when nothing on this device can download YouTube's captions (an iPhone using
// the website): the Gemini API accepts a YouTube link as video input, so no download is needed.
// Long videos go in 10-minute parts (each part is one request, which keeps every answer well
// under the output limit and the shared Edge Function's time limit).
import { geminiJson, hasProvider } from './ai.js';
import { langName } from './state.js';
import { toVtt } from './asr.js';

const PART_S = 600;
const MAX_PARTS = 12; // two hours
const NEAR_END_S = 90; // speech this close to the end of a part: the video goes on

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    lines: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { start: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['start', 'text'] },
    },
  },
  required: ['lines'],
};

// "1:02:03", "02:03", "123", "75.5s" -> seconds; NaN when unreadable.
export function parseStamp(s) {
  const str = String(s ?? '').trim().replace(/s$/i, '');
  if (!/^\d+(?::\d{1,2}){0,2}(?:[.,]\d+)?$/.test(str)) return NaN;
  return str.split(':').reduce((acc, p) => acc * 60 + Number(p.replace(',', '.')), 0);
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function prompt(language, from, to) {
  return {
    system: `You transcribe videos for language learners. Write down exactly what is said in the video, word for word, in the language it is spoken in (expected: ${language}). Don't translate, summarise or correct the speaker. Add normal punctuation and capital letters. Split the speech into short lines of one sentence or about 8–15 words, each with the time it starts as "MM:SS" (or "H:MM:SS"), counted from the start of the whole video. Leave out music and sound effects. Reply with JSON: {"title": "", "lines": [{"start": "MM:SS", "text": ""}]}`,
    user: `Transcribe the speech in this video from ${clock(from)} to ${clock(to)}.${from === 0 ? ' Also give the video a short title in the language spoken, as "title".' : ''} If nobody speaks in that part, return no lines.`,
  };
}

// -> [{start, text}] for one part, times from the start of the whole video, in order.
function readLines(result, from, to) {
  let lines = (result.lines || [])
    .map((l) => ({ start: parseStamp(l.start), text: String(l.text || '').replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text && Number.isFinite(l.start));
  // Some answers count from the start of the part instead of the video.
  if (from > 0 && lines.length && lines[0].start < from - 30 && lines.at(-1).start <= to - from + 30) {
    lines = lines.map((l) => ({ ...l, start: l.start + from }));
  }
  return lines.sort((a, b) => a.start - b.start);
}

// -> {ok: true, title, vtt, track, tracks: [], via: 'gemini'} | {ok: false, error, msg?}
// error: 'no-provider' | 'empty' | 'failed'. onProgress({from, to}) before each part.
export async function videoTranscript(videoId, language, { onProgress } = {}) {
  if (!(await hasProvider({ video: true }))) return { ok: false, error: 'no-provider' };
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const all = [];
  let title = '';
  for (let part = 0; part < MAX_PARTS; part++) {
    const from = part * PART_S, to = from + PART_S;
    onProgress?.({ from, to });
    let result;
    try {
      ({ result } = await geminiJson({
        ...prompt(langName(language), from, to), schema: SCHEMA, fast: true,
        video: { url, start: from, end: to },
      }));
    } catch (err) {
      if (err.message === 'no-provider') return { ok: false, error: 'no-provider' };
      // A later part can fail because the video has ended: keep what we have.
      if (part > 0 && all.length) break;
      return { ok: false, error: 'failed', msg: err.message };
    }
    if (part === 0) title = String(result.title || '').trim();
    // Speech across the join can come back in both parts.
    const prev = all.at(-1);
    const lines = readLines(result, from, to)
      .filter((l) => l.start > (prev?.start ?? -1) && l.start < to + 5 && l.text !== prev?.text);
    all.push(...lines);
    if (!lines.length || lines.at(-1).start < to - NEAR_END_S) break;
  }
  if (!all.length) return { ok: false, error: 'empty' };
  const cues = all.map((l, i) => ({
    start: l.start,
    end: Math.max(l.start + 0.5, Math.min(all[i + 1]?.start ?? Infinity, l.start + 4 + l.text.split(' ').length * 0.5)),
    text: l.text,
  }));
  return {
    ok: true, title, vtt: toVtt(cues), via: 'gemini', tracks: [],
    track: { index: -1, lang: language, kind: 'ai', name: 'AI transcript (Gemini)' },
  };
}
