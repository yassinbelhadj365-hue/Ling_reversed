// Importing on devices that can't download from YouTube (phones, the online version).
//
// Browsers can't read YouTube captions or audio (YouTube refuses other websites), so only a
// computer running Start Lingo Reader (serve.ps1) can. A phone signed in to the same account
// leaves a request in the synced kv store (`job:<id>`); the computer, while Lingo Reader is open
// there, fetches the transcript (or transcribes the audio with AI) and writes the result back
// into the request. The phone then creates the lesson itself, so it lands in its vocab pool.
import * as db from './db.js';
import { newLessonId, deviceId } from './db.js';
import { state, lang, langName, addLessonToPool, toast, plural } from './state.js';
import { parseAny, mergeCues, countWords } from './text.js';
import { activeAccount, isSignedIn, cloudConfig, syncNow, onStatus, callFunction } from './cloud.js';
import { isNativeApp, phoneTranscript } from './youtube.js';
import { capabilities, fetchYouTubeAudio, decodeAudio, transcribe, toVtt } from './asr.js';

const PREFIX = 'job:';
const STALE_MS = 20 * 60_000;     // a computer that took a job and went quiet: let another try
const POLL_WAITING_MS = 10_000;   // phone, while waiting for its requests
const POLL_SERVER_MS = 20_000;    // computer with the server, watching for requests

// ---------- creating lessons (shared with the Import screen) ----------

export function prepare(raw, filename, merge) {
  const { segments, timed } = parseAny(raw, filename);
  const segs = timed && merge ? mergeCues(segments) : segments;
  const { counts, total } = countWords(segs, lang());
  return { segments: segs, timed, counts, total };
}

export function firstLine(text) {
  // The first line of actual text: skip subtitle headers, cue numbers and timing lines.
  const line = text.trim().split('\n').find((l) => l.trim()
    && !/^[\d:.,\s\-–>\[\]]+$/.test(l) && !l.includes('-->') && !/^(WEBVTT|Kind:|Language:|NOTE\b)/.test(l.trim())) || 'Untitled';
  return line.trim().slice(0, 70);
}

// -> {lesson, newWords} | null when the text has no words. Uses the current language.
export async function createLesson({ raw, filename = '', title, merge, asr = false, source = '', youtubeId = null, media = null }) {
  const p = prepare(raw, filename, merge);
  if (!p.total) return null;
  const lesson = {
    id: newLessonId(),
    lang: lang(), title: title || firstLine(raw), kind: p.timed ? 'transcript' : 'text', asr,
    source, youtubeId,
    segments: p.segments, words: p.counts, wordCount: p.total,
    createdAt: Date.now(), openedAt: 0, page: 0, completed: false,
  };
  if (media) {
    lesson.hasMedia = true;
    await db.put('media', { lessonId: lesson.id, blob: media, type: media.type, updatedAt: Date.now() });
  }
  await db.put('lessons', lesson);
  return { lesson, newWords: await addLessonToPool(lesson) };
}

// ---------- the local server ----------

let caps = null;
export const serverCaps = () => (caps ||= capabilities());

// How the last cloud attempt went: '' (worked or not tried), 'missing' (no cloud helper), 'blocked', 'network'.
export let cloudOutcome = '';

// YouTube captions -> {ok, title, track, tracks, vtt, via} | {ok:false, error} | null (nothing could fetch them).
// In the phone app, the phone itself (youtube.js); then serve.ps1 on this device, then the
// cloud helper (Supabase Edge Function "transcript").
export async function fetchTranscript(videoId, language, track = '') {
  const withTrack = track !== '' && track != null;
  if (isNativeApp()) {
    const r = await phoneTranscript(videoId, language, track);
    if (r.ok || !['blocked', 'network'].includes(r.error)) return { ...r, via: 'phone' };
  }
  try {
    const res = await fetch(`api/transcript?v=${videoId}&lang=${language}${withTrack ? `&track=${track}` : ''}`);
    if (res.headers.get('content-type')?.includes('json')) return { ...(await res.json()), via: 'local' };
  } catch { /* no local server */ }
  const c = await callFunction('transcript', { v: videoId, lang: language, ...(withTrack ? { track } : {}) });
  if (!c) { cloudOutcome = 'missing'; return null; }
  // YouTube refused the cloud server (it often does): the computer can still do it.
  if (!c.ok && (c.error === 'blocked' || c.error === 'network')) { cloudOutcome = c.error; return null; }
  cloudOutcome = '';
  return { ...c, via: 'cloud' };
}

