// Lingo Reader: the shared AI key.
// A Supabase Edge Function (free plan) that forwards translation/explanation requests to
// Google Gemini's free tier with the project owner's key, so users don't need a key of their
// own. Deploy it as a function named "ai" and add the secret GEMINI_API_KEY
// (docs/SYNC_SETUP.md). Optional secret GEMINI_MODEL overrides the default model.
//
//   POST /functions/v1/ai  {system, user, schema?, model?, fast?, video?: {url, start?, end?}}
//   -> {ok: true, text, model, video?: true} | {ok: false, status?, error}

const DEFAULT_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
const MAX_CHARS = 60000; // about the 30k-character transcript excerpt plus the prompt

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (obj: unknown) =>
  new Response(JSON.stringify(obj), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

// "Verify JWT" (on by default) has already checked the signature; the public anon key is a
// valid JWT too, so also require a logged-in user.
function loggedIn(req: Request) {
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'authenticated';
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (new URL(req.url).searchParams.get('ping')) return reply({ ok: true, ping: true });
  if (req.method !== 'POST') return reply({ ok: false, error: 'POST only' });
  if (!loggedIn(req)) return reply({ ok: false, error: 'Log in to your account to use the shared AI, or add your own free key in Settings.' });
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return reply({ ok: false, error: 'The shared AI key isn’t set up on the sync server yet (secret GEMINI_API_KEY).' });

  let body: { system?: string; user?: string; schema?: unknown; model?: string; fast?: boolean;
    video?: { url?: string; start?: number; end?: number } };
  try { body = await req.json(); } catch { return reply({ ok: false, error: 'Bad request' }); }
  const system = String(body.system || ''), user = String(body.user || '');
  if (!user || system.length + user.length > MAX_CHARS) return reply({ ok: false, error: 'Request too large' });
  const model = /^gemini-[\w.-]+$/.test(body.model || '') ? body.model! : DEFAULT_MODEL;
  // A public YouTube video to transcribe (js/video-ai.js), optionally one part of it.
  const v = body.video;
  if (v && !/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(v.url || '')) return reply({ ok: false, error: 'Bad video link' });
  const videoParts = !v ? [] : [{
    fileData: { fileUri: v.url },
    ...(v.end ? { videoMetadata: { startOffset: `${Math.max(0, Number(v.start) || 0)}s`, endOffset: `${Number(v.end) || 0}s` } } : {}),
  }];

  // Quick lookups get only a little "thinking" (same rule as js/ai.js thinkingLight).
  const thinking = !body.fast ? null
    : /^gemini-2\.5-/.test(model) ? (/pro/.test(model) ? null : { thinkingBudget: 512 })
    : /^gemini-[3-9]/.test(model) ? { thinkingLevel: 'low' } : null;
  const send = (withThinking: boolean) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [...videoParts, { text: user }] }],
      generationConfig: {
        temperature: 0, responseMimeType: 'application/json',
        ...(v ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
        ...(body.schema ? { responseSchema: body.schema } : {}),
        ...(withThinking && thinking ? { thinkingConfig: thinking } : {}),
      },
    }),
  });

  try {
    let res = await send(true);
    let data = await res.json().catch(() => ({}));
    if (res.status === 400 && thinking && /think/i.test(data?.error?.message || '')) {
      res = await send(false);
      data = await res.json().catch(() => ({}));
    }
    if (!res.ok) return reply({ ok: false, status: res.status, error: data?.error?.message || res.statusText });
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('');
    return reply({ ok: true, text, model, ...(v ? { video: true } : {}) });
  } catch {
    return reply({ ok: false, error: 'Couldn’t reach Google’s AI from the server.' });
  }
});
