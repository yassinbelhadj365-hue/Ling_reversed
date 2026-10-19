import { state, lang, langName, statusOf, esc, toast, plural } from '../state.js';
import { htmlToText, youTubeId, formatTime } from '../text.js';
import { hasProvider } from '../ai.js';
import { videoTranscript } from '../video-ai.js';
import { writeStory } from '../story.js';
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

export async function renderImport(view, arg) {
  // One box for everything (a link, a transcript, any text) plus a file button; the rest
  // waits under "More options".
  view.innerHTML = `
    <h1>Import into ${esc(langName(lang()))}</h1>
    <div class="card">
      <div class="field">
        <div class="row spread"><label for="text">Paste a YouTube link, a transcript or any text</label>
          <button class="btn small" id="paste" type="button">📋 Paste</button></div>
        <textarea id="text" placeholder="https://youtu.be/…   or subtitles (.srt/.vtt), an article, song lyrics…"></textarea>
        <span class="small muted" id="yt-status" aria-live="polite">A YouTube link loads its transcript by itself.</span>
        <select id="yt-track" hidden aria-label="Caption track"></select>
        <div class="row"><button class="btn small" id="ai-yt" type="button" hidden title="Listen to the video's audio and write the transcript with AI">🎙 Transcribe the audio with AI instead</button></div>
        <div class="row">
          <label class="btn small" for="files">📎 Choose a file</label>
          <input id="files" type="file" multiple hidden accept=".txt,.srt,.vtt,.md,.html,.htm,text/*,application/x-subrip,*/*">
          <span class="small muted" id="file-names">.srt, .vtt, .txt, .md or .html</span>
        </div>
      </div>
      <p id="preview" class="small muted" aria-live="polite"></p>
      <button class="btn primary" id="go">Import</button>
      <details class="more-options">
        <summary>More options</summary>
        <div class="field">
          <label for="title">Title</label>
          <input id="title" type="text" placeholder="Optional — defaults to the video title, file name or first line">
        </div>
        <div class="field">
          <label for="yt">YouTube video for this transcript</label>
          <div class="row" style="flex-wrap:nowrap">
            <input id="yt" type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…">
            <button class="btn" id="yt-fetch" type="button">Get transcript</button>
          </div>
          <span class="small muted">Only needed when you paste or upload the transcript yourself and want the video to play with it.</span>
        </div>
        <div class="field">
          <label for="media">Audio or video file</label>
          <input id="media" type="file" accept="audio/*,video/*">
          <span class="small muted">Saved on this device and synced with the transcript’s timestamps.</span>
          <div class="row"><button class="btn small" id="ai-file" type="button" hidden>🎙 Transcribe this file with AI</button></div>
        </div>
        <label class="row small"><input type="checkbox" id="merge" ${state.settings.mergeCues ? 'checked' : ''}>
          Merge short caption lines into sentences</label>
        <details id="help">
          <summary class="small"><b>On a phone? / Transcript didn’t load?</b></summary>
      <ul class="small">
        <li><b>Any device with a free AI</b> (<a href="#/settings/ai">Settings → AI</a>): paste a link and Gemini writes the
          transcript when the captions can’t be downloaded.</li>
        <li><b>Logged in on your phone and computer:</b> “Send to my computer” fetches it there; the lesson then
          appears in your phone’s Library.</li>
        <li><b>By hand:</b> paste a transcript or choose a subtitle file (.srt/.vtt).</li>
      </ul>
        </details>
      </details>
    </div>
    <div class="card" id="story-card">
      <h2 style="margin-top:0">✨ Or let the AI write a story for you</h2>
      <p class="small muted">A short text at your level, made of words you know plus a few of the LingQs you’re learning,
        so you meet them again in new sentences.</p>
      <div class="field"><label for="story-topic">About</label>
        <input id="story-topic" type="text" placeholder="Optional — football, a trip to Lyon, cooking, a mystery…"></div>
      <div class="row">
        <select id="story-length" aria-label="Length" style="width:auto">
          <option value="short">Short (~150 words)</option>
          <option value="medium" selected>Medium (~300 words)</option>
          <option value="long">Long (~500 words)</option>
        </select>
        <button class="btn primary" id="story-go">Write it</button>
      </div>
      <p class="small muted" id="story-status" aria-live="polite"></p>
    </div>`;

  const $ = (s) => view.querySelector(s);

  // ---------- a story written by the AI (story.js) ----------
  if (arg === 'story') { $('#story-card').scrollIntoView(); $('#story-topic').focus(); }
  $('#story-go').addEventListener('click', async () => {
    const btn = $('#story-go'), say = (m, html = false) => { $('#story-status')[html ? 'innerHTML' : 'textContent'] = m; };
    if (!(await hasProvider())) {
      return say('No AI is set up yet: <a href="#/settings/ai">set one up</a> (about a minute, free), or <a href="#/account">log in</a> to your account.', true);
    }
    btn.disabled = true;
    say('Writing your story…');
    try {
      const s = await writeStory({ topic: $('#story-topic').value, length: $('#story-length').value });
      const made = await createLesson({
        raw: s.text, title: s.title, merge: false, source: 'story',
        extra: { story: { topic: $('#story-topic').value.trim(), targets: s.targets } },
      });
      if (!made) throw new Error('The AI didn’t write anything. Try again.');
      toast(s.targets.length ? `Your story practises ${plural(s.targets.length, 'LingQ')}` : 'Your story is ready', 4000);
      // Left the Import screen meanwhile: the story waits in the Library instead of pulling you away.
      if ($('#story-go')) location.hash = `#/lesson/${made.lesson.id}`;
    } catch (err) {
      if (!$('#story-go')) return;
      say(err.message === 'no-provider' ? 'No AI is set up yet.' : err.message);
      btn.disabled = false;
    }
  });

  // ---------- automatic YouTube transcripts (served by serve.ps1's /api/transcript) ----------
  const status = (msg, html = false) => { $('#yt-status')[html ? 'innerHTML' : 'textContent'] = msg; };
  const trackLabel = (t) => `${t.name}${t.kind === 'auto' && !/auto/i.test(t.name) ? ' (auto-generated)' : ''}`;
  let fetchedFor = null;
  // A link given on its own (pasted, shared, or from the Library's Paste button) opens its lesson as
  // soon as the transcript is ready, unless there are several captions in this language to choose from.
  let autoOpen = false;
  const openWhenReady = (r) => {
    const choices = (r.tracks || []).filter((t) => (t.lang || '').split('-')[0] === lang()).length;
    if (!autoOpen || choices > 1) return;
    autoOpen = false;
    $('#go').click();
  };
  let shortcut = null; // captions brought by the iPhone Shortcut (youtube.js parseShortcut)

  // Text copied by the iPhone Shortcut: load it like a downloaded transcript.
  function useShortcut(text) {
    const s = parseShortcut(text);
    if (!s) return false;
    shortcut = s;
    autoOpen = true;
    $('#yt').value = `https://www.youtube.com/watch?v=${s.videoId}`;
    $('#text').value = '';
    fetchTranscript();
    return true;
  }
  let noServer = false; // this device can't download from YouTube

  // Nothing here could get the transcript: say why in one line, with the one or two things that
  // fix it as buttons (try again, or let the computer do it), never a page of instructions.
  async function explainNoServer() {
    noServer = true;
    const why = geminiError ? `Gemini couldn’t transcribe it (${esc(geminiError)}).`
      : cloudOutcome === 'blocked' ? 'YouTube refused the cloud helper this time.'
      : cloudOutcome === 'network' ? 'The cloud helper couldn’t reach YouTube.'
      : 'This device can’t download from YouTube itself.';
    const ai = await hasProvider({ video: true });
    const fixes = [
      ai || cloudOutcome === 'blocked' || cloudOutcome === 'network' ? '<button class="btn small" type="button" data-retry>Try again</button>' : '<a class="btn small" href="#/settings/ai">Set up a free AI</a>',
      canRelay() ? '<button class="btn small primary" type="button" data-relay>Send to my computer</button>' : '<a class="btn small" href="#/account">Log in to let your computer do it</a>',
    ];
    if (!$('#yt-status')) return;
    status(`${why}<span class="row" style="margin-top:6px">${fixes.join('')}</span>`, true);
    $('#yt-status [data-retry]')?.addEventListener('click', () => fetchTranscript());
    $('#yt-status [data-relay]')?.addEventListener('click', () => relay('transcript'));
  }

  // Gemini writes the transcript from the video itself (js/video-ai.js).
  // -> a transcript result, or null when it isn't set up or failed (geminiError says why).
  let geminiError = '';
  async function viaGemini(id) {
    const r = await videoTranscript(id, lang(), {
      onProgress: ({ from }) => $('#yt-status') && status(from
        ? `Gemini is still listening… (from ${formatTime(from)})`
        : 'Gemini is listening to the video and writing the transcript (about a minute)…'),
    });
    geminiError = r.error === 'failed' ? r.msg : '';
    return r.ok || r.error === 'empty' ? r : null;
  }

  // One fetch at a time: a link can trigger it, then Import be pressed while Gemini works.
  let inflight = null;
  function fetchTranscript(track = '', { ai = false } = {}) {
    const key = `${$('#yt').value.trim()}|${track}|${ai}`;
    if (inflight?.key !== key) {
      const p = loadTranscript(track, ai).finally(() => { if (inflight?.p === p) inflight = null; });
      inflight = { key, p };
    }
    return inflight.p;
  }

  async function loadTranscript(track, ai) {
    const id = youTubeId($('#yt').value.trim());
    if (!id) return status('That doesn’t look like a YouTube video link.'), false;
    status('Getting the transcript…');
    $('#yt-fetch').disabled = true;
    let r = ai ? null : shortcut?.videoId === id
      ? { ...pickShortcutTrack(shortcut, lang(), track), via: 'shortcut' }
      : await serverTranscript(id, lang(), track);
    // Nothing here can download the captions: let Gemini watch the video.
    if (!r && $('#yt-fetch')) r = await viaGemini(id);
    // The video has no captions at all: Gemini listens to it instead, with no button to press.
    if (r && !r.ok && r.error === 'no-captions' && $('#yt-fetch') && await hasProvider({ video: true })) {
      status('This video has no captions: Gemini is listening to it instead…');
      r = (await viaGemini(id)) || r;
    }
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
        'empty': r.via === 'gemini' ? 'Gemini didn’t hear anyone speak in this video.' : 'YouTube returned empty captions for this track. Try another track.',
      }[r.error] || 'Couldn’t get the transcript.');
      return false;
    }
    $('#text').value = r.vtt;
    $('#text').dispatchEvent(new Event('input'));
    aiMade = r.via === 'gemini';
    if (!$('#title').value.trim() && r.title) $('#title').value = r.title;
    fetchedFor = id;
    if (aiMade) {
      status('✓ Gemini wrote the transcript from the video. AI transcripts can contain mistakes — you can correct any line with ✎ in the lesson.');
      openWhenReady(r);
      return true;
    }
    status(`✓ Loaded “${trackLabel(r.track)}” captions${r.via === 'cloud' ? ' (through your cloud helper)' : r.via === 'shortcut' ? ' (from the iPhone Shortcut)' : ''}.${r.track.kind === 'auto' ? ' Auto-generated captions may contain mistakes.' : ''}`);
    openWhenReady(r);
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
      if (await hasProvider({ video: true })) return fetchTranscript('', { ai: true });
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
    if (e.isTrusted) aiMade = false; // edited by hand
    const value = $('#text').value.trim();
    if (value.startsWith(SHORTCUT_MARK)) return useShortcut($('#text').value);
    // Just a YouTube link in the main box: treat it as the video and load its transcript.
    if (youTubeId(value) && !/\s/.test(value)) {
      autoOpen = true;
      $('#yt').value = value;
      $('#text').value = '';
      $('#yt').dispatchEvent(new Event('input'));
    }
  });
  $('#files').addEventListener('change', () => {
    const names = [...$('#files').files].map((f) => f.name);
    $('#file-names').textContent = names.length ? names.join(', ') : '.srt, .vtt, .txt, .md or .html';
  });

  $('#paste').addEventListener('click', async () => {
    let clip = '';
    try { clip = await navigator.clipboard.readText(); } catch { /* permission refused or unsupported */ }
    if (!clip) return toast('Couldn’t read the clipboard — long-press the box and choose Paste.');
    if (useShortcut(clip)) return;
    const id = youTubeId(clip.trim());
    if (id && clip.trim().split(/\s+/).length === 1) {
      autoOpen = true;
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
    $('#ai-yt').hidden = !id; // transcribing the audio only makes sense for a video
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

  // One import at a time: a link that opens its lesson by itself and a tap on Import while the
  // transcript loads would otherwise both create it.
  let importing = false;
  $('#go').addEventListener('click', async () => {
    if (importing) return;
    importing = true;
    try { await importNow(); } finally { importing = false; }
  });
  async function importNow() {
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
  }

  // Something shared into the app.
  const shared = takeShared();
  if (shared) {
    const link = (shared.url || shared.text || '').match(/https?:\/\/\S+/)?.[0] || '';
    if (youTubeId(link)) {
      autoOpen = true;
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
