import * as db from '../db.js';
import { state, lang, langName, statusOf, addLessonToPool, esc, toast, plural } from '../state.js';
import { parseAny, mergeCues, countWords, htmlToText, youTubeId } from '../text.js';
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
        <label for="title">Title</label>
        <input id="title" type="text" placeholder="Optional — defaults to the file name or first line">
      </div>
      <div class="field">
        <label for="yt">YouTube link (optional)</label>
        <input id="yt" type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…">
        <span class="small muted">Embeds the video above the transcript; tap a timestamp to jump there.</span>
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
      </div>
      <label class="row small"><input type="checkbox" id="merge" ${state.settings.mergeCues ? 'checked' : ''}>
        Merge short caption lines into sentences</label>
      <p id="preview" class="small muted" aria-live="polite"></p>
      <button class="btn primary" id="go">Import</button>
    </div>
    <details class="card">
      <summary><b>How to get a YouTube transcript</b></summary>
      <ol class="small">
        <li>Open the video on YouTube (desktop browser), click <b>…more</b> under the title, then <b>Show transcript</b>.</li>
        <li>Select all of the transcript text (timestamps included) and copy it.</li>
        <li>Paste it in the box above and add the video link — the timestamps keep the text in sync with the video.</li>
      </ol>
      <p class="small muted">You can also download subtitles as .srt/.vtt with a subtitle downloader tool and upload them here.
        Browsers block websites from fetching YouTube captions directly, which is why a copy-paste or file is needed.</p>
    </details>`;

  const $ = (s) => view.querySelector(s);

  let previewTimer;
  $('#text').addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
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

    const items = [];
    const text = $('#text').value;
    if (text.trim()) items.push({ title: $('#title').value.trim() || firstLine(text), raw: text, filename: '' });
    for (const f of $('#files').files) {
      let raw = await f.text();
      if (/\.html?$/i.test(f.name)) raw = htmlToText(raw);
      const title = items.length === 0 && $('#title').value.trim() ? $('#title').value.trim() : f.name.replace(/\.[^.]+$/, '');
      items.push({ title, raw, filename: f.name });
    }
    if (!items.length) {
      return toast(ytId
        ? 'Paste the transcript too — browsers can’t download YouTube captions directly.'
        : 'Paste some text or choose a file first.');
    }

    btn.disabled = true;
    btn.textContent = 'Importing…';
    let lastId = null, newWords = 0, made = 0;
    const mediaFile = $('#media').files[0];
    try {
      for (const [i, item] of items.entries()) {
        const p = prepare(item.raw, item.filename, $('#merge').checked);
        if (!p.total) continue;
        const lesson = {
          lang: lang(), title: item.title, kind: p.timed ? 'transcript' : 'text',
          source: i === 0 && ytUrl ? ytUrl : item.filename,
          youtubeId: i === 0 ? ytId : null,
          segments: p.segments, words: p.counts, wordCount: p.total,
          createdAt: Date.now(), openedAt: 0, page: 0, completed: false,
        };
        lesson.id = await db.put('lessons', lesson);
        newWords += await addLessonToPool(lesson);
        if (i === 0 && mediaFile && !ytId) {
          await db.put('media', { lessonId: lesson.id, blob: mediaFile, type: mediaFile.type });
        }
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
