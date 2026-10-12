import * as db from '../db.js';
import { newLessonId } from '../db.js';
import { state, lang, langName, statusOf, addLessonToPool, esc, toast, plural } from '../state.js';
import { parseAny, mergeCues, countWords, htmlToText, youTubeId } from '../text.js';
import { fetchYouTubeAudio, decodeAudio, transcribe, toVtt, progressText, AUDIO_ERRORS } from '../asr.js';
import { NEW } from '../srs.js';

function prepare(raw, filename, merge) {
  const { segments, timed } = parseAny(raw, filename);
  const segs = timed && merge ? mergeCues(segments) : segments;
  const { counts, total } = countWords(segs, lang());
  return { segments: segs, timed, counts, total };
}

function firstLine(text) {
  const line = text.trim().split('\n').find((l) => l.trim() && !/^[\d:.,\s\-–>\[\]]+$/.test(l)) || 'Untitled';
  return line.trim().slice(0, 70);
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
        <div class="row"><button class="btn small" id="ai-yt" type="button" title="Listen to the video's audio and write the transcript with AI (on this computer)">🎙 Transcribe the audio with AI instead</button></div>
      </div>
      <div class="field">
        <label for="title">Title</label>
        <input id="title" type="text" placeholder="Optional — defaults to the video title, file name or first line">
      </div>
      <div class="field">
        <label for="text">Transcript or text</label>
        <textarea id="text" placeholder="Paste a YouTube transcript, the contents of an .srt/.vtt file, an article, song lyrics…"></textarea>
      </div>
      <div class="field">
        <label for="files">…or upload files</label>
        <input id="files" type="file" multiple accept=".txt,.srt,.vtt,.md,.html,.htm,text/plain,text/vtt">
        <span class="small muted">.srt, .vtt, .txt, .md or .html. Each file becomes its own lesson.</span>
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
    <details class="card">
      <summary><b>Transcript didn’t load?</b></summary>
      <p class="small">Automatic transcripts work when the app runs from <b>Start Lingo Reader</b> on your computer
        (browsers can’t read YouTube captions on their own, so the app’s local server fetches them).
        On a phone or the online version, copy it by hand:</p>
      <ol class="small">
        <li>Open the video on YouTube (desktop browser), click <b>…more</b> under the title, then <b>Show transcript</b>.</li>
        <li>Select all of the transcript text (timestamps included), copy it, and paste it in the box above.</li>
      </ol>
      <p class="small muted">You can also upload .srt/.vtt subtitle files.</p>
    </details>`;

  const $ = (s) => view.querySelector(s);

  // ---------- automatic YouTube transcripts (served by serve.ps1's /api/transcript) ----------
  const status = (msg) => { $('#yt-status').textContent = msg; };
  const trackLabel = (t) => `${t.name}${t.kind === 'auto' && !/auto/i.test(t.name) ? ' (auto-generated)' : ''}`;
  let fetchedFor = null;

  async function fetchTranscript(track = '') {
    const id = youTubeId($('#yt').value.trim());
    if (!id) return status('That doesn’t look like a YouTube video link.'), false;
    status('Getting the transcript…');
    $('#yt-fetch').disabled = true;
    let r = null;
    try {
      const res = await fetch(`api/transcript?v=${id}&lang=${lang()}${track !== '' ? `&track=${track}` : ''}`);
      r = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    } catch { /* no local server */ }
    $('#yt-fetch').disabled = false;
    if (!r) {
      status('Automatic transcripts need the app running from Start Lingo Reader on your computer. Paste the transcript below instead.');
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
    status(`✓ Loaded “${trackLabel(r.track)}” captions.${r.track.kind === 'auto' ? ' Auto-generated captions may contain mistakes.' : ''}`);
    return true;
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
  $('#ai-yt').addEventListener('click', () => {
    const id = youTubeId($('#yt').value.trim());
    if (!id) return status('Paste a YouTube link first.');
    aiTranscribe(() => fetchYouTubeAudio(id));
  });
  $('#media').addEventListener('change', () => { $('#ai-file').hidden = !$('#media').files[0]; });
  $('#ai-file').addEventListener('click', () => {
    const f = $('#media').files[0];
    if (f) aiTranscribe(() => f.arrayBuffer());
  });
  $('#text').addEventListener('input', (e) => { if (e.isTrusted) aiMade = false; });

  $('#yt-fetch').addEventListener('click', () => fetchTranscript());
  $('#yt-track').addEventListener('change', (e) => { if (e.target.value !== '') fetchTranscript(e.target.value); });
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
    if (ytId && !$('#text').value.trim() && !$('#files').files.length && !(await fetchTranscript())) return;

    const items = [];
    const text = $('#text').value;
    if (text.trim()) items.push({ title: $('#title').value.trim() || firstLine(text), raw: text, filename: '' });
    for (const f of $('#files').files) {
      let raw = await f.text();
      if (/\.html?$/i.test(f.name)) raw = htmlToText(raw);
      const title = items.length === 0 && $('#title').value.trim() ? $('#title').value.trim() : f.name.replace(/\.[^.]+$/, '');
      items.push({ title, raw, filename: f.name });
    }
    if (!items.length) return toast('Paste a YouTube link, some text, or choose a file first.');

    btn.disabled = true;
    btn.textContent = 'Importing…';
    let lastId = null, newWords = 0, made = 0;
    const mediaFile = $('#media').files[0];
    try {
      for (const [i, item] of items.entries()) {
        const p = prepare(item.raw, item.filename, $('#merge').checked);
        if (!p.total) continue;
        const lesson = {
          lang: lang(), title: item.title, kind: p.timed ? 'transcript' : 'text', asr: i === 0 && !item.filename && aiMade,
          source: i === 0 && ytUrl ? ytUrl : item.filename,
          youtubeId: i === 0 ? ytId : null,
          segments: p.segments, words: p.counts, wordCount: p.total,
          createdAt: Date.now(), openedAt: 0, page: 0, completed: false,
        };
        lesson.id = newLessonId();
        const withMedia = i === 0 && mediaFile && !ytId;
        if (withMedia) {
          lesson.hasMedia = true;
          await db.put('media', { lessonId: lesson.id, blob: mediaFile, type: mediaFile.type, updatedAt: Date.now() });
        }
        await db.put('lessons', lesson);
        newWords += await addLessonToPool(lesson);
        lastId = lesson.id;
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
}
