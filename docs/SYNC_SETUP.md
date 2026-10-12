# Accounts and sync setup (free)

Lingo Reader keeps your progress in sync between devices through your own free
[Supabase](https://supabase.com) project. Each account syncs everything:
- your vocabulary, levels and word pool
- lessons, transcripts, your corrections and flags
- stats, settings and uploaded audio/video files

The one exception is your OpenRouter key, which stays on each device.

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
