// YouTube captions fetched by the phone itself. Only works inside the native app
// (mobile/, Capacitor), where requests can go through the phone's own networking.
// Same steps as serve.ps1's Get-Transcript and supabase/functions/transcript.
//   -> {ok, title, track, tracks, vtt} | {ok:false, error}

const CLIENTS = [
  {
    context: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' },
    agent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
  },
  {
    context: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en' },
    agent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
  },
];

// Inside the Capacitor app on a phone?
export const isNativeApp = () => !!window.Capacitor?.isNativePlatform?.();

// A request through the phone's own networking (Capacitor's built-in HTTP plugin), so
// YouTube's cross-origin block doesn't apply. Only these requests go this way; the rest
// of the app uses the normal fetch. -> {ok, status, text}
async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const http = window.Capacitor?.Plugins?.CapacitorHttp;
  if (!http) {
    const res = await fetch(url, { method, headers, body });
    return { ok: res.ok, status: res.status, text: await res.text() };
  }
  const res = await http.request({ url, method, headers, data: body ? JSON.parse(body) : undefined, responseType: 'text' });
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, text };
}

async function player(videoId) {
  let blocked = false;
  for (const c of CLIENTS) {
    try {
      const res = await request('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': c.agent },
        body: JSON.stringify({ context: { client: c.context }, videoId }),
      });
      if (!res.ok) { blocked = true; continue; }
      const p = JSON.parse(res.text);
      const status = p?.playabilityStatus?.status;
      if (status === 'LOGIN_REQUIRED' || (status === 'UNPLAYABLE' && !p?.captions)) { blocked = true; continue; }
      return { p, agent: c.agent };
    } catch {
      continue;
    }
  }
  return { error: blocked ? 'blocked' : 'network' };
}

export async function phoneTranscript(videoId, lang, track = '') {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { ok: false, error: 'bad-id' };
  const r = await player(videoId);
  if (r.error) return { ok: false, error: r.error };
  const { p, agent } = r;
  const title = p?.videoDetails?.title || '';
  const all = p?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const tracks = all.map((t, index) => ({
    index,
    lang: t.languageCode,
    kind: t.kind === 'asr' ? 'auto' : 'manual',
    name: t.name?.simpleText || (t.name?.runs || []).map((x) => x.text).join(''),
  }));
  if (!tracks.length) return { ok: false, error: 'no-captions', title };
  let pick;
  if (track !== '' && track != null && /^\d+$/.test(String(track)) && Number(track) < tracks.length) pick = tracks[Number(track)];
  if (!pick) {
    const inLang = tracks.filter((t) => t.lang === lang || t.lang.startsWith(`${lang}-`));
    pick = inLang.find((t) => t.kind === 'manual') || inLang[0];
  }
  if (!pick) return { ok: false, error: 'no-track', title, tracks };
  const url = `${all[pick.index].baseUrl.replace(/&fmt=[^&]*/, '')}&fmt=vtt`;
  try {
    const res = await request(url, { headers: { 'User-Agent': agent } });
    const vtt = res.text;
    if (!vtt.includes('-->')) return { ok: false, error: res.ok ? 'empty' : 'blocked', title, tracks };
    return { ok: true, title, track: pick, tracks, vtt };
  } catch {
    return { ok: false, error: 'network', title, tracks };
  }
}

// ---------- the iPhone Shortcut (docs/IPHONE_SHORTCUT.md) ----------
// iPhones can't run the app above for free, but a Shortcut can download captions on the
// phone. It copies this text, which the Import screen recognizes when pasted:
//   LINGO-YT
//   <video id>
//   <title>
//   =====TRACK
//   <the caption track's details from YouTube, as the Shortcut prints them>
//   =====VTT
//   <the track's WebVTT>
//   (=====TRACK … again for each track)
export const SHORTCUT_MARK = 'LINGO-YT';

// -> {videoId, title, tracks: [{index, lang, kind, name, vtt}]} | null
export function parseShortcut(text) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trimStart();
  if (!clean.startsWith(SHORTCUT_MARK)) return null;
  const [head, ...chunks] = clean.split(/^=====TRACK[ \t]*$/m);
  const [, videoId = '', title = ''] = head.split('\n').map((l) => l.trim());
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  // The details are JSON, but read them leniently: spaces, and quotes may be missing.
  const field = (s, key) => new RegExp(`"?${key}"?\\s*[:=]\\s*"?([^"\\n,}]*)`).exec(s)?.[1].trim() || '';
  const tracks = chunks.map((chunk) => {
    const [info, vtt = ''] = chunk.split(/^=====VTT[ \t]*$/m);
    const lang = field(info, 'languageCode');
    return { lang, kind: field(info, 'kind') === 'asr' ? 'auto' : 'manual', name: field(info, 'simpleText') || field(info, 'text') || lang, vtt: vtt.trim() };
  }).filter((t) => t.lang && t.vtt.includes('-->')).map((t, index) => ({ index, ...t }));
  return { videoId, title, tracks };
}

// The same result shape as phoneTranscript, choosing the track like it does.
export function pickShortcutTrack(s, lang, track = '') {
  const tracks = s.tracks.map(({ vtt, ...t }) => t);
  if (!tracks.length) return { ok: false, error: 'no-captions', title: s.title };
  let pick = track !== '' && track != null ? s.tracks[Number(track)] : null;
  if (!pick) {
    const inLang = s.tracks.filter((t) => t.lang === lang || t.lang.startsWith(`${lang}-`));
    pick = inLang.find((t) => t.kind === 'manual') || inLang[0];
  }
  if (!pick) return { ok: false, error: 'no-track', title: s.title, tracks };
  const { vtt, ...info } = pick;
  return { ok: true, title: s.title, track: info, tracks, vtt };
}
