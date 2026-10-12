# Implementation plan: automatic word levels, video-driven transcript, context-aware translation

> **Status (2026-10-12):** C1–C9 are implemented and committed. Decisions taken with the user:
> - The AI layer uses Chrome's on-device Gemini Nano only, with no API key.
> - Listening needs 2 untapped passes (configurable).
> - There is an optional MyMemory email field.
> - Section 4 extras come after the user has tried the core features.
>
> Deviations from the plan: the `lookupMakesLingq` setting was dropped (tapping always makes a LingQ when automatic levels are on). The reader's session list is a chip linking to Vocab → Auto-changed rather than a list inside the panel.

Plan written by the master planning agent after reading `CLAUDE.md`, `js/state.js`, `js/srs.js`, `js/text.js`, `js/dict.js`, `js/db.js`, `js/panel.js`, `js/app.js`, `js/views/{reader,vocab,review,import,settings,library,stats}.js`, `sw.js`, `styles.css` and `tests/smoke.html`. No files were modified.

**Root causes found in the current code**
- **Problem 1:** the only automatic path is all-or-nothing. `finishPage()` in `reader.js` marks every untapped blue word as known when `settings.pagingKnown` is on. Every other level change is a manual click in `panel.js` `changeStatus()`. Nothing learns from what you actually do.
- **Problem 2:** `highlightTime()` in `reader.js` scans the segments in order and toggles `p.playing`. It never scrolls, and never turns the page when playback crosses a page boundary. It also depends on YouTube `infoDelivery` messages, which are not in the official reference (tech report).
- **Problem 3:** `dict.js` `myMemory(term)` translates the bare word, and Wiktionary returns general glosses. The sentence is never sent to any translator. `text.js` `sentenceAround()` also finds the first sentence that contains the term as a substring, not the occurrence you tapped. For example, "la" matches inside "las". So even the saved context can be wrong.

---

## 1. Key insights

| # | Finding | Source and reliability | What it means for the design |
|---|---|---|---|
| 1 | Untapped words are most of what an immersion learner "knows". Kaufmann: "most of my so-called known words are words that showed up in our lessons that I didn't save." Knowing a word means recognising it in context. Recall is not required. | Kaufmann (fetched primary page; he has a commercial interest) | A pass through text without a lookup is valid evidence that a new word is known. Recognition evidence alone can promote a word. Review is never required. |
| 2 | LingQ's bulk "paging/finishing moves to known" is a known footgun. Users complain that lesson completion marks words they never saw or skipped. | LingQ report (forum threads; mixed reports) | Promote only from per-segment evidence the user actually passed through. Never bulk-promote on lesson completion. Every automatic change can be undone. |
| 3 | Reliable incidental learning takes several encounters. Eye-tracking shows words read like known ones after about 8 encounters (Pellicer-Sánchez 2015). About 10 encounters is reported for 2010 (secondary source). Single encounters give small gains (Webb). | Science report (the 10 figure is **unverified**; the 2015 figure is better sourced) | A looked-up word moves 1→Known after about 10 clean encounters (needs 2+2+3+3). A "pace" setting scales this. It is not hard-coded to one study. |
| 4 | Spacing beats massed exposure. The best gap grows with the retention interval (Cepeda 2006, a meta-analysis of 839 assessments). | Science report (well established) | At most 3 encounters per word per day count. Reaching Known therefore takes at least 4 different days, which builds spacing into exposure-only learning. |
| 5 | Migaku calls a word known once its review interval reaches 21 days or more. | LingQ report (Migaku blog) | An optional review signal: a Good/Easy grade that schedules 21+ days promotes the word to Known. This gives a second path to Known for people who use review. |
| 6 | Listening tolerates more unknown words than reading. Listening needs about 95% coverage (van Zeeland & Schmitt, **contested**) and reading 98% (Hu & Nation 2000; Laufer & Ravenhorst-Kalovski 2010). | Science report and tech report | Not tapping a word while a video runs is *weaker* evidence than not tapping it while reading at your own pace. A listening pass counts half as much as a reading pass. The coverage thresholds also drive lesson difficulty badges (section 4). |
| 7 | Captioned video improves listening and vocabulary (meta-analysis, g≈.87, secondary source). Captions (same language) may beat L1 subtitles for word learning, though the evidence is mixed. | Science report | A synchronised same-language transcript is the core view. Line translations are hidden by default and shown on tap. Kaufmann also argues against translating everything. |
| 8 | Language Reactor's model works: the caption timestamps drive the active line. LingQ does not document video-driven scrolling, and its sync drifts. | LingQ report | Caption start times are the clock. Add a per-lesson sync offset to correct drift. Never use text-length heuristics as the clock. |
| 9 | Official YouTube IFrame API: `getCurrentTime()`, `onStateChange` (1 playing, 2 paused, 3 buffering, 0 ended), `getPlaybackRate()`. `infoDelivery` is not documented. | Tech report (official reference) | Move to `YT.Player` attached to the existing iframe and keep the current postMessage path as a fallback. Poll and interpolate with `performance.now()`. |
| 10 | Users have to be able to read earlier text without being dragged back. Pause follow on user scroll and offer a "Follow video" button. | Tech report (design, not sourced, but standard) | A follow state machine (section 3, C4). |
| 11 | Glosses in context beat out-of-context dictionary access, mainly because learners avoid lookups. Retention fades without re-exposure. | Science report (Hulstijn 1996, Roby 1999; older studies) | One tap shows the sentence, its translation, and the meaning that fits *this* sentence first. Keep the context sentence and its translation for flashcards. |
| 12 | LingQ 5.0 shows the context-based meaning first and general meanings after, and says seeing both helps. | LingQ and Kaufmann reports (official press release) | Panel order: meaning here → grammar/form → expressions → general dictionary. |
| 13 | DeepL blocks browser calls (CORS). Chrome Translator API is desktop only. MyMemory is free and keyless but quota-limited (about 5k chars/day anonymous, about 50k with an email; figures conflict). | Tech report (DeepL and Chrome are official docs; MyMemory numbers **unverified**) | Free chain: Chrome Translator → MyMemory → external links that pass the whole sentence. Cache everything. DeepL and Lingva are rejected. |
| 14 | Anthropic accepts direct browser calls with `anthropic-dangerous-direct-browser-access: true`. That is only acceptable with the user's own key. | Tech report (Willison 2024). The tech report's Haiku 4.5 pricing is out of date: the current Haiku is `claude-haiku-5-5` at $0.10 / $0.50 per M tokens (Anthropic model table, cached 2026-10-06). | An optional bring-your-own-key AI explainer. About 500 input and 200 output tokens costs about $0.00015 per lookup, so roughly $0.15 per 1,000 lookups. |

