# YouTube transcripts on an iPhone: the Lingo Reader Shortcut

Websites can't download YouTube captions (YouTube blocks them), but the iPhone's free
**Shortcuts** app can. After a one-time setup of about 10 minutes, you import a video like this:

1. In the YouTube app, tap **Share → More → Lingo transcript** (or share from Safari).
2. A notification says the captions are copied.
3. Open Lingo Reader → **Import** → **📋 Paste**. The captions, the link and the title fill in
   (in the language you're learning), so just tap **Import**.

No computer, no app to install, nothing to renew. Your iPhone downloads the captions itself.

## One-time setup

Open the **Shortcuts** app → **+** (new shortcut). Name it **Lingo transcript** (tap the name at
the top). Add the actions below in order, using the search box at the bottom to find each one.

**Picking a variable** (the result of an earlier block): tap the field, tap **Select Variable**, and
the blocks grey out. Under each one a small blue **bubble** appears, e.g. **( Matches )**. Tap the
bubble, not the block. Values in `code` must be typed (or better, copied) exactly.

### 1. Receive the link

1. Tap the **ⓘ** (or the arrow next to the name) → turn on **Show in Share Sheet**.
   The first action becomes *Receive **Any** input from **Share Sheet***. Tap **Any** and keep
   only **URLs** and **Text**. Set *If there's no input* to **Get Clipboard**.
2. **Match Text**. Tap the blue pattern and replace it with:
   `(?<=v=|youtu\.be/|shorts/|embed/|live/)[A-Za-z0-9_-]{11}`
   in **Shortcut Input**. Its result, **Matches**, is the video ID. Below, "the **Matches** bubble" means this result.
3. (Nothing else to add here.)

### 2. Ask YouTube for the captions

5. **Text**: paste this, then replace the word `VIDEO` (keep the quotes around it) with the
   **Matches** variable: put the cursor between the quotes, tap **Select Variable**, then tap the small
   **( Matches )** bubble under the Match Text block (the blocks grey out; the bubbles are what you tap):

   ```
   {"context":{"client":{"clientName":"ANDROID","clientVersion":"20.10.38","androidSdkVersion":30,"hl":"en"}},"videoId":"VIDEO"}
   ```

   **Get Contents of URL**. URL: `https://www.youtube.com/youtubei/v1/player?prettyPrint=false`.
   Tap **Show More** (the arrow):
   - **Method:** POST
   - **Headers:** add two (each row is **Key** on the left, value on the right):
     - `Content-Type` = `application/json`
     - `User-Agent` = `com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip`
   - **Request Body:** **File**, then tap the File field → **Select Variable** → the **Text** block above.
6. **Set Variable**: name `Player`, to **Contents of URL**.
7. **Get Dictionary Value**: *Get **Value** for `videoDetails.title` in **Player***.
8. **Set Variable**: name `Title`, to **Dictionary Value**.
9. **Get Dictionary Value**: *Get **Value** for `captions.playerCaptionsTracklistRenderer.captionTracks` in **Player***.

### 3. Download each caption track

10. **Repeat with Each** item in **Dictionary Value** (the result of step 9). Inside the repeat, add:
    1. **Get Dictionary Value**: *Get **Value** for `baseUrl` in **Repeat Item***.
    2. **Replace Text**: replace `&fmt=[^&]*` with *(leave empty)* in **Dictionary Value**.
       Tap **Show More** and turn on **Regular Expression**.
    3. **Text**: the **Updated Text** variable, immediately followed by `&fmt=vtt` (no space).
    4. **Get Contents of URL**: URL = **Text**. **Show More** → Method **GET**, and add the header
       `User-Agent` = `com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip`.
    5. **Text** (four lines, exactly):
       ```
       =====TRACK
       [Repeat Item]
       =====VTT
       [Contents of URL]
       ```
       where `[Repeat Item]` and `[Contents of URL]` are the variables, picked above the keyboard.
11. After **End Repeat**: **Combine Text**: combine **Repeat Results** with **New Lines**.

### 4. Hand it to Lingo Reader

12. **Text** (four lines):
    ```
    LINGO-YT
    [Matches]
    [Title]
    [Combined Text]
    ```
13. **Copy to Clipboard**: **Text**.
14. **Show Notification**: `Captions copied. Open Lingo Reader → Import → 📋 Paste.`

Tap **Done**. The first time you run it, the iPhone asks whether the shortcut may connect to
youtube.com: choose **Always Allow**.

## Use it

- **From the YouTube app:** on a video, **Share → More** (scroll the row of apps) → **Lingo transcript**.
  To have it in the first row, choose **Edit Actions** at the bottom of that list and add it to Favourites.
- **From Safari:** Share → **Lingo transcript**.
- **Without sharing:** copy the video link, then run the shortcut from the Shortcuts app or a
  home-screen icon (it reads the clipboard).

Then in Lingo Reader: **Import → 📋 Paste**. If the box asks for permission, tap **Paste**.
Long-pressing the text box and choosing **Paste** works too.

## If something goes wrong

- **"This video has no captions":** the video really has none, or YouTube refused this time. Try
  again, or use the website's other options ("On a phone?" on the Import screen).
- **"This video has no Spanish captions"** (or your language): pick another track in the list
  under the link, or switch the app language at the top.
- **Nothing happens on Paste:** check that the copied text starts with `LINGO-YT` (paste it into
  Notes to look). If the first line is missing, check step 12.
- If YouTube changes something and the shortcut stops working, the values in step 5 (client
  version and User-Agent) are the first thing to update. The app's `serve.ps1` uses the same ones.
