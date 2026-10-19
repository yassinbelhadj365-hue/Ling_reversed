# Roadmap and status (last updated 2026-10-18)

Read this first when picking the work up again. CLAUDE.md describes the architecture;
this file records where things stand, what the owner decided, and what's next.

## How the owner uses the app

- On an **iPhone**, as the **website added to the home screen** (Safari → Add to Home Screen),
  logged in to their account. Not the sideloaded iOS app (7-day re-signing was rejected).
- Studies French from YouTube videos with **auto-generated captions** (no punctuation).
- Free services only (see CLAUDE.md). Translation AI = Google Gemini free tier.

## Done (all committed and pushed)

- **One AI for everything** (js/ai.js, js/explain.js): Gemini, the user's own key or the shared
  key via `supabase/functions/ai`. MyMemory, Chrome Translator, Nano, OpenRouter and the
  Wiktionary dictionary lists were removed on purpose: users found many translations noisy
  and wrong. Only the meaning that fits the sentence is shown.
- **Word panel**: meaning first (large), a one-line target-language explanation, the context
  with the word marked, its translation with the matching words highlighted, the levels.
  Everything else under a closed "More"; opening More loads examples with translations.
- **Lookup context** (`text.contextAt`): the sentence, or caption lines around the word until
  about 20 words (max ~40); never crosses tags like [Musique]. One line was too little, a
  whole paragraph too much.
- **Meanings (senses)**: a different meaning of a known word in another transcript makes it a
  LingQ again (`state.recordSense`).
- **Motivation**: daily goal in minutes (any study counts), forgiving streak (1 missed day a
  week saved), time studied, lesson difficulty labels ("Easy · you know 96%"), end-of-lesson
  summary, known-word milestones with a celebration, weekly recap, a bar to the next
  milestone, "Continue / Up next" at the top of the Library, first-run welcome with sample
  lessons (js/samples.js), one-box Import.
- **Gemini transcribes any YouTube link** (js/video-ai.js, 2026-10-18): when no captions can be
  downloaded (iPhone website), Gemini watches the public video in 10-minute parts and writes a
  timed, punctuated transcript; the lesson plays the video as usual. Also used by "Transcribe
  the audio with AI" without a local server. Covered by smoke tests with a stubbed Gemini;
  **not yet tried with a real key** (quality, timestamp accuracy, speed, free-tier limits).
- **Stories from your LingQs** (js/story.js, 2026-10-18): Library → ✨ Story (or the card on
  Import). Gemini writes ~150/300/500 words at a level guessed from the known-word count, with
  up to 8 of the weakest LingQs and the most common known words; it becomes a text lesson.
  Not yet tried with a real key (level fit, whether it really uses the targets).
- **Read-aloud with the spoken word highlighted** (reader page mode, 2026-10-18): 🔊 Listen
  reads sentence by sentence with the device voice, the current word outlined; a word tap
  pauses it, closing the panel resumes. Untested on a real iPhone (whether Safari sends word
  `boundary` events for the French voice; without them only the paragraph is highlighted).
- **Sentence mode** (reader, 2026-10-18): 🔍 Sentences shows one sentence (text) or caption
  line (video) at a time, large, with Play (just that line, then it waits), Translate and
  Next; remembered for the next lesson.
- **The AI runs out less** (2026-10-18): each Gemini model has its own free limit, so when one
  is used up the next free Flash/Flash-Lite model answers (own key and shared function). The
  owner asked for this after their key ran out; other providers (Groq, Mistral) and rotating
  several keys were offered and not chosen for now.
- **Busy Gemini no longer fails at once** (2026-10-19): the owner's key "stopped working" when
  Google was overloaded worldwide (HTTP 503 "high demand", not the quota). Now a busy model gets
  one quick retry, then the next Flash model, then Gemma (same key, own free limit, weaker;
  no JSON mode, so the shape goes in the prompt) — own key and shared function. Optional free
  **Mistral** and **Groq** keys in Settings answer when all of Google fails (not for videos).
  Research rejected: GitHub Models (retired), Cerebras and Hugging Face (no free tier any more),
  a cross-user lookup cache.
- **Faster AI** (2026-10-19, the owner said lookups and video transcripts were far too slow):
  taps no longer let Gemini "think" ("More" still does); a tap that waits 2.5 s for Gemini also
  asks Groq/Cohere and shows the first answer; the model list / shared function is warmed at
  start; videos go in 5-minute parts, three at once. Not timed with a real key yet.
- **Instant taps** (2026-10-19, the owner wants taps under half a second, which no AI can do
  live): each page's new and LingQ words (listen mode: the next 8 lines) are looked up in the
  background in batches, so a tap reads a saved answer. Uses more of the free limit; a Settings
  switch turns it off. Words tapped before their batch is back still take a second or two.