**Where the reports are weak, and the conservative choice made**
- The science report's numbers (10 encounters, g≈.87, Webb 2023) are partly secondhand. Thresholds therefore live in one constant object, `RULES` in `js/knowledge.js`, with comments citing the source, and the user can scale them with a pace setting.
- The tech report's IRT/BKT and placement-test design is "not sourced". It also needs per-language frequency lists, which the app does not have, and its BKT parameters cannot be fitted without data. BKT is rejected in favour of a transparent counter model. The placement test is deferred to section 4 and an open question.
- The science report says "promote only after successful recall". Kaufmann says recognition is knowing. Resolution: Known is reached by spaced exposure (about 10 encounters over 4 or more days) **or** by review evidence. Recall is never required.
- Kaufmann found nothing on automatic detection or video sync. Those parts of the design rest on Migaku and Language Reactor (LingQ report) and the tech report.

---

## 2. Design decisions

### 2.1 Request 1: automatic word levels with manual override

**Chosen approach: an evidence-counter model.** Pure functions in a new `js/knowledge.js`. Status is *computed* from recorded evidence. The existing statuses (0, 1–4, 5, −1) and colours stay the same, so the reader, review, stats and backups keep working.

Evidence events:
- **lookup**: tapping a word or phrase in the reader. Opening a word from the vocab list or review does not count.
- **read pass**: a page turned in page mode, for words on that page that were not tapped.
- **listen pass**: a segment played through at normal pace in follow mode, for words in it that were not tapped.
- **review grade**.
- **manual set**.

Rules (constants in `RULES`):
- **New word, never looked up** (detecting what you already know): `pre += 2` per read pass and `+= 1` per listen pass, counted once per segment. When `pre ≥ 2` the word becomes Known. A read pass gives Known at once, as LingQ does. Listening needs two separate untapped passes (insight 6).
- **Lookup:** New → 1. Auto-Known → 1. LingQ L → max(1, L−1). The clean-encounter counter resets. A manually Known word is pinned: no status change, but the panel offers "Make it a LingQ".
- **Clean encounters after a lookup:** each step needs `need = [2,2,3,3] × pace` encounters (1→2→3→4→5), at most 3 counted per day (insight 4). The level is `max(exposureLevel, reviewLevel)`.
- **Review:** the existing `grade()` keeps setting the review level. A Good/Easy grade that schedules 21+ days promotes to Known (insight 5).
- **Manual:**
  - Known or Ignored is pinned (`src:'manual'`).
  - Manual 1–4 resets the base to that level. Evidence keeps moving it unless "Let the app adjust levels I set" is off.
  - Reset to New clears the evidence.
- **Undo:** each automatic change stores `ev.prev` (one level of undo). The reader keeps a session list of changes. Vocab gets an "Auto-changed" filter with a Revert action.

Rejected alternatives:
- Probabilistic BKT or IRT: needs data to fit, and is opaque to the user.
- Frequency-prior placement test now: no frequency data per language, and licensing (CC BY-SA) and hosting need a decision. Deferred.
- Keep LingQ paging-to-known as is: it is the user's complaint and a known footgun.
- Auto-promote on lesson completion: insight 2.
- Lookups do not create LingQs: then there would be no evidence to track acquisition.

**Data model.** No IndexedDB version bump: there are no new stores or indexes, and values are schemaless. New fields are added lazily.
- `word.ev = { pre, look, lookAt, base, since, rev, day, today, src, autoAt, prev }`
  - `src`: `'auto'`, `'manual'`, or undefined for legacy records, treated as auto.
  - `prev`: `{status, ev}` snapshot for undo.
- `word.contextTr`: the translation of the context sentence. Added in C7.
- No migration pass. A helper `evOf(w)` returns defaults and treats legacy statuses as `base = status`.
- Backups carry the new fields automatically.

New settings (`DEFAULTS` in `state.js`):
- `autoStatus: true`. When off, the app behaves exactly as today, including `pagingKnown`.
- `lookupMakesLingq: true`
- `autoPace: 'normal'` (`cautious` ×1.5, `fast` ×0.7)
- `autoAdjustManual: true`

### 2.2 Request 2: the video drives the text

**Chosen approach:**
- A **player adapter** `js/player.js`:
  - YouTube: official `YT.Player` attached to the existing `enablejsapi=1` iframe, with the current postMessage/`infoDelivery` code kept as a fallback if the API script does not load within 5 s.
  - `<audio>`/`<video>` for local media.
  - A test hook for the smoke test.