// ---------- requests ----------

// Can this device ask another one (signed in to a synced account)?
export function canRelay() {
  const acc = activeAccount();
  return !!(acc && isSignedIn(acc) && cloudConfig());
}

// kind: 'transcript' | 'asr'
export async function requestImport({ kind, videoId, url, title = '', track = '', merge = true }) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id, kind, videoId, url, title, track, merge, lang: lang(),
    from: deviceId(), status: 'pending', createdAt: Date.now(), at: Date.now(),
  };
  await db.setSetting(PREFIX + id, job);
  syncNow();
  watch();
  return job;
}

export async function jobs() {
  return (await db.all('kv')).filter((r) => r.key.startsWith(PREFIX) && r.value).map((r) => r.value);
}
export const myJobs = async () => (await jobs()).filter((j) => j.from === deviceId()).sort((a, b) => a.createdAt - b.createdAt);

export async function cancelJob(id) { await db.del('kv', PREFIX + id); }
// patch: e.g. {track: 2} for another caption track, or {kind: 'asr'} to transcribe with AI instead.
export async function retryJob(id, patch = {}) {
  const key = PREFIX + id;
  const job = await db.getSetting(key, null);
  if (!job) return;
  await db.setSetting(key, { ...job, ...patch, status: 'pending', error: '', worker: '', progress: '', at: Date.now() });
  syncNow();
  watch();
}

const save = (job, patch) => db.setSetting(PREFIX + job.id, { ...job, ...patch, at: Date.now() });

// ---------- the computer: do other devices' requests ----------

let working = false;

async function work() {
  if (working) return;
  const c = await serverCaps();
  if (!c.transcripts) return;
  working = true;
  try {
    for (;;) {
      const job = (await jobs()).find((j) => j.from !== deviceId() && (j.status === 'pending'
        || (j.status === 'working' && Date.now() - j.at > STALE_MS)));
      if (!job) break;
      await save(job, { status: 'working', worker: deviceId(), progress: '' });
      syncNow();
      try {
        const result = job.kind === 'asr' ? await transcribeAudio(job, c) : await captions(job);
        // The phone may have cancelled in the meantime.
        if (await db.getSetting(PREFIX + job.id, null)) await save(job, { status: 'ready', ...result, worker: deviceId() });
      } catch (err) {
        if (await db.getSetting(PREFIX + job.id, null)) {
          await save(job, { status: 'error', error: err.message, tracks: err.tracks || job.tracks || null, worker: deviceId() });
        }
      }
      syncNow();
    }
  } finally {
    working = false;
  }
}

async function captions(job) {
  const r = await fetchTranscript(job.videoId, job.lang, job.track);
  if (!r) throw new Error('no-server');
  if (!r.ok) {
    // Hand the track list back so the phone can offer another track.
    throw Object.assign(new Error(r.error), { tracks: r.tracks?.length ? r.tracks : null });
  }
  return { vtt: r.vtt, ytTitle: r.title || '', trackName: r.track?.name || '', auto: r.track?.kind === 'auto' };
}