- **Offline French dictionary** (2026-10-19, owner asked, French only to save the AI limit):
  a tapped French word shows its Wiktionary meaning greyed at once (js/dictionary.js,
  data/fr-en.tsv, ~396k word forms, 10 MB / ~2 MB compressed), replaced by the AI's meaning in
  the sentence. Background look-ahead is now off by default (Settings switch). Translation
  websites were measured slower than the AI (MyMemory 1.7 s, Lingva 1 s, Google blocked).
- **AI setup in one place** (Settings → AI, 2026-10-19): "Get a free key ↗" per AI, one
  📋 Paste a key button that recognizes Gemini/Mistral/Groq keys and checks them at once, a ✓/✗
  status per AI, and the shared server's state with copy-the-code / open-Supabase steps when it
  needs (re)deploying. Every "no AI" or "busy" message links there. Keys follow the account: pasted once, they reach the owner's other
  devices through sync (the owner asked for this, 2026-10-19: the app is for family and friends);
  a switch on the card turns that off. They never go into backup files.
- **Frictionless pass** (2026-10-19). The owner picked 5 of 18 researched ideas and asked for
  everything "seamless, effortless, no effort outside learning"; three code-walkthrough audits
  found the rest:
  - **Picked:** a tapped word scrolls above its panel; Undo after Next page in both modes; a PNG
    home-screen icon; tap-anywhere review with the grades in one bottom bar; YouTube thumbnail
    and length on lesson cards.
  - **Launch:** opens at once (sync in the background, no "synced" toast); scroll kept per
    screen; no double-tap zoom, tap flash or bounce; a slow page uses the cached version for
    that launch; status-bar colours.
  - **Import:** a link pasted or shared on its own opens its lesson by itself; 📋 Paste link
    in the Library; no captions → Gemini automatically; failures are one line with fix buttons.
  - **Reader:** tap outside or swipe down closes the panel; Known/Ignore close it; Ignore sits
    beside the levels; with a video the panel skips the sentence shown above; video resumes
    where you stopped; the summary opens when the video ends with "Next: …"; ✎ moved into the
    panel; 44 px controls; fewer toasts; phrase selection pauses at once; read-aloud carries on.
  - **Review, vocab, settings:** due count on the Review tab; grading doesn't wait for the save;
    Undo after Known/Ignore; vocab fits a phone; settings show only what applies, rarely used
    ones under Advanced, no "Saved" toasts.
  - **Not done yet** (bigger): Gemini transcription that survives leaving Import, and opening
    a long video before all its parts are transcribed.
- **Phone**: Capacitor app in `mobile/`, built by GitHub Actions (APK + unsigned IPA,
  docs/MOBILE.md); YouTube captions fetched by the native app (js/youtube.js); file picker
  that iPhones don't grey out; iPhone Shortcut route (docs/IPHONE_SHORTCUT.md). The owner
  found building the Shortcut too fiddly and gave up on it.

## Setup only the owner can do (not done yet, as far as we know)

- Add a free Gemini key in Settings (aistudio.google.com/apikey), or deploy the shared `ai`
  function with the `GEMINI_API_KEY` secret (docs/SYNC_SETUP.md). Without one, lookups say
  "No AI is set up yet". Real-key translation quality has **not** been tested yet.
- If the shared `ai` function was deployed before 2026-10-18, redeploy it (new `index.ts`) so
  Gemini can transcribe videos through it. Then try a real French video on the iPhone and check
  the timestamps line up with the speech.
- Redeploy the shared `ai` function (latest `index.ts`; Settings → AI says when it is out of date).
- Optional: free Groq (console.groq.com) and Cohere (dashboard.cohere.com) keys in Settings → AI.
  Mistral no longer gives new accounts free API keys (owner hit this, 2026-10-19).
  Their French translation quality (and Gemma's, Mistral's) has **not** been compared with Gemini yet.
- Put the Supabase Project URL and public anon key in `js/config.js` (Supabase → Settings → API),
  so a fresh iPhone shows the login form directly instead of asking for them.
- Optional: the `transcript` Edge Function (cloud helper) so pasting a link works on iPhone.
- Optional, Android only: signing key secrets so APK updates keep data (docs/MOBILE.md).

## Next: the owner's chosen direction ("think like LingQ's owner")

Content at the right level that's easy to get is the main gap; the habit side is covered.
Proposed order 1 → 2 → 3 (the owner said "continue the roadmap", so 1 was built first):

1. ~~Gemini transcribes any YouTube link~~: done (see Done).
2. ~~Lessons written from your own LingQs~~: done (see Done).
3. ~~Read-aloud for text lessons~~: done (see Done).
4. ~~Sentence mode~~: done (see Done).

All four are built. Next ideas are to be chosen with the owner after they try these on the
iPhone with a real key (the untested points are listed under Done).

## Ideas the owner rejected (don't propose again)

- Fill-in-the-blank flashcards, "listen again" reminder suggestions, export to Anki/CSV.
- A second listen with the transcript hidden, recall rounds at the end of a lesson,
  "when will you study" plans, 2-minute mode, reminders/notifications, commitment pledges.
- The owner judged earlier agent research as generic and not useful. Proposals should be
  few, concrete, specific to this app, and honest about weak evidence.
