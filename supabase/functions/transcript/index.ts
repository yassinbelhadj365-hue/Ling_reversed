// Lingo Reader: YouTube transcripts without a computer.
// A Supabase Edge Function (free plan) that does what serve.ps1's /api/transcript does,
// so a phone can fetch captions on its own. Deploy it as a function named "transcript"
// (docs/SYNC_SETUP.md). YouTube sometimes refuses requests from cloud servers; then the
// app falls back to asking your computer.
//
//   GET /functions/v1/transcript?v=<videoId>&lang=<code>[&track=<n>]
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const reply = (obj: unknown) =>
  new Response(JSON.stringify(obj), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

type Track = { index: number; lang: string; kind: 'auto' | 'manual'; name: string };

async function player(videoId: string) {
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
      // "Sign in to confirm you're not a bot": YouTube refuses this server.
      if (status === 'LOGIN_REQUIRED' || (status === 'UNPLAYABLE' && !p?.captions)) { blocked = true; continue; }
      return { p, agent: c.agent };
    } catch {
      continue;
    }
  }
  return { error: blocked ? 'blocked' : 'network' };
}

async function transcript(videoId: string, lang: string, track: string | null) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { ok: false, error: 'bad-id' };
  const r = await player(videoId);
  if (!('p' in r)) return { ok: false, error: r.error };
  const { p, agent } = r;
  const title = p?.videoDetails?.title || '';
  const all = p?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const tracks: Track[] = all.map((t: any, index: number) => ({
    index,
    lang: t.languageCode,
    kind: t.kind === 'asr' ? 'auto' : 'manual',
    name: t.name?.simpleText || (t.name?.runs || []).map((x: any) => x.text).join(''),
  }));
  if (!tracks.length) return { ok: false, error: 'no-captions', title };
  let pick: Track | undefined;
  if (track && /^\d+$/.test(track) && Number(track) < tracks.length) pick = tracks[Number(track)];
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const q = new URL(req.url).searchParams;
  if (q.get('ping')) return reply({ ok: true, ping: true });
  return reply(await transcript(q.get('v') || '', q.get('lang') || '', q.get('track')));
});
