# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lingo Reader: a clean-room, LingQ-style language-learning PWA (import content → read with words colour-coded by status → save LingQs → spaced-repetition review → track a known-word pool). It reimplements LingQ's *method* only — never copy LingQ code, assets, content, or call its private API.

Plain HTML/CSS/vanilla ES modules. **No build step, no package.json, no dependencies.** All data lives in the browser's IndexedDB; the only network calls are dictionary lookups (Wiktionary REST + MyMemory, both CORS-enabled, no keys) and the YouTube embed.

## Workflow

Commit after each finished feature or fix (one logical change per commit, imperative subject line), once the smoke test passes, then push. Windows PowerShell 5.1 mangles double quotes in native-command arguments, so write multi-line commit messages to a file and use `git commit -F <file>`. Git was installed via winget; if `git` isn't on PATH in a fresh shell, refresh it with `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.

## Commands

The machine has no Node, Python, or git — tooling is PowerShell + Edge.

- **Run:** `powershell -ExecutionPolicy Bypass -File serve.ps1` → http://localhost:8080 (`-Port N` to change, `-Lan` to expose on Wi-Fi; needs a one-time `netsh http add urlacl` as admin). ES modules and the service worker require http(s), so `file://` won't work.
- **Tests:** `tests/smoke.html` is the whole suite — unit checks for `text.js`/`srs.js` plus an end-to-end run that drives the real app inside an iframe (import → reader → panel → phrase → paging → vocab → review → stats). Open `http://localhost:<port>/tests/smoke.html`; results go into `<pre id="out">` and `body[data-done="1"]` is set when finished. It writes data into that origin's IndexedDB, so run it on a different port from the one you use day-to-day. There is no per-test runner; to run a single check, temporarily comment out the others in the file.
- **Headless:** `msedge --dump-dom` does not work for this app — real-time mode snapshots before the async boot finishes, and `--virtual-time-budget` stalls IndexedDB. Drive Edge over the DevTools protocol instead: launch `msedge --headless=new --remote-debugging-port=9333`, then poll `Runtime.evaluate` until `body.dataset.done === '1'`.
- The app sets `body[data-ready="1"]` after boot and `body[data-error]` on any uncaught error or rejection — useful for automated checks.

## Architecture

**Routing / views:** `js/app.js` is a hash router (`#/library`, `#/import`, `#/lesson/<id>`, `#/review`, `#/vocab`, `#/stats`, `#/settings`). Each `js/views/*.js` exports `render*(viewEl, arg)` that rebuilds `#view` with template strings and may **return a cleanup function** (removing listeners, revoking object URLs); the router calls it before the next route. Views do not persist across navigation.

**State (`js/state.js`) is the single gateway for word changes.** `state.vocab` is an in-memory `Map(term → word record)` for the **current language only**; it is reloaded by `loadVocab()` when the language changes. Always mutate words through `setStatus` / `setStatusMany` / `saveWord` / `markSeen` / `addLessonToPool` / `removeLessonFromPool` so the map, IndexedDB, and the per-day activity counters (`bumpActivity`) stay consistent. Writing to the `words` store directly desyncs the map and the stats.

**Word status model** (constants in `js/srs.js`): `0` new (blue), `1–4` LingQ levels (yellow), `5` known, `-1` ignored. Entering 1–4 from outside that range resets `srs` and counts as a LingQ created; reaching 5 counts as a word learned.

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

**Lessons** store parsed `segments[{text, start?}]` (`start` in seconds when timed) plus a precomputed `words{term: count}`. `parseAny` auto-detects SRT/VTT (dropping YouTube's rolling-caption duplicates), "0:12"-style pasted YouTube transcripts, or plain text; `mergeCues` joins short cues into sentence-sized chunks, keeping the first timestamp. The reader paginates at render time by `settings.pageSize` words. Turning a page forward (`finishPage`) marks untapped blue words known when `settings.pagingKnown` is on.

**Media sync:** `js/player.js` `createPlayer()` gives the YouTube player and local `<audio>`/`<video>` one interface (`getTime/isPlaying/play/pause/seek/on('state'|'ended')`).
- YouTube uses the official IFrame API, polled every 250 ms and interpolated with `performance.now()`. If the API script hasn't loaded within 5 s, it falls back to raw `postMessage`.
- `js/sync.js` (pure) turns segments into a timeline (`buildTimeline`, `activeIndex`, `charAt`).
- Tests set `window.__lingoFakePlayer` (see `makeFakePlayer` in `tests/smoke.html`) to drive playback without YouTube.

Local audio/video blobs live in the `media` store, keyed by `lessonId`, and are excluded from backups.

**IndexedDB schema** is in `js/db.js` (`DB_VERSION` 1; stores: lessons, media, words, dict, activity, kv). Schema changes require bumping `DB_VERSION` and handling them in `onupgradeneeded`. `words` and `activity` keys are `"<lang>|<term>"` and `"<YYYY-MM-DD>|<lang>"`.

**Service worker (`sw.js`)** is network-first with cache fallback. **When you add or rename a JS/CSS file, update its `SHELL` list** (and bump `CACHE` for breaking changes), or offline mode will miss the file.

**Styling:** all colours are CSS custom properties in `styles.css`, with a full dark-mode override under `prefers-color-scheme`; word-status colours are `--w-new`, `--w-1` … `--w-4`, `--w-phrase`. The layout must keep working at phone width — the word panel turns into a bottom sheet below 720px.
