// YouTube captions fetched by the phone itself. Only works inside the native app
// (mobile/, Capacitor with CapacitorHttp), where requests go through the phone's own
// networking instead of the browser's, so YouTube's cross-origin block doesn't apply.
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

async function player(videoId) {
  let blocked = false;
  for (const c of CLIENTS) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': c.agent },
        body: JSON.stringify({ context: { client: c.context }, videoId }),
      });
      if (!res.ok) { blocked = true; continue; }
      const p = await res.json();
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
    const res = await fetch(url, { headers: { 'User-Agent': agent } });
    const vtt = await res.text();
    if (!vtt.includes('-->')) return { ok: false, error: res.ok ? 'empty' : 'blocked', title, tracks };
    return { ok: true, title, track: pick, tracks, vtt };
  } catch {
    return { ok: false, error: 'network', title, tracks };
  }
}
