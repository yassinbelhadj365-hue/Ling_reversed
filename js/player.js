// One interface over the YouTube player and local <audio>/<video> (docs/PLAN.md, C3).
// createPlayer(box, {youtubeId, blob, type}) -> {
//   kind, getTime(), isPlaying(), play(), pause(), seek(t), setRate(r), on(event, fn), destroy()
// }   events: 'state' (playing: boolean), 'ended'
//
// YouTube uses the official IFrame Player API; if that script can't load
// (offline, blocked), it falls back to the iframe's postMessage protocol.
import { esc } from './state.js';

const POLL_MS = 250;
const API_TIMEOUT_MS = 5000;
let apiPromise = null;

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiPromise = null; reject(new Error('YouTube API failed to load')); };
      document.head.append(s);
    });
  }
  return apiPromise;
}

function emitter() {
  const handlers = {};
  return {
    on: (evt, fn) => { (handlers[evt] ||= []).push(fn); },
    emit: (evt, ...a) => (handlers[evt] || []).forEach((fn) => fn(...a)),
  };
}

export function createPlayer(box, media) {
  if (window.__lingoFakePlayer) return window.__lingoFakePlayer(box, media); // smoke-test hook
  if (media.youtubeId) return youTubePlayer(box, media.youtubeId, media.start);
  if (media.blob) return mediaElementPlayer(box, media.blob, media.type, media.start);
  return null;
}

// start: where to open (seconds), without playing: the first Play continues from there.
function mediaElementPlayer(box, blob, type, start = 0) {
  const url = URL.createObjectURL(blob);
  const isVideo = (type || '').startsWith('video');
  box.innerHTML = isVideo ? `<video controls playsinline src="${url}"></video>` : `<audio controls src="${url}"></audio>`;
  const el = box.firstElementChild;
  if (start) el.addEventListener('loadedmetadata', () => { el.currentTime = start; }, { once: true });
  const ev = emitter();
  el.addEventListener('play', () => ev.emit('state', true));
  el.addEventListener('pause', () => ev.emit('state', false));
  el.addEventListener('ended', () => ev.emit('ended'));
  return {
    kind: 'media',
    getTime: () => el.currentTime,
    isPlaying: () => !el.paused && !el.ended,
    play: () => el.play().catch(() => {}),
    pause: () => el.pause(),
    seek: (t) => { el.currentTime = Math.max(0, t); },
    setRate: (r) => { el.playbackRate = r; },
    on: ev.on,
    destroy: () => { el.pause(); URL.revokeObjectURL(url); },
  };
}

function youTubePlayer(box, id, start = 0) {
  const origin = encodeURIComponent(location.origin);
  box.innerHTML = `<iframe allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen
    src="https://www.youtube.com/embed/${esc(id)}?enablejsapi=1&playsinline=1&rel=0${start ? `&start=${Math.floor(start)}` : ''}&origin=${origin}"></iframe>`;
  const frame = box.querySelector('iframe');
  const ev = emitter();
  // Clock: last reported time + elapsed wall time while playing.
  let t = start, at = performance.now(), playing = false, rate = 1;
  let api = null;          // YT.Player once ready
  let poll = null;
  let dead = false;

  const setPlaying = (p) => {
    if (p === playing) return;
    t = now(); at = performance.now(); playing = p;
    ev.emit('state', p);
  };
  const report = (time) => { t = time; at = performance.now(); };
  const now = () => (playing ? t + ((performance.now() - at) / 1000) * rate : t);

  // ---- official API ----
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), API_TIMEOUT_MS));
  Promise.race([loadYouTubeApi(), timeout]).then((YT) => {
    if (dead) return;
    const p = new YT.Player(frame, {
      events: {
        onReady: () => {
          api = p;
          poll = setInterval(() => {
            if (!playing) return;
            try { report(api.getCurrentTime()); rate = api.getPlaybackRate() || 1; } catch { /* player gone */ }
          }, POLL_MS);
        },
        onStateChange: (e) => {
          try { report(p.getCurrentTime()); } catch { /* ignore */ }
          if (e.data === 1) setPlaying(true);
          else if (e.data === 2 || e.data === 0) setPlaying(false);
          if (e.data === 0) ev.emit('ended');
        },
        onPlaybackRateChange: (e) => { rate = e.data || 1; },
      },
    });
  }).catch(() => { if (!dead) useFallback(); });

  // ---- fallback: raw postMessage protocol ----
  let onMsg = null;
  function useFallback() {
    const post = (msg) => frame.contentWindow?.postMessage(JSON.stringify(msg), '*');
    onMsg = (e) => {
      try {
        if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname)) return;
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        const info = data?.info;
        if (!info) return;
        if (info.currentTime != null) report(info.currentTime);
        if (info.playbackRate) rate = info.playbackRate;
        if (info.playerState === 1) setPlaying(true);
        else if (info.playerState === 2 || info.playerState === 0) setPlaying(false);
        if (info.playerState === 0) ev.emit('ended');
      } catch { /* not a player message */ }
    };
    window.addEventListener('message', onMsg);
    post({ event: 'listening', id: 'lingo', channel: 'widget' });
    frame.addEventListener('load', () => post({ event: 'listening', id: 'lingo', channel: 'widget' }));
    fallbackCmd = (func, args = []) => post({ event: 'command', func, args });
  }
  let fallbackCmd = null;
  const cmd = (func, args = []) => {
    if (api) { try { api[func](...args); } catch { /* ignore */ } }
    else fallbackCmd?.(func, args);
  };

  return {
    kind: 'youtube',
    getTime: now,
    isPlaying: () => playing,
    play: () => cmd('playVideo'),
    pause: () => cmd('pauseVideo'),
    seek: (s) => { report(Math.max(0, s)); cmd('seekTo', [Math.max(0, s), true]); },
    setRate: (r) => cmd('setPlaybackRate', [r]),
    on: ev.on,
    destroy: () => {
      dead = true;
      clearInterval(poll);
      if (onMsg) window.removeEventListener('message', onMsg);
      try { api?.destroy(); } catch { /* ignore */ }
    },
  };
}