- A **pure timeline module** `js/sync.js`: end-time inference and binary search.
- A **listening layout** for timed lessons that have media:
  - Continuous transcript (no paging).
  - Sticky player.
  - The active line is kept about 30% down the space below the player.
  - Follow pauses on user scroll, with a "Follow video" button.
  - Seeks snap without animation.
  - Optional dimming of other lines.
  - Optional word-by-word progress inside the line.
  - Video pauses on lookup and resumes when the panel closes.
  - Line controls: previous, replay, play/pause, next.
  - Per-lesson sync offset.
  - Resume from the last position.

Rejected alternatives:
- Auto-turning pages: jumpy, and it breaks scrolling back across a page boundary.
- Keep only `infoDelivery`: undocumented, and it gives no player state or rate.
- A separate scroll container for the transcript: window scrolling is more reliable on iOS, and the sticky player already gives a fixed viewport.
- Hiding the video for audio-only use: the YouTube player has to stay visible, with a minimum size of 200×200.

**Data model:**
- `segment.end?` (seconds): from SRT/VTT, now kept by `parseSubtitles`.
- `segment.marks?` = `[[charOffset, start], …]`: kept by `mergeCues` so merged lines still know where each original cue started. Older lessons fall back to interpolating across the whole line.
- `lesson.syncOffset` (seconds, default 0) and `lesson.lastTime`.
- Settings: `follow: true`, `pauseOnLookup: true`, `resumeAfterLookup: true`, `dimOtherLines: true`, `wordProgress: true`.

### 2.3 Request 3: translations that use context

**Chosen approach: layered, free by default.** All of it is in a new `js/translate.js`, cached in the existing `dict` store under the key prefixes `s|` (sentence), `x|` (AI explanation) and `w|` (Wiktionary n-gram).

0. **Exact context:** a new `sentenceAt(text, charOffset)` uses the tapped span's position. Captions without punctuation (YouTube auto-captions) fall back to the whole segment plus the previous and next segments.
1. **Sentence translation:** Chrome Translator (`availability()==='available'`) → MyMemory, chunked at about 450 bytes, with the optional `de=` email → external links that pass the *whole sentence* to Google Translate, DeepL and Reverso. The panel shows it under "In this sentence".
2. **Meaning in this sentence (free heuristic):** rank the dictionary candidates by whether they appear in the sentence translation. Matching candidates get a "fits this sentence" badge and are highlighted in the translation. LingQ shows its contextual meaning first in the same way.
3. **Grammar and structure (free):**
   - Wiktionary "form of" parsing gives the lemma and an inflection label, for example "1st-person plural preterite of *hablar*", plus the lemma's meanings.
   - Wiktionary n-gram lookup (2–3-word windows around the tapped token) finds expressions such as *a pesar de* or *darse cuenta*, with a "Save as phrase" button.
4. **Optional AI explanation:** bring-your-own Anthropic key with `claude-haiku-5-5`, or Chrome's built-in Prompt API on capable desktops (experimental, feature-detected). Output is JSON: gloss in context, lemma, part of speech, grammar note, sentence translation, and multi-word unit if any.

Line translations in the reader are tap-to-reveal per line, with a per-lesson toggle that is off by default (insight 7, Kaufmann).

Rejected alternatives:
- DeepL: blocked by CORS without a proxy.
- Lingva or unofficial Google endpoints: scraping, terms-of-service problems, no uptime guarantees.
- A shipped developer key: it would be exposed and abused.
- Translate every line by default: costs quota and runs against the evidence and the method.

**Data model:**
- `word.contextTr`
- The `context` field now stores the exact sentence.
- Settings: `translateEmail: ''`, `showLineTranslations: false` (per lesson: `lesson.showTr`), `aiProvider: 'none'|'anthropic'|'chrome'`, `aiAuto: true`.
- The API key is stored under the `kv` key `secret:anthropic`. **`exportAll()` must filter out `secret:*`** so keys never end up in backup files.

---

## 3. Implementation plan (ordered commits)

General rules for every commit:
- Add new JS files to `SHELL` in `sw.js`, and bump `CACHE` to `lingo-reader-v2` in C1.
- Update the relevant `CLAUDE.md` sections in the same commit.
- Run `tests/smoke.html` on a separate port before committing.
- All new pure logic is unit-tested in the top block of the smoke test. Network-dependent code is behind injectable providers.

### C1. Evidence model, automatic levels from lookups and reading

**Goal:** tapping a word makes it a LingQ, and turning a page counts as a read pass. Status levels change by themselves.

