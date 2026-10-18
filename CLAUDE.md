# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lingo Reader: a clean-room, LingQ-style language-learning PWA (import content → read with words colour-coded by status → save LingQs → spaced-repetition review → track a known-word pool). It reimplements LingQ's *method* only — never copy LingQ code, assets, content, or call its private API.

Plain HTML/CSS/vanilla ES modules. **No build step, no package.json, no dependencies** (transformers.js for Whisper is loaded from jsDelivr inside a worker). Data lives in the browser's IndexedDB, optionally synced to the user's own free Supabase project.
- **Phone app:** `mobile/` wraps the same files with Capacitor (its own package.json, used only in CI). `.github/workflows/mobile.yml` builds a signed APK and an unsigned IPA (sideloaded with Sideloadly); `android/` and `ios/` are generated there by `cap add`, not committed. Inside the app `window.Capacitor.isNativePlatform()` is true: `js/youtube.js` fetches captions through `Capacitor.Plugins.CapacitorHttp` (only those requests; the global fetch patch is off), and no service worker is registered. See docs/MOBILE.md.
- **Free services only:** the user won't pay for APIs. Never add paid services or models; their ChatGPT subscription is used only by opening chatgpt.com.

## Workflow

Commit after each finished feature or fix (one logical change per commit, imperative subject line), once the smoke test passes, then push. Windows PowerShell 5.1 mangles double quotes in native-command arguments, so write multi-line commit messages to a file and use `git commit -F <file>`. Git was installed via winget; if `git` isn't on PATH in a fresh shell, refresh it with `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.

## Commands

The machine has no Node, Python, or git — tooling is PowerShell + Edge.

- **Run:** `powershell -ExecutionPolicy Bypass -File serve.ps1` → http://localhost:8080. The user double-clicks `Start Lingo Reader.bat`.
  - Options: `-Port N` to change the port; `-Lan` to expose it on Wi-Fi (needs a one-time `netsh http add urlacl` as admin).
  - ES modules and the service worker require http(s), so `file://` won't work.
  - An already-running old server keeps the port. Restart it after changing `serve.ps1`.
- **serve.ps1 API:**
  - `/api/transcript`: YouTube captions.
  - `/api/audio?v=<id>`: a video's audio via yt-dlp (installed with winget, along with Deno and FFmpeg), cached in `%TEMP%\lingo-audio`.
  - `/api/capabilities`: what this server can do.
  - On static hosting these are absent, and the client falls back.
- **Tests:** `tests/smoke.html` is the whole suite — unit checks for `text.js`/`srs.js` plus an end-to-end run that drives the real app inside an iframe (import → reader → panel → phrase → paging → vocab → review → stats). Open `http://localhost:<port>/tests/smoke.html`; results go into `<pre id="out">` and `body[data-done="1"]` is set when finished. It writes data into that origin's IndexedDB, so run it on a different port from the one you use day-to-day. There is no per-test runner; to run a single check, temporarily comment out the others in the file.
- **Headless:** `msedge --dump-dom` does not work for this app — real-time mode snapshots before the async boot finishes, and `--virtual-time-budget` stalls IndexedDB. Drive Edge over the DevTools protocol instead: launch `msedge --headless=new --remote-debugging-port=9333`, then poll `Runtime.evaluate` until `body.dataset.done === '1'`.
- The app sets `body[data-ready="1"]` after boot and `body[data-error]` on any uncaught error or rejection — useful for automated checks.

## Architecture

**Routing / views:** `js/app.js` is a hash router (`#/library`, `#/import`, `#/lesson/<id>`, `#/review`, `#/vocab`, `#/stats`, `#/settings`). Each `js/views/*.js` exports `render*(viewEl, arg)` that rebuilds `#view` with template strings and may **return a cleanup function** (removing listeners, revoking object URLs); the router calls it before the next route. Views do not persist across navigation.

