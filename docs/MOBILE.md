# Lingo Reader on your phone (Android and iPhone, free)

The phone app is the same Lingo Reader, packaged as a real app with
[Capacitor](https://capacitorjs.com). On top of the website it can **download YouTube
transcripts by itself**: paste a link on the Import screen and it works, with no computer.
It can also import `.srt`/`.vtt`/`.txt` files from the phone's Files.

The apps are built for free by GitHub Actions; you don't need Android Studio or a Mac.
They are for installing on your own phones (no app stores, so there's nothing to pay).

## 1. Build the apps

1. On GitHub, open the repository → **Actions** → **Phone apps** → **Run workflow**.
2. After about 10 minutes, open the finished run. Under **Artifacts** you'll find:
   - `lingo-reader-android`, which holds `lingo-reader.apk`
   - `lingo-reader-ios`, which holds `lingo-reader-unsigned.ipa`

Each artifact downloads as a .zip; unzip it to get the file. Pushing a tag such as `v1.0`
also attaches both files to a GitHub Release.

## 2. Android

1. Copy `lingo-reader.apk` to the phone (or download it there) and open it.
2. Allow your browser or file manager to **install unknown apps** when Android asks.
3. Open **Lingo Reader**.

### Keep your data when updating (one-time setup)

Without a signing key, each build is signed differently, so installing a new version means
uninstalling the old one first, which **deletes the app's data**. (Data synced to your account comes back after logging in.)
To avoid that, give the builds one permanent key. In PowerShell on your computer:

```powershell
$cert = New-SelfSignedCertificate -Subject 'CN=Lingo Reader' -KeyAlgorithm RSA -KeyLength 2048 `
  -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(30) -KeyExportPolicy Exportable
$pw = Read-Host 'Choose a password for the key' -AsSecureString
Export-PfxCertificate -Cert $cert -FilePath "$HOME\lingo-release.pfx" -Password $pw
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\lingo-release.pfx")) | Set-Clipboard
```

Then on GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
- `ANDROID_KEYSTORE_BASE64`: paste (the command copied it).
- `ANDROID_KEYSTORE_PASSWORD`: the password you chose.

Keep `lingo-release.pfx` and the password somewhere safe. A new key can't update an app signed with the old one.
The first build signed with this key must replace the earlier debug build once (uninstall, install).

## 3. iPhone

**Recommended: no app at all.** Open the website in Safari, Share → **Add to Home Screen**, and set up the free
[Lingo transcript Shortcut](IPHONE_SHORTCUT.md) once, so the iPhone downloads YouTube transcripts itself. Nothing to sign or renew.

### The real app instead (Sideloadly, free Apple ID)

Apple only lets apps outside the App Store onto an iPhone when they are signed with an Apple ID.
With a free Apple ID, the signature lasts **7 days** and at most 3 such apps can be installed.

1. On your Windows computer install **iTunes** and **iCloud** from apple.com (not the Microsoft Store
   versions), then [Sideloadly](https://sideloadly.io).
2. Connect the iPhone with a cable and tap **Trust** on the phone.
3. Drag `lingo-reader-unsigned.ipa` into Sideloadly, enter your Apple ID, and click **Start**.
4. On the iPhone: **Settings → General → VPN & Device Management** → your Apple ID → **Trust**.
   On iOS 16 or later, also turn on **Settings → Privacy & Security → Developer Mode** (the phone restarts).
5. Every 7 days, open Sideloadly again and re-install (or turn on its automatic refresh over Wi-Fi).
   Your data stays as long as you re-sign before it expires; if the app stops opening, re-sign it and it comes back.

## Moving your data into the app

The app keeps its own storage, separate from the browser. To bring your progress over:
- **Easiest:** log in to the same account (Account button, top right). Everything syncs.
- **Without an account:** in the browser, Settings → **Export backup**; in the app, Settings → **Import backup**.

## What works differently in the app

- YouTube transcripts are downloaded by the phone itself. If YouTube refuses (rare), the usual
  fallbacks still apply: the cloud helper, then your computer.
- "Transcribe the audio with AI" for a **YouTube** video still needs your computer, which downloads the audio.
  For your own audio/video files it runs on the phone, slowly.
- Translations and explanations work as on the website (your account's shared key, or your own Gemini key).

## Things to check on the first iPhone build

YouTube's player may refuse to play inside the iPhone app (it can show error 152 or 153 because
the app has no web address). If that happens, tell Claude: the fix is to pass the player an origin,
or to load the app from its GitHub Pages address on iPhone.