**Files**
- **New `js/knowledge.js`** (pure, no DOM, no db):
  ```js
  export const RULES = {
    readPass: 2, listenPass: 1, newToKnown: 2,          // insight 6
    need: [2, 2, 3, 3],                                  // 1→2→3→4→Known, ≈10 total (insight 3)
    maxPerDay: 3,                                        // spacing (insight 4)
    reviewKnownDays: 21,                                 // Migaku rule (insight 5)
    pace: { cautious: 1.5, normal: 1, fast: 0.7 },
  };
  export function evOf(w)                       // defaults; legacy: base = status in 1..4 ? status : 0
  export function levelFrom(base, since, pace)  // walk need[] from base
  export function computeStatus(w, pace)        // see below
  export function onLookup(w, opts)  -> {status, ev}
  export function onPass(w, kind /*'read'|'listen'*/, day, opts) -> {status, ev} | null
  export function onManual(w, status) -> ev
  export function onReview(w, g, srs) -> {status, ev}
  export function undoPatch(w) -> {status, ev} | null
  ```
  `computeStatus` (for words that are not pinned):
  ```
  if ev.src==='manual' && status in {KNOWN, IGNORED}       → pinned, unchanged
  if ev.src==='manual' && !settings.autoAdjustManual       → pinned
  if ev.look===0 && ev.base===0: return ev.pre >= newToKnown ? KNOWN : NEW
  lvl = max(levelFrom(ev.base, ev.since, pace), ev.rev)    // capped at 5
  return lvl >= 5 ? KNOWN : lvl
  ```
  `onPass`, for a word with lookup history or a base level:
  ```
  if (ev.day !== day) { ev.day = day; ev.today = 0 }
  if (ev.today >= maxPerDay) return null
  ev.today++; ev.since++
  ```
  For a never-looked-up new word, `ev.pre += readPass | listenPass`.

  `onLookup`: `ev.look++; ev.lookAt = now; base = status ∈ {NEW, KNOWN} ? 1 : max(1, status - 1); since = 0; rev = 0; src = 'auto'`. A manually pinned Known word only gets `look++`.

  Every transition that changes status sets `ev.prev = {status: old, ev: snapshotWithoutPrev}` and `ev.autoAt = now`.
- **`js/state.js`:**
  - Add `export async function applyEvents(events)`, where `events = [{term, type, kind?, day?}]`. It batches the work: per term, call the knowledge function, then `applyStatus(w, newStatus)` (keeps activity deltas, the srs reset and `lingqAt`), set `w.ev`, then one `db.putMany` and one `bumpActivity(total)`. Return `[{term, from, to}]` for the changes only.
  - `setStatus()` calls `onManual` when invoked from the panel. Add a `{manual: true}` option so review and other internal callers don't pin.
  - Add `undoAuto(term)`.
  - Add the settings defaults from section 2.1.
- **`js/views/reader.js`:**
  - Word click handler (non-phrase): `clicked.add`, then, if `autoStatus && lookupMakesLingq`, `await applyEvents([{term, type:'lookup'}])` before `open()`, then `refresh()`.
  - Phrase selection: a lookup for the phrase term only. Its constituent words are excluded from the pass (they are already in `clicked`).
  - `finishPage()`: when `autoStatus` is on, replace the `pagingKnown` block with `applyEvents(unique - clicked → {type:'pass', kind:'read'})`. Keep `markSeen` and the `read` activity. The toast reads "N words moved to known · Undo", which reverts the batch.
- **`js/panel.js`:**
  - `openPanel` takes `lookup: true|false`.
  - Under the status label, add "Auto · from your reading" or "Set by you". For LingQs, add a progress line, "4 / 10 encounters toward known".
  - If `ev.prev` was set in the last 10 minutes, show an "Undo" button.
  - `changeStatus` passes `{manual: true}`.
  - The 1–4/K/X keys still work, so manual override is unchanged.
- **`js/views/review.js` `answer()`:** after `grade()`, apply `onReview` (21-day rule), then `saveWord`.
- **`js/views/settings.js`:** an "Automatic word levels" card with `autoStatus`, `lookupMakesLingq`, `autoPace` (segmented control) and `autoAdjustManual`. The `pagingKnown` checkbox shows only when `autoStatus` is off. Explanatory text explains the rules in plain words.
- **Reader help text:** "Tap words you don't know. Words you pass without tapping become known; words you tapped level up as you meet them again."

**UI:** desktop and phone share the same panel markup. The status buttons stay, and the new info line goes above them.

**Smoke tests**
- **Unit tests** on `knowledge.js`:
  - New + read pass → Known.
  - New + 1 listen pass → New; a second listen pass → Known.
  - Lookup → 1; 2 clean → 2; 10 clean at 3 per day spread over 4 simulated days → Known; more than 3 on one day are ignored.
  - Lookup on level 3 → 2.
  - Manual Known plus a lookup → stays Known.
  - Manual 2 with `autoAdjustManual=false` → stays 2.
  - `undoPatch` restores the previous status.
  - Review Good with a 21-day interval → Known.
- **E2E (existing flow):**
  - After clicking `comida`, its spans are `st-1` before level 2 is chosen.
  - The final tile counts stay 13 known and 2 LingQs. The current test should still pass unchanged because a read pass makes untapped words Known.
  - New check: open the panel for a non-pinned word and see "Auto".

**Risks**
- Accidental taps create LingQs. Mitigated by the panel's Undo button and level 1 being harmless.
- Legacy Known words get demoted when looked up. That is intended, and Undo covers mistakes.
- Activity `lingqs` counts will now rise with lookups. The daily goal semantics shift accordingly (see section 4, item 3).

### C2. Visibility and reversal of automatic changes

**Goal:** the user can see and revert what the app did.
- **`js/views/vocab.js`:**
  - A new filter `['auto', 'Auto-changed', w => w.ev?.autoAt > now - 7 days]`, sorted by `autoAt` descending.
  - A new column "Encounters", showing `ev.since` and the "known" target.
  - A "Revert" button per row calls `undoAuto`.
  - The "Mark all shown as known" bulk action marks words as manual.
- **`js/views/reader.js`:**
  - A session chip in the reader head: "+12 known · 3 ↑". Clicking it opens a small list (in the panel element, as a list mode) with per-word Undo and "Undo all from this session".
  - Changes are collected from `applyEvents` return values.

**Smoke tests:** after the lesson, the vocab "Auto-changed" filter shows 13 rows. Revert one → Known tile reads 12, then mark it known again so the later checks are unaffected.