**State (`js/state.js`) is the single gateway for word changes.** `state.vocab` is an in-memory `Map(term → word record)` for the **current language only**; it is reloaded by `loadVocab()` when the language changes. Always mutate words through `setStatus` / `setStatusMany` / `saveWord` / `markSeen` / `addLessonToPool` / `removeLessonFromPool` so the map, IndexedDB, and the per-day activity counters (`bumpActivity`) stay consistent. Writing to the `words` store directly desyncs the map and the stats.

**Word status model** (constants in `js/srs.js`): `0` new (blue), `1–4` LingQ levels (yellow), `5` known, `-1` ignored. Entering 1–4 from outside that range resets `srs` and counts as a LingQ created; reaching 5 counts as a word learned. **Meanings:** `word.senses[{meaning, explain, context, contextTr, at}]` lists the meanings met (from the AI). The AI gets them and returns `same_meaning_as`; a meaning not on the list makes the word a fresh LingQ 1 (even if known or pinned), counted as a new LingQ, with Undo (`state.recordSense`).

**Automatic levels** (`js/knowledge.js`, pure functions plus a `RULES` table with cited thresholds). Statuses are computed from evidence stored on `word.ev`: a lookup (a reader tap) makes or demotes a LingQ; untapped read/listen passes count as clean encounters, at most 3 per day; flashcard review is the third input. The reader reports evidence through `state.applyEvents(events)`, which returns `[{term, from, to}]`. User choices go through `setStatus(..., {manual: true})`; a manual Known or Ignored is pinned. Each automatic change keeps a one-level undo in `ev.prev` (`state.undoAuto`). When `settings.autoStatus` is off, the old `pagingKnown` behaviour applies. Docs/PLAN.md has the full design and the remaining commits (C2–C9). Phrases are ordinary word records whose `term` is space-joined normalized tokens (`isPhrase: true`); the reader finds them by matching token sequences within a paragraph.

**The word pool:** importing a lesson calls `addLessonToPool`, which creates a status-0 record for every unseen token and accumulates `freq` and `lessons[]`. Deleting a lesson reverses this and drops untouched new words. "Text coverage" in the vocab/stats views = Σfreq(known) / Σfreq(non-ignored, non-phrase).

