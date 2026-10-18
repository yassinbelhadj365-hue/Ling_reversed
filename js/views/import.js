import { state, lang, langName, statusOf, esc, toast, plural } from '../state.js';
import { htmlToText, youTubeId } from '../text.js';
import { fetchYouTubeAudio, decodeAudio, transcribe, toVtt, progressText, AUDIO_ERRORS } from '../asr.js';
import { prepare, createLesson, fetchTranscript as serverTranscript, serverCaps, canRelay, requestImport, cloudOutcome } from '../relay.js';
import { NEW } from '../srs.js';
import { parseShortcut, pickShortcutTrack, SHORTCUT_MARK } from '../youtube.js';

const TEXT_FILE = /\.(txt|srt|vtt|md|html?)$/i;

// A link or text shared into the app (Android: Share → Lingo Reader), stored by app.js.
function takeShared() {
  try {
    const s = sessionStorage.getItem('lingo-share');
    sessionStorage.removeItem('lingo-share');
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

export async function renderImport(view) {
  view.innerHTML = `
    <h1>Import into ${esc(langName(lang()))}</h1>
    <div class="card">
      <div class="field">
        <label for="yt">YouTube link</label>
        <div class="row" style="flex-wrap:nowrap">
          <input id="yt" type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…">
          <button class="btn" id="yt-fetch" type="button">Get transcript</button>
        </div>
        <span class="small muted" id="yt-status" aria-live="polite">Paste a link and the transcript is fetched automatically.</span>
        <select id="yt-track" hidden aria-label="Caption track"></select>
        <div class="row"><button class="btn small" id="ai-yt" type="button" title="Listen to the video's audio and write the transcript with AI">🎙 Transcribe the audio with AI instead</button></div>
      </div>
      <div class="field">
        <label for="title">Title</label>
        <input id="title" type="text" placeholder="Optional — defaults to the video title, file name or first line">
      </div>
      <div class="field">
        <div class="row spread"><label for="text">Transcript or text</label>
          <button class="btn small" id="paste" type="button">📋 Paste</button></div>
        <textarea id="text" placeholder="Paste a YouTube transcript, the contents of an .srt/.vtt file, an article, song lyrics…"></textarea>
      </div>
      <div class="field">
        <label for="files">…or upload files</label>
        <input id="files" type="file" multiple accept=".txt,.srt,.vtt,.md,.html,.htm,text/*,application/x-subrip,*/*">
        <span class="small muted">.srt, .vtt, .txt, .md or .html, also from your phone’s Files. Each file becomes its own lesson.</span>
      </div>
      <div class="field">
        <label for="media">Audio or video file (optional)</label>
        <input id="media" type="file" accept="audio/*,video/*">
        <span class="small muted">Saved on this device and synced with the transcript’s timestamps.</span>
        <div class="row"><button class="btn small" id="ai-file" type="button" hidden>🎙 Transcribe this file with AI</button></div>
      </div>
      <label class="row small"><input type="checkbox" id="merge" ${state.settings.mergeCues ? 'checked' : ''}>
        Merge short caption lines into sentences</label>
      <p id="preview" class="small muted" aria-live="polite"></p>
      <button class="btn primary" id="go">Import</button>
    </div>
    <details class="card" id="help">
      <summary><b>On a phone? / Transcript didn’t load?</b></summary>
      <p class="small">Only a <b>computer</b> running <b>Start Lingo Reader</b> can download from YouTube (YouTube refuses
        requests from other websites, and phones can’t run the helper). There are a few ways to import on your phone:</p>
      <ol class="small">
        <li><b>iPhone:</b> set up the free <a href="https://github.com/yassinbelhadj365-hue/Ling_reversed/blob/main/docs/IPHONE_SHORTCUT.md" target="_blank" rel="noopener">Lingo transcript Shortcut</a>
          once. Then share a video to it from the YouTube app, come back here and tap <b>📋 Paste</b>.</li>
        <li><b>The Lingo Reader phone app</b> (docs/MOBILE.md) downloads transcripts itself: paste a link and it just works.</li>
        <li><b>Cloud helper (no computer needed):</b> if you added the free <i>transcript</i> function to your sync
          server (docs/SYNC_SETUP.md), pasting a link works directly. YouTube sometimes refuses it; then the next option kicks in.</li>
        <li><b>Let your computer do it (easiest).</b> Log in to the same account on your phone and computer (top right,
          see <i>Account</i>). Paste the link here and press <b>Import</b>. Next time Lingo Reader is open on your
          computer, it fetches the transcript (or transcribes it with AI). The lesson then appears in your phone’s Library.</li>
        <li><b>Same Wi-Fi:</b> start the app on your computer with <code>serve.ps1 -Lan</code> and open the address it
          prints on your phone. Then everything works directly, like on the computer.</li>
        <li><b>By hand:</b> open the video in your phone’s browser, choose <i>Desktop site</i> in the menu, tap <b>…more</b> under
          the title, then <b>Show transcript</b>. Select the transcript text, copy it, and paste it above (📋 Paste).
          Subtitle files (.srt/.vtt) work too.</li>
      </ol>
      <p class="small muted">On Android, after installing the app you can also use <b>Share → Lingo Reader</b> from the YouTube app.</p>
    </details>`;

  const $ = (s) => view.querySelector(s);

  // ---------- automatic YouTube transcripts (served by serve.ps1's /api/transcript) ----------
  const status = (msg, html = false) => { $('#yt-status')[html ? 'innerHTML' : 'textContent'] = msg; };
  const trackLabel = (t) => `${t.name}${t.kind === 'auto' && !/auto/i.test(t.name) ? ' (auto-generated)' : ''}`;
  let fetchedFor = null;
  let shortcut = null; // captions brought by the iPhone Shortcut (youtube.js parseShortcut)

  // Text copied by the iPhone Shortcut: load it like a downloaded transcript.
  function useShortcut(text) {
    const s = parseShortcut(text);
    if (!s) return false;
    shortcut = s;
    $('#yt').value = `https://www.youtube.com/watch?v=${s.videoId}`;
    $('#text').value = '';
    fetchTranscript();
    return true;
  }
  let noServer = false; // this device can't download from YouTube

  function explainNoServer() {
    noServer = true;
    const why = cloudOutcome === 'blocked' ? 'YouTube refused the cloud helper this time, so '
      : cloudOutcome === 'network' ? 'The cloud helper couldn’t reach YouTube, so ' : 'This device can’t download from YouTube itself, so ';
    if (canRelay()) {
      status(`${why}press <b>Import</b>: your computer will get the transcript the next time Lingo Reader is open there, and the lesson will appear in your Library.`, true);
    } else {
      status('This device can’t download from YouTube itself (only a computer running Start Lingo Reader can). '
        + '<a href="#/account">Log in to your account</a> on this phone and your computer, then your computer can do it for you. '
        + 'Or paste the transcript below — see “On a phone?” at the bottom.', true);
    }
  }

  async function fetchTranscript(track = '') {
    const id = youTubeId($('#yt').value.trim());
    if (!id) return status('That doesn’t look like a YouTube video link.'), false;
    status('Getting the transcript…');
    $('#yt-fetch').disabled = true;
    const r = shortcut?.videoId === id
      ? { ...pickShortcutTrack(shortcut, lang(), track), via: 'shortcut' }
      : await serverTranscript(id, lang(), track);
    if (!$('#yt-fetch')) return false; // the import screen was left in the meantime
    $('#yt-fetch').disabled = false;
    if (!r) {
      explainNoServer();
      return false;
    }
    const sel = $('#yt-track');
    if (r.tracks?.length) {
      sel.innerHTML = r.tracks.map((t) => `<option value="${t.index}" ${r.track?.index === t.index ? 'selected' : ''}>${esc(trackLabel(t))}</option>`).join('');
      if (!r.ok) sel.insertAdjacentHTML('afterbegin', '<option value="" selected>Choose captions…</option>');
      sel.hidden = r.tracks.length < 2 && r.ok;
    } else sel.hidden = true;
    if (!r.ok) {
      status({
        'no-track': `This video has no ${langName(lang())} captions. Pick another track below, or switch the app language at the top.`,
        'no-captions': 'This video has no captions. Use “Transcribe the audio with AI” below, or paste a transcript.',
        'network': 'Couldn’t reach YouTube. Check your connection and try again.',
        'empty': 'YouTube returned empty captions for this track. Try another track.',
      }[r.error] || 'Couldn’t get the transcript.');
      return false;
    }
    $('#text').value = r.vtt;
    $('#text').dispatchEvent(new Event('input'));
    aiMade = false;
    if (!$('#title').value.trim() && r.title) $('#title').value = r.title;
    fetchedFor = id;
    status(`✓ Loaded “${trackLabel(r.track)}” captions${r.via === 'cloud' ? ' (through your cloud helper)' : r.via === 'shortcut' ? ' (from the iPhone Shortcut)' : ''}.${r.track.kind === 'auto' ? ' Auto-generated captions may contain mistakes.' : ''}`);
    return true;
  }

  // Ask the computer (through the synced account) to do it.
  async function relay(kind) {
    const url = $('#yt').value.trim();
    const videoId = youTubeId(url);
    await requestImport({ kind, videoId, url, title: $('#title').value.trim(), track: $('#yt-track').value || '', merge: $('#merge').checked });
    toast(kind === 'asr'
      ? 'Sent to your computer — it will transcribe the video with AI next time Lingo Reader is open there.'
      : 'Sent to your computer — the lesson will appear in your Library when it’s fetched.', 6000);
    location.hash = '#/library';
  }

  // ---------- AI transcription (Whisper on this device) ----------
  let aiMade = false; // the transcript in the box came from AI speech recognition
  let busy = false;
  async function aiTranscribe(getAudio) {
    if (busy) return;
    busy = true;
    const btns = [$('#ai-yt'), $('#ai-file'), $('#go')];
    btns.forEach((b) => { b.disabled = true; });
    const show = (p) => status(progressText(p));
    try {
      show({ stage: 'audio' });
      const raw = await getAudio();
      show({ stage: 'decode' });
      const audio = await decodeAudio(raw);
      const cues = await transcribe(audio, { lang: lang(), onProgress: show });
      if (!cues.length) throw new Error('empty');
      $('#text').value = toVtt(cues);
      $('#text').dispatchEvent(new Event('input'));
      aiMade = true;
      status(`✓ Transcribed ${plural(cues.length, 'line')} with AI. AI transcripts can contain mistakes — you can correct any line with ✎ in the lesson.`);
    } catch (err) {
      status(AUDIO_ERRORS[err.message] || (err.message === 'empty'
        ? 'The AI didn’t hear any speech in this audio.'
        : `AI transcription failed: ${err.message}`));
    } finally {
      busy = false;
      btns.forEach((b) => { b.disabled = false; });
    }
  }
  $('#ai-yt').addEventListener('click', async () => {
    const id = youTubeId($('#yt').value.trim());
    if (!id) return status('Paste a YouTube link first.');
    if (!(await serverCaps()).transcripts) {
      if (canRelay()) return relay('asr');
      return explainNoServer();
    }
    aiTranscribe(() => fetchYouTubeAudio(id));
  });
  $('#media').addEventListener('change', () => { $('#ai-file').hidden = !$('#media').files[0]; });
  $('#ai-file').addEventListener('click', () => {
    const f = $('#media').files[0];
    if (f) aiTranscribe(() => f.arrayBuffer());
  });
  $('#text').addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    aiMade = false;
    if ($('#text').value.trimStart().startsWith(SHORTCUT_MARK)) useShortcut($('#text').value);
  });

  $('#paste').addEventListener('click', async () => {
    let clip = '';
    try { clip = await navigator.clipboard.readText(); } catch { /* permission refused or unsupported */ }
    if (!clip) return toast('Couldn’t read the clipboard — long-press the box and choose Paste.');
    if (useShortcut(clip)) return;
    const id = youTubeId(clip.trim());
    if (id && clip.trim().split(/\s+/).length === 1) {
      $('#yt').value = clip.trim();
      $('#yt').dispatchEvent(new Event('input'));
    } else {
      $('#text').value = clip;
      $('#text').dispatchEvent(new Event('input'));
    }
  });

  $('#yt-fetch').addEventListener('click', () => fetchTranscript());
  $('#yt-track').addEventListener('change', (e) => { if (e.target.value !== '' && (!noServer || shortcut)) fetchTranscript(e.target.value); });
  $('#yt').addEventListener('input', () => {
    const id = youTubeId($('#yt').value.trim());
    if (id && id !== fetchedFor && !$('#text').value.trim()) fetchTranscript();
  });

  let previewTimer;
  $('#text').addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (!$('#text')) return; // the import screen was left in the meantime
      const raw = $('#text').value;
      if (!raw.trim()) return ($('#preview').textContent = '');
      const p = prepare(raw, '', $('#merge').checked);
      const unique = Object.keys(p.counts);
      const fresh = unique.filter((t) => !state.vocab.has(t) || statusOf(t) === NEW).length;
      $('#preview').textContent =
        `${p.timed ? 'Timed transcript' : 'Text'} · ${plural(p.segments.length, p.timed ? 'line' : 'paragraph')} · ` +
        `${plural(p.total, 'word')} · ${unique.length.toLocaleString()} unique · ${fresh.toLocaleString()} new to you`;
    }, 300);
  });

  $('#go').addEventListener('click', async () => {
    const btn = $('#go');
    const ytUrl = $('#yt').value.trim();
    const ytId = youTubeId(ytUrl);
    if (ytUrl && !ytId) return toast('That doesn’t look like a YouTube video link.');
    if (ytId && !$('#text').value.trim() && !$('#files').files.length && !(await fetchTranscript())) {
      if (noServer && canRelay()) relay('transcript');
      return;
    }

    const items = [];
    const text = $('#text').value;
    if (text.trim()) items.push({ title: $('#title').value.trim(), raw: text, filename: '' });
    const skipped = [];
    for (const f of $('#files').files) {
      // The picker accepts any file (iPhones grey out .srt/.vtt otherwise), so check here.
      if (!TEXT_FILE.test(f.name) && !/^text\//.test(f.type)) { skipped.push(f.name); continue; }
      let raw = await f.text();
      if (/\.html?$/i.test(f.name)) raw = htmlToText(raw);
      const title = items.length === 0 && $('#title').value.trim() ? $('#title').value.trim() : f.name.replace(/\.[^.]+$/, '');
      items.push({ title, raw, filename: f.name });
    }
    if (skipped.length) toast(`Skipped ${skipped.join(', ')}: only subtitle or text files (.srt, .vtt, .txt, .md, .html) become lessons.`, 6000);
    if (!items.length) return skipped.length || toast('Paste a YouTube link, some text, or choose a file first.');

    btn.disabled = true;
    btn.textContent = 'Importing…';
    let lastId = null, newWords = 0, made = 0;
    const mediaFile = $('#media').files[0];
    try {
      for (const [i, item] of items.entries()) {
        const r = await createLesson({
          raw: item.raw, filename: item.filename, title: item.title, merge: $('#merge').checked,
          asr: i === 0 && !item.filename && aiMade,
          source: i === 0 && ytUrl ? ytUrl : item.filename,
          youtubeId: i === 0 ? ytId : null,
          media: i === 0 && mediaFile && !ytId ? mediaFile : null,
        });
        if (!r) continue;
        newWords += r.newWords;
        lastId = r.lesson.id;
        made++;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import';
    }
    if (!made) return toast('No words found in that content.');
    toast(`Imported ${plural(made, 'lesson')} · ${plural(newWords, 'new word')} added to your pool`, 4000);
    location.hash = made === 1 ? `#/lesson/${lastId}` : '#/library';
  });

  // Something shared into the app.
  const shared = takeShared();
  if (shared) {
    const link = (shared.url || shared.text || '').match(/https?:\/\/\S+/)?.[0] || '';
    if (youTubeId(link)) {
      $('#yt').value = link;
      if (shared.title && !/^https?:/.test(shared.title)) $('#title').value = shared.title;
      $('#yt').dispatchEvent(new Event('input'));
    } else if (shared.text) {
      $('#text').value = shared.text;
      if (shared.title) $('#title').value = shared.title;
      $('#text').dispatchEvent(new Event('input'));
    }
  }
}