**Risk:** the list grows large. The session list is capped at 500 entries.

### C3. Player adapter and timeline (no visible layout change yet)

**Goal:** a reliable clock from the official API. Removes the reader's dependence on `infoDelivery`.
- **New `js/sync.js`** (pure):
  ```js
  export function buildTimeline(segments, {offset = 0, maxLine = 12} = {}) // [{i,start,end}] sorted; end = min(seg.end ?? ∞, next.start, start + max(maxLine, 0.5 s/word))
  export function activeIndex(tl, t) // binary search last start <= t; returns {idx, inGap: t > tl[idx].end}
  export function charAt(seg, tl, t) // char offset spoken so far: piecewise-linear over seg.marks (or [[0,start]]) up to tl.end
  ```
- **New `js/player.js`:**
  - `export async function createPlayer(box, {youtubeId, blob, type})` returns `{kind, getTime(), isPlaying(), getRate(), play(), pause(), seek(t), on(evt, fn), destroy()}`, with events `state`, `seek`, `ended`, `rate`.
  - **YouTube:** insert the same iframe as now (`enablejsapi=1&playsinline=1&rel=0&origin=…`). Load `https://www.youtube.com/iframe_api` once through a module-level promise that chains any existing `window.onYouTubeIframeAPIReady`. Call `new YT.Player(iframeEl, {events: {onReady, onStateChange, onPlaybackRateChange}})`.
  - **Time:** poll `getCurrentTime()` every 250 ms while playing. Keep `{t, at: performance.now()}`. `getTime() = t + (now - at)/1000 × rate` while playing. The ~0.4 s lag after seeks is unverified; tolerance comes from the seek detection in C4.
  - **Fallback:** if `YT` has not loaded after 5 s, use the current postMessage code moved here. Parse `info.currentTime`, `info.playerState` and `info.playbackRate` when present.
  - **Media element:** `currentTime`, plus `play`/`pause`/`seeked`/`ratechange`/`ended` events.
  - **Test hook:** `if (window.__lingoFakePlayer) return window.__lingoFakePlayer(box)`.
- **`reader.js`:** replace the media block and `highlightTime` with `createPlayer` plus `activeIndex`, keeping the current behaviour (highlight only). Cleanup calls `player.destroy()`.
- **`sw.js`:** add `js/sync.js` and `js/player.js` to `SHELL`. The YouTube script is cross-origin, so the service worker already ignores it.

**Smoke tests**
- **Unit:** `buildTimeline` of [0, 4, 9] with no ends gives ends [4, 9, 9+cap]. `activeIndex` at 4.0 → 1, at −1 → −1, in a gap → `inGap`. `charAt` interpolation at the middle of a mark.
- **E2E:** set `W().__lingoFakePlayer` before opening the lesson. The fake has `t`, `playing`, and an emit function. Set `t = 5` with state playing and check that `p.cue.playing[data-i]` points at the segment starting at 0:04. The existing iframe `src` check moves to a no-fake run, or the fake inserts an iframe with the same `src`.

**Risk:** attaching `YT.Player` to an existing iframe requires `enablejsapi=1`, which is already in the `src`. Verify that `origin` matches on localhost and on LAN.

### C4. Listening layout: the video drives the text (core of request 2)

**Goal:** in timed lessons with media, the transcript follows the video automatically.

**Files**
- **`reader.js`:**
  - `const listen = timed && (lesson.youtubeId || media?.blob)`.
  - When `listen` is true: `view.classList.add('listen')`. Render **all** segments in one pass (no `paginate`). Replace the pager with a follow bar:
    `[⏮ line] [⟲ replay line] [⏯] [⏭ line] [Follow ✓] [sync −0.25 / +0.25] [Finish lesson]`
  - The page mode is unchanged for text lessons.
  - **Follow loop** (rAF while playing; one step on `state`/`seek` events; stopped when paused or hidden):
    ```
    t = player.getTime() + lesson.syncOffset
    jump = lastT != null && (t - lastT < -0.3 || t - lastT > 1.5)   // seek or buffering jump
    if (!jump && playing) segPlayed += t - lastT
    {idx, inGap} = activeIndex(tl, t)
    if idx !== cur:
       if (!jump && cur >= 0 && idx === cur + 1 && segPlayed >= 0.6 * (tl[cur].end - tl[cur].start)) onSegmentPassed(cur)   // used in C5
       setActive(idx)                          // .playing on the new line, .played on earlier lines
       followTo(idx, {instant: jump || |idx - cur| > 1})
       cur = idx; segPlayed = 0
    if (settings.wordProgress) throttled(100ms) markSpoken(idx, charAt(...))  // implemented in C6
    lastT = t
    ```
  - **`followTo(idx)`:**
    ```
    if (!state.follow || hold) return
    anchor = mediaBox.getBoundingClientRect().bottom          // sticky player bottom
    avail  = innerHeight - anchor - tabbarH - (phone && panel open ? panelH : 0)
    delta  = p.getBoundingClientRect().top - (anchor + 0.3 * avail)
    if (|delta| > 8) scrollBy({top: delta, behavior: instant || reducedMotion ? 'auto' : 'smooth'})
    ```
    Also re-run it when the active line's bottom drops below `anchor + avail` during long lines.
  - **Hold state machine:** `FOLLOWING` → (`wheel` | `touchmove` | `keydown` PgUp/PgDn/Arrows | scrollbar `pointerdown`) → `HELD`. A floating "⤓ Follow video" button appears. `HELD` → `FOLLOWING` on: button tap; cue-time or line-control tap; a seek in the player; or a line change after 6 s with no user scroll. Programmatic scrolls never trigger `HELD` because only input events are listened to, not `scroll`.
  - **Lookup during playback:** if `pauseOnLookup` is on and the player is playing, call `player.pause()` and remember that the app paused it. On `closePanel`, resume if `resumeAfterLookup` is on. Add an `onClose` callback to `openPanel` in `panel.js`.
  - **Keyboard** (only when the panel is closed and focus is not in an input): Space play/pause, ←/→ previous/next line (`seek(tl[idx ± 1].start - offset)`), R replays the line. These do not clash with the panel keys (1–4, K, X, Esc).
  - **Sync offset:** ±0.25 s buttons change `lesson.syncOffset` (debounced `db.put`) and rebuild the timeline, for caption drift.
  - **Resume:** save `lesson.lastTime` every 10 s and on cleanup. On ready, call `seek(lastTime - 2)` paused, with no autoplay.
  - **Finish:** the `ended` event or the "Finish lesson" button shows the existing completion card. Unlike page mode, it does not bulk-promote anything.
