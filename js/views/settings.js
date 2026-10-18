import * as db from '../db.js';
import { state, LANGS, lang, langName, saveSettings, loadSettings, loadVocab, toast, download, esc } from '../state.js';
import { getKey, setKey, listModels } from '../ai.js';
import { explain } from '../explain.js';
import { MODELS as ASR_MODELS } from '../asr.js';

const langOptions = (selected) =>
  LANGS.map(([code, name]) => `<option value="${code}" ${code === selected ? 'selected' : ''}>${name}</option>`).join('');

export async function renderSettings(view) {
  const s = state.settings;
  view.innerHTML = `
    <h1>Settings</h1>
    <div class="card">
      <div class="field"><label for="native">Your native language (for translations)</label>
        <select id="native">${langOptions(s.native)}</select></div>
      <div class="field"><label for="pageSize">Words per reader page</label>
        <input id="pageSize" type="number" min="50" max="2000" step="50" value="${s.pageSize}"></div>
      <div class="field"><label for="dailyMinutes">Daily goal: minutes of reading, listening or review</label>
        <select id="dailyMinutes" style="width:auto">${[5, 10, 15, 20, 30, 45, 60].map((m) => `<option value="${m}" ${s.dailyMinutes === m ? 'selected' : ''}>${m} minutes</option>`).join('')}</select>
        <span class="small muted">Small is fine: a short day every day beats a long one now and then. One missed day a week doesn’t break your streak.</span></div>
      <label class="row"><input type="checkbox" id="mergeCues" ${s.mergeCues ? 'checked' : ''}>
        Merge short caption lines into sentences when importing</label>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Automatic word levels</h2>
      <label class="row"><input type="checkbox" id="autoStatus" ${s.autoStatus ? 'checked' : ''}>
        Let the app set word levels from what I do</label>
      <div id="auto-opts" ${s.autoStatus ? '' : 'hidden'}>
        <p class="small muted">Tapping a word makes it a LingQ (level 1). Each time you meet it again without tapping,
          it moves toward known (about 10 encounters, at most 3 counted per day). Words you read past without tapping
          become known right away. You can always change a level yourself, and automatic changes can be undone.</p>
        <div class="field"><label>Leveling pace</label>
          <div class="segmented" role="group" aria-label="Leveling pace">
            ${[['cautious', 'Cautious'], ['normal', 'Normal'], ['fast', 'Fast']].map(([k, l]) =>
              `<button data-pace="${k}" class="${s.autoPace === k ? 'on' : ''}">${l}</button>`).join('')}
          </div></div>
        <div class="field"><label for="listenPasses">New words I hear in videos without tapping become known after</label>
          <select id="listenPasses" style="width:auto">
            ${[1, 2, 3].map((n) => `<option value="${n}" ${s.listenPasses === n ? 'selected' : ''}>${n} listen${n > 1 ? 's' : ''}</option>`).join('')}
          </select></div>
        <label class="row"><input type="checkbox" id="autoAdjustManual" ${s.autoAdjustManual ? 'checked' : ''}>
          Keep adjusting LingQ levels I set myself (words I mark Known or Ignore are never changed)</label>
      </div>
      <div id="paging-opt" ${s.autoStatus ? 'hidden' : ''}>
        <label class="row"><input type="checkbox" id="pagingKnown" ${s.pagingKnown ? 'checked' : ''}>
          Turning a page marks blue words I didn’t tap as known</label>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Video &amp; audio lessons</h2>
      <p class="small muted">Lessons with timestamps and a video or audio file show one continuous transcript that moves with playback.</p>
      ${[
        ['follow', 'Scroll the transcript with the video (scrolling yourself pauses this)'],
        ['dimOtherLines', 'Fade the lines that aren’t being spoken'],
        ['wordProgress', 'Underline words as they are spoken (approximate)'],
        ['pauseOnLookup', 'Pause the video when I tap a word'],
        ['resumeAfterLookup', 'Resume when I close the word panel'],
      ].map(([k, label]) => `<label class="row"><input type="checkbox" data-bool="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`).join('')}
      <div class="field" style="margin-top:12px"><label for="asrModel">AI transcription model (runs on this device, free)</label>
        <select id="asrModel">${Object.entries(ASR_MODELS).map(([k, m]) =>
          `<option value="${k}" ${s.asrModel === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
        <span class="small muted">Used by “Transcribe with AI” and “Check transcript against audio”. Downloaded once, then cached.
          Fastest in Chrome or Edge on a computer.</span></div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Translation &amp; explanations (AI)</h2>
      <p class="small muted">Tapping a word asks one AI, Google Gemini (free tier), for the translation of the sentence, what the
        word means <i>here</i>, and a short explanation in ${esc(langName(s.lang))} with examples. It reads the transcript around
        the sentence for context.</p>
      <ul class="small">
        <li><b>Logged in to your account:</b> it works with no setup, using the sync server’s shared key.
          Everyone on that server shares one free daily limit.</li>
        <li><b>Your own key (optional):</b> gives you your own daily limit. Get one free at
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> (no card needed).</li>
      </ul>
      <div class="field"><label for="gm-key">Your Gemini key (optional)</label>
        <input id="gm-key" type="password" autocomplete="off" placeholder="AIza…">
        <span class="small muted">Stored only on this device, never synced or included in backups, and sent only to Google.</span></div>
      <div class="field"><label for="gm-model">Model</label>
        <select id="gm-model"><option value="">Automatic (newest free Flash model)</option></select>
        <span class="small muted">The list needs your own key. “Lite” models are faster and have a higher free limit. Each model has its own free limit: when this one’s is used up, the other free Flash models answer by themselves.</span></div>
      <label class="row"><input type="checkbox" data-bool="aiAuto" ${s.aiAuto ? 'checked' : ''}>
        Ask automatically when I tap (otherwise there’s an Explain button, which saves the daily limit)</label>
      <div class="row"><button class="btn small" id="gm-test">Test</button><span id="gm-status" class="small muted"></span></div>
      <p class="small muted">“Still unclear?” in the word panel asks the same AI for a longer answer. It can also open DeepSeek or ChatGPT
        (your own subscription) with the question ready.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Text to speech</h2>
      <div class="field"><label for="voice">Voice</label><select id="voice"></select></div>
      <div class="field"><label for="ttsRate">Speed: <span id="rateVal">${s.ttsRate}</span>×</label>
        <input id="ttsRate" type="range" min="0.5" max="1.5" step="0.05" value="${s.ttsRate}"></div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Backup</h2>
      <p class="small muted">All your data is stored only in this browser. Export a backup to move it to another device (e.g. from your computer to your phone).
        Audio/video files are not included.</p>
      <div class="row">
        <button class="btn" id="export">Export backup</button>
        <label class="btn">Import backup<input type="file" id="import" accept=".json,application/json" hidden></label>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Install on your phone</h2>
      <p class="small"><b>The phone app</b> (Android and iPhone, free) can download YouTube transcripts by itself.
        See <i>docs/MOBILE.md</i> in the project for how to build and install it.</p>
      <p class="small">Or open this website in your phone’s browser and use <b>Share → Add to Home Screen</b> (iPhone, Safari) or
        <b>⋮ → Install app</b> (Android, Chrome). It then opens full-screen and works offline, except for AI lookups.</p>
    </div>`;

  const $ = (sel) => view.querySelector(sel);
  const num = (el, min, max, fallback) => {
    const v = Number(el.value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };

  $('#native').addEventListener('change', (e) => saveSettings({ native: e.target.value }).then(() => toast('Saved')));
  $('#pageSize').addEventListener('change', (e) => saveSettings({ pageSize: num(e.target, 50, 2000, 250) }).then(() => toast('Saved')));
  $('#dailyMinutes').addEventListener('change', (e) => saveSettings({ dailyMinutes: Number(e.target.value) }).then(() => toast('Saved')));
  $('#pagingKnown').addEventListener('change', (e) => saveSettings({ pagingKnown: e.target.checked }));
  $('#autoStatus').addEventListener('change', (e) => {
    saveSettings({ autoStatus: e.target.checked });
    $('#auto-opts').hidden = !e.target.checked;
    $('#paging-opt').hidden = e.target.checked;
  });
  view.querySelectorAll('[data-pace]').forEach((b) => b.addEventListener('click', () => {
    saveSettings({ autoPace: b.dataset.pace });
    view.querySelectorAll('[data-pace]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#listenPasses').addEventListener('change', (e) => saveSettings({ listenPasses: Number(e.target.value) }));
  $('#autoAdjustManual').addEventListener('change', (e) => saveSettings({ autoAdjustManual: e.target.checked }));
  view.querySelectorAll('[data-bool]').forEach((el) =>
    el.addEventListener('change', () => saveSettings({ [el.dataset.bool]: el.checked })));
  $('#asrModel').addEventListener('change', (e) => saveSettings({ asrModel: e.target.value }).then(() => toast('Saved')));

  // ---- Gemini (free tier) ----
  async function fillModels() {
    const key = await getKey();
    const chosen = state.settings.geminiModel;
    let models = [];
    if (key) try { models = await listModels(key); } catch { /* offline or bad key: Test says which */ }
    if (chosen && !models.some((m) => m.id === chosen)) models.unshift({ id: chosen, name: chosen });
    $('#gm-model').innerHTML = '<option value="">Automatic (newest free Flash model)</option>' +
      models.map((m) => `<option value="${esc(m.id)}" ${m.id === chosen ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  }
  getKey().then((k) => { $('#gm-key').value = k; });
  fillModels();
  $('#gm-key').addEventListener('change', (e) => setKey(e.target.value).then(() => { toast('Key saved'); fillModels(); }));
  $('#gm-model').addEventListener('change', (e) => saveSettings({ geminiModel: e.target.value }).then(() => toast('Saved')));
  $('#gm-test').addEventListener('click', async () => {
    $('#gm-status').textContent = 'Asking…';
    try {
      const { result, source } = await explain({ kind: 'word', term: 'casa', sentence: 'Mi casa es tu casa.', transcript: '' }, { fresh: true });
      $('#gm-status').textContent = `✓ Works (${source}): “${result.meaning_native || result.translation || ''}”`;
    } catch (err) {
      $('#gm-status').textContent = err.message === 'no-provider' ? 'No AI yet: add your key, or log in to your account.' : err.message;
    }
  });
  $('#mergeCues').addEventListener('change', (e) => saveSettings({ mergeCues: e.target.checked }));
  $('#ttsRate').addEventListener('input', (e) => { $('#rateVal').textContent = e.target.value; });
  $('#ttsRate').addEventListener('change', (e) => saveSettings({ ttsRate: Number(e.target.value) }));
  $('#voice').addEventListener('change', (e) => saveSettings({ voice: e.target.value }));

  function fillVoices() {
    const voices = ('speechSynthesis' in window ? speechSynthesis.getVoices() : [])
      .filter((v) => v.lang.toLowerCase().startsWith(lang()));
    $('#voice').innerHTML = voices.length
      ? '<option value="">Automatic</option>' + voices.map((v) =>
          `<option value="${esc(v.voiceURI)}" ${v.voiceURI === state.settings.voice ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('')
      : '<option value="">No voice for this language on this device</option>';
  }
  fillVoices();
  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', fillVoices);

  $('#export').addEventListener('click', async () => {
    download(`lingo-reader-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await db.exportAll()), 'application/json');
  });
  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await db.importAll(JSON.parse(await file.text()));
      await loadSettings();
      await loadVocab();
      toast('Backup restored');
      location.hash = '#/library';
    } catch (err) {
      toast(`Could not restore: ${err.message}`, 5000);
    }
  });

  return () => { if ('speechSynthesis' in window) speechSynthesis.removeEventListener('voiceschanged', fillVoices); };
}
