// Lingo Reader: the shared AI key.
// A Supabase Edge Function (free plan) that forwards translation/explanation requests to
// Google Gemini's free tier with the project owner's key, so users don't need a key of their
// own. Deploy it as a function named "ai" and add the secret GEMINI_API_KEY
// (docs/SYNC_SETUP.md). Optional secret GEMINI_MODEL overrides the default model.
//
//   POST /functions/v1/ai  {system, user, schema?, model?}
//   -> {ok: true, text, model} | {ok: false, status?, error}

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

  let body: { system?: string; user?: string; schema?: unknown; model?: string };
  try { body = await req.json(); } catch { return reply({ ok: false, error: 'Bad request' }); }
  const system = String(body.system || ''), user = String(body.user || '');
  if (!user || system.length + user.length > MAX_CHARS) return reply({ ok: false, error: 'Request too large' });
  const model = /^gemini-[\w.-]+$/.test(body.model || '') ? body.model! : DEFAULT_MODEL;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', ...(body.schema ? { responseSchema: body.schema } : {}) },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return reply({ ok: false, status: res.status, error: data?.error?.message || res.statusText });
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('');
    return reply({ ok: true, text, model });
  } catch {
    return reply({ ok: false, error: 'Couldn’t reach Google’s AI from the server.' });
  }
});
