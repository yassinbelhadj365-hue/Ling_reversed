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
- Optional: the `transcript` Edge Function (cloud helper) so pasting a link works on iPhone.
- Optional, Android only: signing key secrets so APK updates keep data (docs/MOBILE.md).

## Next: the owner's chosen direction ("think like LingQ's owner")

Content at the right level that's easy to get is the main gap; the habit side is covered.
Proposed order 1 → 2 → 3 (the owner said "continue the roadmap", so 1 was built first):

1. ~~Gemini transcribes any YouTube link~~: done (see Done). Next is 2.
2. **Lessons written from your own LingQs**: "write me a story at my level about [topic]".
   Gemini writes ~150–300 words using mostly known words plus 5–10 LingQs being learned, at
   the learner's level; becomes a normal lesson, so words get met again in new contexts
   (review by reading). Read aloud with the browser's speechSynthesis.
3. **Read-aloud for text lessons** with the spoken word highlighted (speechSynthesis
   `boundary` events), so any text becomes reading-while-listening.
4. **Sentence mode** for beginners: one sentence at a time, large, replay audio, reveal the
   translation.

## Ideas the owner rejected (don't propose again)

- Fill-in-the-blank flashcards, "listen again" reminder suggestions, export to Anki/CSV.
- A second listen with the transcript hidden, recall rounds at the end of a lesson,
  "when will you study" plans, 2-minute mode, reminders/notifications, commitment pledges.
- The owner judged earlier agent research as generic and not useful. Proposals should be
  few, concrete, specific to this app, and honest about weak evidence.