async function transcribeAudio(job, c) {
  if (!c.audio) throw new Error('no-ytdlp');
  let last = 0;
  const progress = (p) => {
    // Report progress now and then (each report is a sync).
    if (p.stage !== 'transcribe' || Date.now() - last < 30_000) return;
    last = Date.now();
    db.getSetting(PREFIX + job.id, null).then((j) => j && save(j, { progress: `${Math.round((p.done / p.total) * 100)}%` }));
  };
  const audio = await decodeAudio(await fetchYouTubeAudio(job.videoId));
  const cues = await transcribe(audio, { lang: job.lang, onProgress: progress });
  if (!cues.length) throw new Error('silent');
  return { vtt: toVtt(cues), ytTitle: '' };
}

// ---------- the phone: turn finished requests into lessons ----------

let onLessons = () => {};

async function finish() {
  for (const job of await myJobs()) {
    if (job.status !== 'ready' || job.lang !== lang()) continue;
    await db.del('kv', PREFIX + job.id); // first, so a second pass can't import it twice
    const made = await createLesson({
      raw: job.vtt, title: job.title || job.ytTitle, merge: job.merge, asr: job.kind === 'asr',
      source: job.url, youtubeId: job.videoId,
    });
    if (!made) continue;
    const { lesson, newWords } = made;
    toast(`“${lesson.title}” is ready · ${plural(newWords, 'new word')} added to your pool`, 8000,
      { label: 'Open', onClick: () => { location.hash = `#/lesson/${lesson.id}`; } });
    onLessons();
  }
}

export const JOB_ERRORS = {
  'no-server': 'Your computer isn’t running Start Lingo Reader.',
  'no-track': 'No captions in this language. Choose another track, or transcribe with AI.',
  'no-captions': 'This video has no captions. Try “Transcribe with AI”.',
  'network': 'Your computer couldn’t reach YouTube.',
  'empty': 'YouTube returned empty captions. Try another track.',
  'no-ytdlp': 'The audio downloader (yt-dlp) isn’t installed on your computer.',
  'download-failed': 'Couldn’t download the audio (private, age-restricted or region-locked video?).',
  'silent': 'The AI didn’t hear any speech.',
  'bad-id': 'That isn’t a YouTube video link.',
};

export function jobStatusText(job) {
  if (job.status === 'pending') return 'Waiting for your computer — open Lingo Reader there (Start Lingo Reader).';
  if (job.status === 'working') return job.kind === 'asr'
    ? `Your computer is transcribing it with AI${job.progress ? ` (${job.progress})` : ''}…`
    : 'Your computer is getting the transcript…';
  if (job.status === 'ready') return job.lang === lang() ? 'Ready — adding it…' : `Ready — switch to ${langName(job.lang)} to add it.`;
  return JOB_ERRORS[job.error] || `Failed: ${job.error}`;
}

// ---------- background loop ----------

let started = false;
let timer = null;
let quick = null;

// Do others' requests (computer) and import finished ones (phone).
export async function processRelay() {
  await work().catch(() => {});
  await finish().catch(() => {});
}
const tick = processRelay;

// Sync more often while this phone waits for a request.
async function watch() {
  if (quick) return;
  quick = setInterval(async () => {
    const waiting = (await myJobs()).some((j) => j.status === 'pending' || j.status === 'working');
    if (!waiting) { clearInterval(quick); quick = null; return; }
    if (document.visibilityState === 'visible') syncNow();
  }, POLL_WAITING_MS);
}

// Called once at startup (after the first sync). onChange: a lesson arrived or a request changed.
export function startRelay({ onChange } = {}) {
  if (started || !canRelay()) return;
  started = true;
  if (onChange) onLessons = onChange;
  onStatus((st) => { if (st.state === 'ok') tick(); });
  tick();
  myJobs().then((js) => { if (js.some((j) => j.status === 'pending' || j.status === 'working')) watch(); });
  // A computer with the server checks for requests even when its tab is in the background.
  serverCaps().then((c) => {
    if (c.transcripts && !timer) timer = setInterval(() => syncNow(), POLL_SERVER_MS);
  });
}

// Test hook: forget the cached server capabilities.
export function _resetRelay() { caps = null; started = false; clearInterval(timer); timer = null; clearInterval(quick); quick = null; }
