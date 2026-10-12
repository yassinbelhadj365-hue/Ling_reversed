# Lingo Reader

A clean-room, LingQ-style language-learning app: import content you care about (YouTube
transcripts, subtitles, articles), read it with every word colour-coded by how well you know
it, save words and phrases as "LingQs", review them with spaced repetition, and watch your
known-word pool grow.

It is an original implementation of the *method* — no LingQ code, assets or content are used.
It's a Progressive Web App: plain HTML/CSS/JS, no build step, no server-side code, all data
stored on your device (IndexedDB).

## Run it

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open <http://localhost:8080>. (Any static file server works too, e.g. `npx serve`.)

### On your phone

* **Same Wi-Fi, quick test:** run `serve.ps1 -Lan` (one-time setup as Administrator:
  `netsh http add urlacl url=http://+:8080/ user=Everyone`, and allow port 8080 through the
  Windows firewall), then open the printed `http://192.168.x.x:8080` address on your phone.
* **Installable app (recommended):** browsers only allow "Add to Home Screen"/offline mode over
  HTTPS. Upload this folder to any free static host — GitHub Pages, Netlify Drop, Cloudflare
  Pages — open the URL on your phone and choose *Add to Home Screen* (iOS) or *Install app*
  (Android).
* Data lives per device/browser. Use **Settings → Export/Import backup** to move it across.

## How it works

| LingQ concept | Here |
|---|---|
| Blue = new word | `status 0`, every word from imported content enters your **word pool** |
| Yellow = LingQ (levels 1–4) | Tap a word → pick a meaning or a level. Select several words for a **phrase** |
| White = known | `status 5`. Mark it, or just **turn the page**: blue words you didn't tap become known |
| Ignore | Names, typos (`status -1`) |
| Review | SM-2 style spaced repetition; correct answers raise the LingQ level |
| Stats | Known words, LingQs, coverage of your content, streak, daily goal, 30-day chart |

**Word pool / passive vocabulary:** each word records how often it appears across all your
lessons (`freq`), which lessons contain it, how many times you've read past it (`seen`), and
its status. *Text coverage* = share of all word occurrences in your content that you know —
a good estimate of how comfortably you can read/listen to it.

**Importing YouTube:** browsers can't fetch YouTube captions directly (CORS), so either copy
the transcript from YouTube's *Show transcript* panel and paste it, or upload an `.srt`/`.vtt`
file. Add the video link and the video is embedded; tap a timestamp to jump to that line, and
the current line is highlighted as it plays. Local audio/video files sync the same way.

**Dictionary:** Wiktionary definitions + MyMemory translations (free, no key), cached locally,
plus links to Google Translate, DeepL, Wiktionary and Reverso.

**Keyboard (desktop):** in the word panel `1`–`4` set level, `K` known, `X` ignore, `Esc`
close. In review: `Space` reveal, `1`–`4` grade, `K` known.

## Project layout

```
index.html, styles.css, manifest.webmanifest, sw.js, icon.svg
js/app.js          router + startup
js/state.js        settings, in-memory vocabulary, word statuses, word pool, activity, TTS
js/db.js           IndexedDB wrapper (lessons, media, words, dict cache, activity, settings)
js/text.js         tokenizer, SRT/VTT/YouTube-transcript/text parsing
js/dict.js         dictionary lookups
js/srs.js          spaced-repetition scheduling
js/panel.js        the word/phrase panel
js/views/*.js      library, import, reader, review, vocab (word pool), stats, settings
tests/smoke.html   end-to-end test (open in a browser while the server runs; it writes test data)
```

## Ideas for next steps

* Cloud sync between phone and computer (e.g. Supabase/Firebase) instead of backup files
* A small backend to fetch YouTube captions automatically from a link
* EPUB import, browser extension to import the page you're reading
* Native app store builds by wrapping it with Capacitor
