# Accounts and sync setup (free)

Lingo Reader keeps your progress in sync between devices through your own free
[Supabase](https://supabase.com) project. Each account syncs everything:
- your vocabulary, levels and word pool
- lessons, transcripts, your corrections and flags
- stats, settings and uploaded audio/video files

The one exception is your own Gemini key (if you add one), which stays on each device.

## One-time setup (about 5 minutes)

1. Sign up at supabase.com (free plan, no card needed) and click **New project**.
   Pick any name, a database password you'll keep, and a region near you.
2. When the project is ready, open **SQL Editor → New query**. Paste the whole contents of
   [`supabase-setup.sql`](supabase-setup.sql), then click **Run**. You should see "Success. No rows returned".
3. Open **Authentication → Sign In / Providers → Email** and switch off **Confirm email**.
   If you leave it on, you'll have to click a link in an email after creating each account.
4. Open **Project Settings → API** (or click **Connect** at the top). Copy:
   - the **Project URL** (`https://xxxx.supabase.co`)
   - the **anon** / **publishable** key
5. In the app, open **Account** (the round button at the top) → **Sync server**, paste both, and click
   **Save and check**.
6. Create an account. On the computer you've been using, tick **Bring this device's current progress
   into the new account**.
7. On your phone, open the app (the GitHub Pages / Netlify link), go to **Account**, paste the same
   URL and key, and **Log in** with the same email and password. Everything appears.

So the phone doesn't need step 5, ask Claude to put the URL and key into `js/config.js`. The anon
key is designed to be public; row-level security keeps each account's data private.

## Optional: YouTube transcripts on the phone without your computer

YouTube doesn't let websites download its captions, so normally your computer fetches them
(Start Lingo Reader). A small free "cloud helper" in the same Supabase project lets the phone try on
its own. YouTube sometimes refuses cloud servers. When that happens, the app falls back to asking
your computer, so nothing breaks.

1. In the Supabase dashboard, open **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `transcript`.
3. Delete the sample code. Paste the whole contents of
   [`supabase/functions/transcript/index.ts`](../supabase/functions/transcript/index.ts), then click **Deploy**.
4. Leave **Verify JWT** on: only people logged in to your app can use it.

The free plan includes 500,000 function calls a month; each transcript is one call.

## Shared AI key (translations and explanations)

The word panel's translation and explanation come from Google Gemini's free tier. With this
function, everyone logged in to your sync server uses your key, with no setup on their side.
They can still add their own free key in Settings to get their own daily limit.

1. Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (no card needed).
2. In the Supabase dashboard, open **Edge Functions → Secrets** and add `GEMINI_API_KEY` with that key.
   Optional: `GEMINI_MODEL` to choose the model (default `gemini-2.5-flash`).
3. **Deploy a new function → Via Editor**, name it exactly `ai`, paste the whole contents of
   [`supabase/functions/ai/index.ts`](../supabase/functions/ai/index.ts), then click **Deploy**.
4. Leave **Verify JWT** on. The function also refuses anyone who isn't logged in.

Everyone shares the free tier's limits (a few requests per minute and a daily cap). Each answer is
cached on the device, so tapping the same word in the same sentence again costs nothing.

The same function also lets Gemini **write the transcript of a YouTube video** when nothing else
can download its captions (an iPhone using the website, say). It watches the public video
itself, in 10-minute parts; Google's free tier allows several hours of YouTube video a day.
If you deployed `ai` before October 2026, paste the new `index.ts` and deploy again: older
versions can't send the video, and the app refuses to use them for this.

## How it works

- **Multiple accounts:** each account has its own data on each device. **This device only** is a
  separate local profile that never syncs. Switch from the Account screen.
- **Syncing:** the app syncs when it opens, a few seconds after every change, every minute while
  open, and when you leave the page.
- **Conflicts:** if the same thing is changed on two devices, the most recent change wins. Daily
  stats are kept per device and added up, so no counts are lost.
- **Offline:** the app works fully offline and catches up when you're back online.
- **Free-plan limits:** 500 MB of database, 1 GB of files, and 50 MB per uploaded audio/video file.
  Larger files stay on the device they were added on. Supabase pauses free projects after a week
  with no activity. Opening the app counts as activity; if a project does get paused, click
  **Restore** in the Supabase dashboard.