- **`styles.css`:**
  - `.listen .media-box { position: sticky; top: var(--topbar-h); z-index: 15; background: var(--bg); padding-bottom: 6px }`. Define `--topbar-h: 56px` on `:root`.
  - `.listen .cue { transition: opacity .2s } .listen.dim .cue:not(.playing) { opacity: .5 } .cue.played { … }`
  - `.follow-bar` is sticky at the bottom, above the tab bar.
  - **Desktop ≥1100px:** `.listen main` gets a two-column grid with the player sticky on the left (about 45%) and the transcript on the right. Use a `body.listen-wide` class set by the reader, widening the max-width to 1200px.
  - **Phone ≤720px:** the player is full-width 16:9 (about 225px at 400px wide, which keeps YouTube's 200px minimum). The bottom-sheet panel uses `max-height: 45vh` in listen mode so the current line stays visible between the player and the sheet.
  - **Landscape with max-height 500px:** the player is not sticky.
- **`settings.js`:** add `follow`, `pauseOnLookup`, `resumeAfterLookup` and `dimOtherLines`.

**Smoke tests** (fake player)
- `t: 0 → 5` playing → line 1 is `.playing` and its top is inside the band between the player bottom and 60% of `innerHeight`.
- Dispatch `wheel` → `.follow-btn` is visible. Advance `t` → no scroll happens (record `scrollY`). Click `.follow-btn` → scrolls to the active line.
- `t = 9.5` (jump) → line 2 is active immediately.
- Click a word while playing → `fake.paused === true`. Close the panel → resumed.
- Press `→` → `fake.seekCalls` ends with 9 (the next line's start).
- Sync +0.25 → `lesson.syncOffset === 0.25` (read through test-page `db.get`).

**Risks**
- iOS: smooth `scrollBy` with a sticky element. Fall back to `behavior: 'auto'` if it misbehaves; test on a phone.
- rAF loops on battery: stop when not playing or when `document.hidden`.
- Very long transcripts (more than 1,000 segments, more than 10k spans): `refresh()` and `markPhrases()` over all spans. Measure; if it takes more than 16 ms, limit `markPhrases` to paragraphs near the active line.

### C5. Listening counts as evidence (connects requests 1 and 2)
- **`reader.js` `onSegmentPassed(i)`:**
  - Skip if the segment was already counted in this view session (`Set`), or if `document.visibilityState !== 'visible'`.
  - Otherwise: terms = the segment's tokens with `n`, minus `clickedBySeg[i]`, minus ignored terms. Call `applyEvents(terms.map(term => ({term, type: 'pass', kind: 'listen'})))`, then `bumpActivity({read: tokensInSeg})` and `markSeen`.
- Lookups record `clickedBySeg[segIdx]`, so a word tapped in segment 7 is not counted as clean there. It *is* counted in later segments, which is a genuine re-encounter.
- When follow is off and the user scrolls freely, no listen passes are counted unless the segment actually played. The play-time rule handles this.

**Smoke tests:** fake player plays 0 → 4.1 → 8 naturally (several frames). DB check: the untapped words of segment 0 have `ev.pre === 1` and status 0. Replay the same video in a new view session (re-render) → status 5. A word tapped in segment 0 has `ev.look === 1`.

**Risk:** passive viewing inflates Known counts. That is mitigated by the 2-pass rule, the per-day cap for LingQs, and Undo. Open question 3 covers it.

### C6. Word-by-word progress inside a line
- **`text.js`:**
  - `parseSubtitles` keeps `end` (parse the right side of `-->`).
  - `mergeCues` builds `marks` (`[[charOffset, start]]`) and keeps the last `end`.
  - `parseTimestampedText` keeps `marks` when merging.
  - Token text is unchanged, so word identity is unaffected.
- **`reader.js`:** render `data-o` (character offset) on `.w` spans. `markSpoken(idx, c)` toggles the `spoken` class on that line's spans with `data-o < c`.
- **`styles.css`:** `.w.spoken { text-decoration: underline 2px var(--accent); }`. This sits alongside status colours without colliding with phrase underlines; use `box-shadow: inset 0 -2px` if it does.

**Smoke tests:**
- Unit: `mergeCues` on 3 cues → 1 segment with `marks.length === 3` and correct offsets. SRT `end` is parsed.
- E2E: at `t` = middle of line 0, at least one span in line 0 is `.spoken` and the last is not.

**Risk:** linear interpolation is only an approximation, so the UI shouldn't present it as precise. Old lessons don't have `marks` and fall back to one mark per line.

### C7. Exact context and sentence translation (core of request 3)
- **`text.js`:**
  - New `sentenceAt(text, charOffset)` returns `{sentence, start, end}`. It splits on `[.!?…。？！]`, and if there is no punctuation within 240 characters, returns the whole segment.
  - New `hash32(s)` (FNV-1a) for cache keys.
  - `sentenceAround` stays for review and other callers.
- **`reader.js` `open()`:** compute the offset from the span's `data-o` and pass `{context: sentence, prev: prevSegText, next: nextSegText, wordIndex}` to `openPanel`. This fixes the wrong-occurrence bug.
- **New `js/translate.js`:**
  ```js
  export async function translateSentence(text, from, to)
    // key `s|${from}|${to}|${hash32(norm(text))}`, cache 60 days in `dict`
    // 1. Chrome: if ('Translator' in self) and (await Translator.availability({sourceLanguage: from, targetLanguage: to})) === 'available'
    //    → (cached instance per pair).translate(text)
    // 2. MyMemory: chunkForMyMemory(text, 450 bytes, split at punctuation/space); &de=email when set;
    //    on a 'MYMEMORY WARNING' or 429 response → {error: 'quota'}
    //    returns {text, source: 'On-device' | 'MyMemory'} | {error}
  export function chunkForMyMemory(text, maxBytes)
  export function setTestProviders(p)   // smoke-test injection
  ```
  "downloadable" models are not created automatically, because the download needs a user gesture. Settings gets a "Download on-device translator" button for that.
- **`panel.js` render order:**
  1. Word, status and the auto line.
  2. **"In this sentence"**: the source sentence with the word in `<mark>`, the translation (or "Translating…"), a source badge, and links "Open sentence in Google · DeepL · Reverso" (extend `externalLinks` with a `sentence` argument).
  3. Hint field.
  4. Dictionary (existing).
  - Saving a hint stores `w.contextTr`.
- **Reader line translation:** a small 🌐 button per cue, after `.cue-time`. Tapping inserts or toggles `<div class="tr">` under the line. A per-lesson "Translations" toggle in the follow bar shows the current line's translation only. Off by default.
- **`review.js`:** after reveal, show `w.contextTr` under the context line.
- **`settings.js`:** "Translation" card:
  - `translateEmail` (optional; explain that it raises MyMemory's daily limit and is sent to MyMemory).
  - Chrome on-device status: available / downloadable (button) / unsupported.
- **`db.js`:** no schema change.

**Smoke tests**
- **Unit:** `sentenceAt` picks the second sentence for an offset inside it. "la" does not match "las" (offset-based). No-punctuation text → whole text. `chunkForMyMemory` respects the byte limit and does not split words. `hash32` is stable.
- **E2E:** `setTestProviders({sentence: async t => ({text: '[EN] ' + t, source: 'Test'})})` through a hook on `window.__lingoTranslate` read by `translate.js`. Click `comida` → `.ctx-sentence mark` is "comida" and the `.ctx-tr` text starts with "[EN] Hoy vamos". The 🌐 button on a line → `.tr` appears.

**Risks**
- The MyMemory quota (unverified figures). Mitigated by the cache, on-demand use, and the external links.
- The Chrome Translator API shape may change: wrap it in try/catch and feature-detect.

### C8. Meaning-in-context ranking, word forms and expressions
- **`translate.js` `rankByContext(defs, sentenceTr, native)`:**
  ```
  trTokens = tokenize(sentenceTr, native).map(n)
  for each candidate c (MyMemory translations always; Wiktionary glosses only when native === 'en'):
     words = tokens(c.text) with length >= 3
     score = max over words: exact in trTokens → 2; shared prefix of >= max(4, len-2) chars → 1; else 0
  stable sort by score desc; candidates with score > 0 get c.fits = true and c.span = the matching tr token
  ```
  The panel shows the top "fits this sentence" candidate as **Meaning here**, with a one-tap "Use as hint", and highlights the matching words in the translation. LingQ shows its context meaning first in the same way.
- **`dict.js` `wiktionary()`:** before `stripHtml`, check whether the definition HTML matches `/\b(form|plural|participle|person|tense|indicative|subjunctive|imperative|gerund|feminine|masculine|inflection|conjugation)\b[^<]*\bof\b/i` and contains `<a … title="X">`. If so, emit `{source: 'Wiktionary', pos, text, formOf: X}`. `lookup()` then fetches the lemma's definitions (one more request, cached) and returns `{…, lemma: {term: X, defs}}`.
  - **Verify the REST response's link markup during implementation.** If it doesn't match, the feature degrades to "no form info".
  - The panel shows a **Form** line: "*hablamos* — first-person plural present indicative of **hablar**: to speak", with a button that opens the lemma in the panel.
- **Expressions:**
  - `translate.js` `findExpressions(tokens, i, lang)`: windows of 2–3 tokens containing the tapped token within the sentence, longest first, at most 5 candidates.
  - Wiktionary definition lookup on the surface strings, cached as `w|lang|surface` (negative results too, for 30 days).
  - Matches show as **Expression: *a pesar de* — in spite of** with a "Save as phrase" button. That calls `setStatus(normTokens.join(' '), 1, {hint, context, manual: true})`, so existing phrase underlining and review work unchanged.

**Smoke tests:**
- Unit `rankByContext`: candidates ["meal", "food"] with translation "Today we will talk about food." → `food.fits` is true and it ranks first. `formOf` parsing works on a fixture HTML string.
- E2E with a fake dictionary provider: the panel shows the "Meaning here" block.

**Risks**
- The heuristic fails on idioms and when the translator paraphrases. That is why the C9 AI layer exists, and the UI only claims "fits this sentence", never "correct".
- Extra Wiktionary requests: capped at 5, run in parallel, cached.

### C9. Optional AI explanation (bring your own key / Chrome built-in)
- **`translate.js` `explainInContext({term, sentence, prev, next, lang, native})`:**
  - Cache key: `x|lang|native|hash32(sentence)|term`.
  - **Anthropic** (when a key is set):
    - `fetch('https://api.anthropic.com/v1/messages')`.
    - Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`, `content-type: application/json`.
    - Body: `model: 'claude-haiku-5-5'`, `max_tokens: 1024`, `output_config: {effort: 'low', format: {type: 'json_schema', schema}}`.
    - Raw fetch is deliberate: the project has no build step and no packages, so the SDK cannot be bundled. Check the `output_config.format` shape against the current Messages API docs during implementation.
    - Schema: `{gloss_in_context, lemma, part_of_speech, grammar_note (≤30 words), multiword_unit|null, sentence_translation}`.
    - System prompt: "You are a language tutor for a learner whose native language is {native}. Explain the target word as used in this exact sentence. JSON only." The user message has the previous, current and next sentences, the word, and its index.
    - Check the `stop_reason` before parsing.
    - Errors: 401 → "Key rejected"; 429 → retry later; network failure → silent fallback to the free layers.
  - **Chrome Prompt API:** `if ('LanguageModel' in self && await LanguageModel.availability() === 'available')`, then a session with the same prompt and `responseConstraint: schema`. **Experimental:** verify the API names at implementation time. Skip this provider if they have changed; it isn't needed for the feature to work.
- **`panel.js`:** an "AI explanation" section that appears only when a provider is configured. It shows gloss, grammar note, multi-word unit (with "Save as phrase") and lemma. It runs automatically when `aiAuto` is on, otherwise via a button.
- **`settings.js`:** "AI explanations (optional)" card:
  - Provider select.
  - Key field, stored as `kv` `secret:anthropic`, with a "Test" button.
  - Clear disclosure: "The key is stored only in this browser and sent only to api.anthropic.com. Approx. $0.15 per 1,000 lookups."
  - `aiAuto` toggle.
- **`db.js` `exportAll()`:** filter `kv` rows whose key starts with `secret:`. This is required.

**Smoke tests:**
- Unit: an exported backup object contains no `secret:` keys (put a fake secret first, then call `exportAll`).
- E2E with a fake AI provider: the panel renders the gloss and grammar note. With no provider, the section is absent.

**Risks:** key exposure to any XSS. The app already escapes all output via `esc()`; review new templates for this. Cost is small and user-controlled.

---

## 4. Other improvements suggested by the research (lower priority, after C1–C9)
1. **Lesson difficulty from token coverage** (insight 6). In `library.js`, compute Σcount(known)/Σcount(non-ignored) per lesson instead of the unique-term share. Badges: ≥98% "Easy read", 95–98% "Good for listening", 90–95% "Challenging", <90% "Hard — try 0.75× speed". Thresholds go in settings (`coverageTargets: [95, 98]`) because the listening figure is contested.
2. **Slow down when it's hard.** In listening mode, if lesson coverage is below 95%, offer a one-tap `setPlaybackRate(0.75)`. The YouTube API treats the rate as a suggestion.
3. **Input-volume progress.** Add `listenSec` to the activity rows (accumulated from `segPlayed`) and allow the daily goal metric to be "minutes listened" or "words read" instead of LingQs created. This follows Kaufmann's emphasis on volume and extensive reading. Otherwise auto-LingQs from lookups would distort the goal.
4. **Content-linked review** (Kaufmann). On a review card, "▶ Hear it in the video" opens the lesson and seeks to the segment where the word was looked up. Store `w.ctxRef = {lessonId, segIdx}` in C7.
5. **Optional frequency placement test** (science and tech reports). A 40-item yes/no test with pseudo-words, using per-language frequency bands fetched on demand from hermitdave/FrequencyWords (CC BY-SA 4.0: needs attribution, and the license file must be checked). It seeds `ev.pre` for high-frequency words. This depends on open question 4.

---

## 5. Open questions for the user
1. **AI explanations:** do you want the optional bring-your-own-key Anthropic feature (`claude-haiku-5-5`, about $0.15 per 1,000 lookups, key kept only in your browser)? Or should only the free layers be built? Everything works without it.
2. **MyMemory email:** on phones the free sentence translation depends on MyMemory's daily quota (reported as about 5,000 characters a day, roughly 50 sentences). Entering an email raises it about tenfold, but that email is then sent to MyMemory. Should the settings field exist (it would be optional and empty by default)?
3. **How eager should listening be?** The plan marks an untapped new word as known after **two** separate listening passes, versus one when reading at your own pace. Do you prefer LingQ-style "one pass = known", or stricter (three passes)? The pace setting already covers LingQs; this question is only about new words.
4. **Placement test with downloaded frequency lists:** worth adding later to skip the cold start in a new language? It would fetch about 100–300 KB per language from GitHub on first use.

Key files: `C:\Users\yassi\LingQ_reversed\js\state.js`, `js\srs.js`, `js\text.js`, `js\dict.js`, `js\db.js`, `js\panel.js`, `js\views\reader.js`, `js\views\vocab.js`, `js\views\review.js`, `js\views\settings.js`, `js\views\library.js`, `sw.js`, `styles.css`, `tests\smoke.html`. New files: `js\knowledge.js`, `js\sync.js`, `js\player.js`, `js\translate.js`.