**Tokens are the join key everywhere.** `text.js` `tokenize()` / `normalize()` (NFC, lower-case, curly→straight apostrophe; elision split for fr/it/ca; pure numbers aren't words) produce the `term` used for lesson word counts, reader `data-n` attributes, and vocab keys. Changing tokenization changes word identity — existing lessons' `words` maps and stored vocab would no longer line up.

**Reader layouts** (`js/views/reader.js`):
- **Page mode:** text lessons, and timed lessons without media. The text is paginated.
- **Listen mode:** timed lessons with a YouTube or local player. One continuous transcript that follows the player:
  - An rAF loop on the player clock drives `activeIndex`, and `followTo()` keeps the active line about 30% down the space below the sticky player.
  - User input (wheel, touchmove, scroll keys) pauses following. The programmatic `scrollBy` never does, because only input events are listened to.
  - A tap pauses playback (`openPanel({onClose})` resumes it).
  - When playback moves on to the next line naturally (no seek) after ≥60% of a line has played, `onSegmentPassed` sends listen passes for its untapped words, once per line per visit.
  - Per-lesson `syncOffset` and `lastTime`.

**YouTube transcripts:** browsers can't read YouTube captions (CORS), so `serve.ps1` exposes `GET /api/transcript?v=<id>&lang=<code>[&track=<n>]`.
- It fetches the caption track list from YouTube's InnerTube player API (Android client) and returns the chosen track as WebVTT, as JSON `{ok, title, track, tracks, vtt}` or `{ok:false, error}`.
- This only exists when the app is served by `serve.ps1`. On static hosting (GitHub Pages) the Import view falls back to copy-paste.
- It depends on an unofficial YouTube API. If it breaks, the client ID and version in `serve.ps1` are the first thing to check.
- `parseSubtitles` handles auto-captions: cues are split on timing lines (they contain whitespace-only lines), rolling repeats are dropped, and inline `<hh:mm:ss.mmm>` word times become `marks`.

**Lessons** store parsed `segments[{text, start?}]` (`start` in seconds when timed) plus a precomputed `words{term: count}`. `parseAny` auto-detects SRT/VTT (dropping YouTube's rolling-caption duplicates), "0:12"-style pasted YouTube transcripts, or plain text; `mergeCues` joins short cues into sentence-sized chunks, keeping the first timestamp. The reader paginates at render time by `settings.pageSize` words. Turning a page forward (`finishPage`) marks untapped blue words known when `settings.pagingKnown` is on.

**Media sync:** `js/player.js` `createPlayer()` gives the YouTube player and local `<audio>`/`<video>` one interface (`getTime/isPlaying/play/pause/seek/on('state'|'ended')`).
- YouTube uses the official IFrame API, polled every 250 ms and interpolated with `performance.now()`. If the API script hasn't loaded within 5 s, it falls back to raw `postMessage`.
- `js/sync.js` (pure) turns segments into a timeline (`buildTimeline`, `activeIndex`, `charAt`).
- Tests set `window.__lingoFakePlayer` (see `makeFakePlayer` in `tests/smoke.html`) to drive playback without YouTube.

Local audio/video blobs live in the `media` store, keyed by `lessonId`, and are excluded from backups.

**One AI for translations and explanations** (`js/ai.js`, Google Gemini free tier). Users found the old mix of sentence translators, bilingual dictionaries and "meaning here" guesses noisy and often wrong, and asked to see only the meaning that fits the sentence. So there is no dictionary list of other senses anywhere.
- `geminiJson({system, user, schema})` uses the user's own key (kv `secret:gemini`, never synced or backed up) directly against `generativelanguage.googleapis.com`. Without one, a signed-in user goes through the sync server's Edge Function `supabase/functions/ai/index.ts` (the owner's `GEMINI_API_KEY` secret; it rejects the anon role). With neither, it throws `no-provider`.
- `settings.geminiModel` ('' = the newest stable `gemini-*-flash` from the live model list). `responseSchema` uses Gemini's uppercase OpenAPI types.
- `translateSentence()` (the reader's line-translate button) is a translation-only prompt cached under `s|from|to|hash32`. A word answer also writes its sentence translation there, so both always agree.
- The panel gets the exact sentence from `sentenceAt(text, charOffset)`, using the tapped span's `data-o`.
- Tests stub every AI call with `window.__lingoGemini(req) → {result, model}`, plus `__lingoASR`.

**Panel** (`js/panel.js`) has two modes: `word` (a word or a phrase of up to 10 words) and `selection` (a longer passage or several lines, also opened by the 💬 line button).
- Kept short so a lookup is quick: the meaning here (large), a one-line target-language explanation, the sentence with its translation, buttons for the lemma and the expression (`multiword_unit`), then the levels. Everything else (hint, progress, "More detail" with grammar and examples, ChatGPT/DeepSeek, Ignore, flagging) is inside a closed `details.more`. The hint fills itself with the meaning (`recordSense`).

**AI explanations** (`js/explain.js`): `explain(input, {depth, fresh})` with `input = {kind: 'word' | 'passage', term, sentence, transcript}` makes one `geminiJson` call and returns `{result: {translation, meaning_native, meaning_target, grammar, examples, examples_native, lemma, part_of_speech, multiword_unit}, source}`, cached in `dict` under `e|depth|…`.
- `quick` (every tap) asks only for the short fields (`QUICK_SCHEMA`), sends about 3k characters of transcript and sets `fast`, which turns off the model's thinking (`ai.thinkingOff`; retried without it if a model refuses). `deep` ("More detail") adds grammar and examples and sends up to 30k.
- `js/assist.js` only holds the hand-offs:
  - ChatGPT: `chatgpt.com/?temporary-chat=true&q=`, a private chat.
  - DeepSeek: the question is copied, because the site can't be prefilled.

**Importing on a phone** (`js/relay.js`): phones and static hosting have no `serve.ps1`, and YouTube refuses cross-origin requests (public Invidious/Piped mirrors were tried; they return empty captions). `relay.fetchTranscript` tries the local server, then the user's optional Supabase Edge Function `supabase/functions/transcript/index.ts` (a Deno port of `Get-Transcript`, called via `cloud.callFunction` with the user's token; its `blocked`/`network` errors count as "couldn't fetch", since YouTube often refuses cloud IPs). Failing both, a signed-in device leaves a request in the synced kv store (`job:<id>`: `{kind: 'transcript'|'asr', videoId, lang, track, status: pending→working→ready|error, vtt}`). Any device whose `api/capabilities` says `transcripts` picks it up after a sync (it syncs every 20 s while open, even in the background) and writes the VTT back. The requesting device (`from === deviceId()`) then creates the lesson itself via `createLesson` (shared with the Import view), so the words join its pool, and deletes the request. The Library lists pending requests (cancel, retry, another track, AI instead). `processRelay()` runs one pass; tests drive it directly. The manifest's `share_target` (Android "Share → Lingo Reader") arrives as `./?text=…`; `app.js` stashes it in sessionStorage for the Import view. The service worker never caches `/api/`.

**AI transcription** (`js/asr.js` + `js/asr-worker.js`): Whisper via transformers.js 3.8.1 (the self-contained `transformers.min.js` build; the `.web` build has bare imports).
- It uses WebGPU only when `requestAdapter()` succeeds, otherwise WASM in a fresh worker.
- Audio is transcribed in 2-minute blocks cut at quiet points. The result becomes a WebVTT transcript.
- `js/check.js` compares transcript lines with what the recognition heard in each line's time window (LCS alignment) and produces `lesson.flags[segIdx] = [{o, len, said, heard, manual?}]`. Users can also flag selections by hand. Editing a line (`state.updateLessonLine`) updates word counts and the pool, and drops that line's flags.

**Accounts and sync** (`js/cloud.js`, `js/views/account.js`, `docs/supabase-setup.sql`):
- **Accounts:** the account list and sessions live in localStorage. Each account has its own IndexedDB `lingo-reader-<userId>` (`db.useDatabase`); `lingo-reader` is the unsynced "This device only" profile.
- **Sync model:** last-write-wins per record on `updatedAt`. Push goes through RPC `push_records` (the server keeps the newer row); pull pages by the server's `synced_at` cursor. Deletions travel as tombstones; media goes to Storage bucket `media/<uid>/<lessonId>`.
- **Server settings:** they come from `js/config.js` or the Account screen.

**IndexedDB schema** is in `js/db.js` (`DB_VERSION` 2; stores: lessons, media, words, dict, activity, kv, tombstones).
- **Changing the schema:** bump `DB_VERSION` and migrate in `onupgradeneeded`.
- **Writes:** writes to synced stores stamp `updatedAt` and notify `db.onChange`. Sync uses `putRaw`/`delRaw`, which do neither.
- **Keys:**
  - Lesson ids are unique strings (`newLessonId()`).
  - `words`: `"<lang>|<term>"`.
  - `activity`: `"<YYYY-MM-DD>|<lang>|<deviceId>"`, summed per day in stats.
  - kv keys starting with `secret:` or `local:` stay on the device.

**Service worker (`sw.js`)** is network-first with cache fallback. **When you add or rename a JS/CSS file, update its `SHELL` list** (and bump `CACHE` for breaking changes), or offline mode will miss the file.

**Styling:** all colours are CSS custom properties in `styles.css`, with a full dark-mode override under `prefers-color-scheme`; word-status colours are `--w-new`, `--w-1` … `--w-4`, `--w-phrase`. The layout must keep working at phone width — the word panel turns into a bottom sheet below 720px.
