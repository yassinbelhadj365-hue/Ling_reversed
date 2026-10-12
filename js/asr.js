// AI transcription: turn audio into timed text with Whisper, running on this device
// (js/asr-worker.js). Audio comes from a local file, or for YouTube from the app's
// local server (serve.ps1 /api/audio, which uses yt-dlp).
import { state } from './state.js';
import { formatTime } from './text.js';

const SAMPLE_RATE = 16000;
const BLOCK_SEC = 120;       // transcribe in blocks so progress can be shown and memory stays bounded
const SEARCH_SEC = 2;        // ...cutting each block at the quietest moment near the boundary

export const MODELS = {
  base: { id: 'onnx-community/whisper-base', label: 'Whisper base — 73 MB download, faster' },
  small: { id: 'onnx-community/whisper-small', label: 'Whisper small — 237 MB download, more accurate' },
};

// Whisper sometimes "hears" these on silence or music.
const HALLUCINATIONS = /^(?:\s*(?:subt[ií]tulos (?:realizados )?por.*|amara\.org.*|suscr[ií]bete.*|gracias por ver.*|thanks? (?:you )?for watching.*|\[?m[uú]sica\]?|\[music\]|♪+)\s*)$/i;

export async function capabilities() {
  try {
    const res = await fetch('api/capabilities');
    if (res.headers.get('content-type')?.includes('json')) return await res.json();
  } catch { /* no local server */ }
  return { transcripts: false, audio: false };
}

export async function fetchYouTubeAudio(videoId) {
  let res;
  try { res = await fetch(`api/audio?v=${videoId}`); } catch { throw new Error('no-server'); }
  if (res.headers.get('content-type')?.includes('json')) {
    const r = await res.json().catch(() => ({}));
    throw new Error(r.error || 'download-failed');
  }
  if (!res.ok) throw new Error('no-server');
  return res.arrayBuffer();
}

// Any audio/video file -> mono Float32Array at 16 kHz.
export async function decodeAudio(arrayBuffer) {
  const ac = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const buf = await ac.decodeAudioData(arrayBuffer);
    if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
    }
    return out;
  } finally {
    ac.close();
  }
}

// Block boundaries (in samples), each moved to the quietest 20 ms within ±2 s.
export function splitPoints(audio) {
  const frame = SAMPLE_RATE / 50;
  const points = [0];
  for (let b = BLOCK_SEC * SAMPLE_RATE; b < audio.length - SEARCH_SEC * SAMPLE_RATE; b += BLOCK_SEC * SAMPLE_RATE) {
    let best = b, bestE = Infinity;
    for (let s = b - SEARCH_SEC * SAMPLE_RATE; s < b + SEARCH_SEC * SAMPLE_RATE; s += frame) {
      let e = 0;
      for (let i = s; i < s + frame; i++) e += audio[i] * audio[i];
      if (e < bestE) { bestE = e; best = s; }
    }
    points.push(best);
  }
  points.push(audio.length);
  return points;
}

let worker = null;
let seq = 0;

function getWorker() {
  if (!worker) worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  return worker;
}

function call(msg, onEvent) {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const done = () => { w.removeEventListener('message', handler); w.removeEventListener('error', failed); };
    const handler = (e) => {
      const m = e.data;
      if (m.type === 'download') return onEvent?.(m);
      if (m.id !== undefined && m.id !== id) return;
      done();
      if (m.type === 'error') reject(new Error(m.message));
      else resolve(m);
    };
    // The worker script itself failed (e.g. the AI library couldn't be downloaded).
    const failed = (e) => {
      done();
      worker = null;
      reject(new Error(`the AI engine couldn’t start (${e.message || 'offline?'})`));
    };
    w.addEventListener('message', handler);
    w.addEventListener('error', failed);
    w.postMessage({ ...msg, id }, msg.audio ? [msg.audio.buffer] : []);
  });
}

async function loadModel(onProgress) {
  const model = (MODELS[state.settings.asrModel] || MODELS.base).id;
  const files = new Map();
  const report = (m) => {
    files.set(m.file, m);
    const total = [...files.values()].reduce((a, f) => a + (f.total || 0), 0);
    const loaded = [...files.values()].reduce((a, f) => a + (f.loaded || 0), 0);
    if (total) onProgress?.({ stage: 'model', fraction: loaded / total });
  };
  // WebGPU is much faster, but navigator.gpu can exist without a usable adapter.
  const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  if (adapter) {
    try { return await call({ type: 'load', model, device: 'webgpu' }, report); } catch {
      worker?.terminate(); // start the WASM fallback in a clean worker
      worker = null;
    }
  }
  return call({ type: 'load', model, device: 'wasm' }, report);
}

// -> [{start, end, text}] in seconds.
export async function transcribe(audio, { lang, onProgress } = {}) {
  if (window.__lingoASR) return window.__lingoASR(audio, { lang, onProgress }); // smoke-test hook
  onProgress?.({ stage: 'model', fraction: 0 });
  await loadModel(onProgress);
  const points = splitPoints(audio);
  const total = audio.length / SAMPLE_RATE;
  const cues = [];
  for (let k = 0; k < points.length - 1; k++) {
    const offset = points[k] / SAMPLE_RATE;
    onProgress?.({ stage: 'transcribe', done: offset, total });
    const block = audio.slice(points[k], points[k + 1]);
    const { chunks } = await call({ type: 'run', audio: block, language: lang });
    const blockEnd = points[k + 1] / SAMPLE_RATE;
    for (const c of chunks) {
      const text = (c.text || '').trim();
      if (!text || HALLUCINATIONS.test(text)) continue;
      const start = offset + (c.timestamp?.[0] ?? 0);
      const end = c.timestamp?.[1] != null ? offset + c.timestamp[1] : blockEnd;
      if (cues.length && cues.at(-1).text === text) continue; // repeated chunk
      cues.push({ start, end: Math.max(end, start + 0.3), text });
    }
  }
  onProgress?.({ stage: 'transcribe', done: total, total });
  return cues;
}

export function toVtt(cues) {
  const ts = (s) => {
    const ms = Math.round(s * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  return 'WEBVTT\n\n' + cues.map((c) => `${ts(c.start)} --> ${ts(c.end)}\n${c.text}`).join('\n\n') + '\n';
}

export function progressText(p) {
  if (p.stage === 'audio') return 'Getting the audio…';
  if (p.stage === 'decode') return 'Preparing the audio…';
  if (p.stage === 'model') return p.fraction > 0 && p.fraction < 1
    ? `Downloading the AI model (first time only)… ${Math.round(p.fraction * 100)}%`
    : 'Loading the AI model…';
  return `Transcribing with AI… ${formatTime(p.done)} of ${formatTime(p.total)}`;
}

export const AUDIO_ERRORS = {
  'no-server': 'AI transcription of YouTube videos needs the app running from Start Lingo Reader on your computer.',
  'no-ytdlp': 'The audio downloader (yt-dlp) isn’t installed. Run: winget install yt-dlp.yt-dlp — then restart the app.',
  'download-failed': 'Couldn’t download this video’s audio. It may be private, age-restricted or region-locked.',
  'bad-id': 'That doesn’t look like a YouTube video link.',
};
