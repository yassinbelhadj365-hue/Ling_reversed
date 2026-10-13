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
| Yellow = LingQ (levels 1–4) | **Tapping a word makes it a LingQ automatically.** Select several words for a **phrase** |
| White = known | `status 5`. Reached automatically (see below) or set by hand |
| Ignore | Names, typos (`status -1`) |
| Review | SM-2 style spaced repetition; correct answers raise the LingQ level |

**Automatic word levels** (`js/knowledge.js`): you only tap the words you don't know.
- **Reading:** a new word you read past without tapping becomes known when you turn the page.
- **Listening:** a new word you hear in a video without tapping it becomes known after two separate listens. You can change the number in Settings.
- **LingQs:** a word you tapped climbs a level each time you meet it again without tapping, about 10 encounters to known with at most 3 counted per day. Long flashcard intervals also promote it.

You can always set a level yourself; Known and Ignore stay as you set them. Every automatic change can be undone from the panel, from the page-turn toast, or in **Vocab → Auto-changed**. The thresholds come from research on incidental vocabulary learning (see `docs/PLAN.md`).

**Video lessons (listen mode):** a timed transcript plus a YouTube link or audio/video file shows one continuous transcript that follows playback.
- **Following:** the line being spoken stays just below the player, with words underlined as they're said. Scroll yourself to look back; **Follow video** returns you to the spoken line.
- **Lookups:** tapping a word pauses the video, and closing the panel resumes it.
- **Keys:** `Space` play/pause, `←`/`→` previous/next line, `R` replay.
- **Fixes and options:** a timing offset corrects transcripts that drift, and the "Translate the current line" option shows each spoken line's translation.

**Translations in context:** tapping a word shows the exact sentence it's in and its translation.
- **Free translation:** on-device in Chrome or Edge when the language pack is installed; otherwise MyMemory.
- **"Meaning here":** the dictionary sense that fits the sentence.
- **Grammar:** word forms (*vamos* = form of *ir*) and expressions (*a pesar de*).
- **Chrome extra:** in Chrome on a computer, an on-device AI (Gemini Nano) explanation with a grammar note.
| Stats | Known words, LingQs, coverage of your content, streak, daily goal, 30-day chart |

**Word pool / passive vocabulary:** each word records how often it appears across all your
lessons (`freq`), which lessons contain it, how many times you've read past it (`seen`), and
its status. *Text coverage* = share of all word occurrences in your content that you know —
a good estimate of how comfortably you can read/listen to it.

**Explanations in the language you're learning:** tapping a word, selecting a passage, or using a line's 💬 button gives an explanation in simple Spanish (or whichever language you're studying).
- **What you get:** a paraphrase, a grammar note and example sentences, written by an AI that reads the whole transcript.
- **Translations:** English is one tap away, under **Show English**.
- **Still unclear?** Ask a stronger free model, DeepSeek's free chat, or a private ChatGPT chat (your subscription).
- **Free only:** Chrome's built-in AI, or a free OpenRouter model ([setup in Settings](https://openrouter.ai/keys)).

**AI transcription and transcript checking:** **Transcribe the audio with AI** (Import screen) writes a timed transcript with Whisper, running free on your computer. Use it for YouTube videos without captions, or for your own audio/video files.
- **Check transcript against the audio** (in a video lesson's ⋯ menu) underlines words the audio doesn't seem to say. Tap one to replace it.
- You can flag any word, sentence or stretch as wrong yourself, and correct any line with ✎.

**Accounts and sync:** create one or more accounts (Account button, top right) to keep your progress in sync between your computer and phone. That covers vocabulary, lessons, transcripts and edits, stats, settings and audio files. It needs a free Supabase project you set up once; see [docs/SYNC_SETUP.md](docs/SYNC_SETUP.md).

**Importing YouTube:** paste a video link on the Import screen and the transcript and title load
automatically, in the language you're studying. You can pick another caption track if there are several.
Auto-generated captions work too, with per-word timing. Downloading from YouTube needs a computer running
**Start Lingo Reader** / `serve.ps1`, because YouTube refuses requests from other websites.

**On a phone:** with the optional free cloud helper in your sync server (see [docs/SYNC_SETUP.md](docs/SYNC_SETUP.md)),
pasting a link works on its own, though YouTube sometimes refuses it. Otherwise, or when it's refused, log in to the same account on the phone and the computer. Paste the link (or use *Share → Lingo Reader*
from the YouTube app on Android) and press **Import**. The next time Lingo Reader is open on your computer, it fetches the
transcript (or transcribes the audio with AI), and the lesson appears in the phone's Library. You can also paste a
transcript by hand or upload an `.srt`/`.vtt` file.

**Keyboard (desktop):** in the word panel `1`–`4` set level, `K` known, `X` ignore, `Esc`
close. In review: `Space` reveal, `1`–`4` grade, `K` known.

## Project layout

```
index.html, styles.css, manifest.webmanifest, sw.js, icon.svg
js/app.js          router + startup
js/state.js        settings, in-memory vocabulary, word statuses, word pool, activity, TTS
js/db.js           IndexedDB wrapper (lessons, media, words, dict cache, activity, settings)
js/text.js         tokenizer, SRT/VTT/YouTube-transcript/text parsing, sentences, expressions
js/dict.js         dictionary lookups (Wiktionary incl. word forms, MyMemory)
js/translate.js    sentence translation, meaning-in-context ranking, on-device AI
js/knowledge.js    automatic word levels from lookups, reading, listening and review
js/player.js       YouTube / local media player adapter
js/sync.js         transcript timeline (active line, word progress)
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
