import * as db from '../db.js';
import { state, LANGS, lang, saveSettings, loadSettings, loadVocab, toast, download, esc } from '../state.js';
import { onDeviceStatus, installOnDevice, aiStatus } from '../translate.js';
import { getKey, setKey, listModels, askStronger } from '../assist.js';
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
      <div class="field"><label for="dailyGoal">Daily goal (LingQs created)</label>
        <input id="dailyGoal" type="number" min="1" max="500" value="${s.dailyGoal}"></div>
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
      <h2 style="margin-top:0">Translation</h2>
      <p class="small muted">Tapping a word translates the whole sentence it’s in, so you see what it means <i>here</i>.</p>
      <div class="field"><label>On-device translator (Chrome on a computer)</label>
        <div class="row"><span id="od-status" class="small muted">Checking…</span>
          <button class="btn small" id="od-install" hidden>Download</button></div>
        <span class="small muted">Private, offline and unlimited. Other browsers and phones use MyMemory, a free online service.</span></div>
      <div class="field"><label for="translateEmail">Email for MyMemory (optional)</label>
        <input id="translateEmail" type="text" inputmode="email" autocomplete="email" value="${esc(s.translateEmail)}" placeholder="Leave empty to stay anonymous">
        <span class="small muted">MyMemory allows roughly 50 sentences a day without an email and about 10× more with one.
          The email is sent to MyMemory with each request; nothing else is.</span></div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">AI explanations (on-device)</h2>
      <p class="small muted">Chrome on a computer can use its built-in AI (Gemini Nano) to explain a word as it’s used in
        <i>this</i> sentence, with a short grammar note. It runs on your device: free, private and offline after a one-time download.
        Elsewhere, the free translation and dictionary layers are used.</p>
      <div class="row"><span class="small">Status:</span> <span id="ai-status" class="small muted">Checking…</span></div>
      <label class="row"><input type="checkbox" data-bool="aiAuto" ${s.aiAuto ? 'checked' : ''}>
        Explain automatically when I tap a word (otherwise there’s an Explain button)</label>
    </div>

    <div class="card">
      <h2 style="margin-top:0">“Still unclear?” — stronger AI help (free)</h2>
      <p class="small muted">When a word still doesn’t make sense, the word panel can ask a stronger AI. Nothing here costs money:</p>
      <ul class="small">
        <li><b>Ask DeepSeek ↗</b> and <b>Ask ChatGPT ↗</b> open their websites with your question ready (ChatGPT uses your own subscription). No setup.</li>
        <li><b>Ask in the app</b> uses a free model on OpenRouter. Create a free account at
          <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a> (no card needed), create a key and paste it here.
          Free models have daily limits, and only free models are offered.</li>
      </ul>
      <div class="field"><label for="or-key">OpenRouter key</label>
        <input id="or-key" type="password" autocomplete="off" placeholder="sk-or-…">
        <span class="small muted">Stored only in this browser, never included in backups, and sent only to openrouter.ai.</span></div>
      <div class="field"><label for="or-model">Free model</label>
        <select id="or-model"><option value="">Loading free models…</option></select></div>
      <div class="row"><button class="btn small" id="or-test">Test</button><span id="or-status" class="small muted"></span></div>
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
      <p class="small">Open this app in your phone’s browser, then use <b>Share → Add to Home Screen</b> (iPhone, Safari) or
        <b>⋮ → Install app</b> (Android, Chrome). It then opens full-screen and works offline, except for dictionary lookups.</p>
    </div>`;

  const $ = (sel) => view.querySelector(sel);
  const num = (el, min, max, fallback) => {
    const v = Number(el.value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };

  $('#native').addEventListener('change', (e) => saveSettings({ native: e.target.value }).then(() => toast('Saved')));
  $('#pageSize').addEventListener('change', (e) => saveSettings({ pageSize: num(e.target, 50, 2000, 250) }).then(() => toast('Saved')));
  $('#dailyGoal').addEventListener('change', (e) => saveSettings({ dailyGoal: num(e.target, 1, 500, 20) }).then(() => toast('Saved')));
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
  $('#translateEmail').addEventListener('change', (e) => saveSettings({ translateEmail: e.target.value.trim() }).then(() => toast('Saved')));

  const OD_TEXT = {
    available: 'Ready ✓', downloadable: 'Available to download', downloading: 'Downloading…',
    unavailable: 'Not available for this language pair', unsupported: 'Not supported in this browser',
  };
  async function showOnDevice() {
    const st = await onDeviceStatus(lang(), state.settings.native);
    $('#od-status').textContent = OD_TEXT[st] || st;
    $('#od-install').hidden = st !== 'downloadable';
  }
  $('#od-install').addEventListener('click', async () => {
    $('#od-install').disabled = true;
    try {
      await installOnDevice(lang(), state.settings.native, (p) => { $('#od-status').textContent = `Downloading… ${Math.round(p * 100)}%`; });
    } catch (err) {
      toast(`Download failed: ${err.message}`, 5000);
    }
    $('#od-install').disabled = false;
    showOnDevice();
  });
  showOnDevice();

  // ---- OpenRouter (free models only) ----
  getKey().then((k) => { $('#or-key').value = k; });
  $('#or-key').addEventListener('change', (e) => setKey(e.target.value).then(() => toast('Key saved')));
  listModels().then((models) => {
    const current = state.settings.assistModel;
    $('#or-model').innerHTML = models.length
      ? models.map((m, i) => `<option value="${esc(m.id)}" ${(current ? m.id === current : i === 0) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')
      : '<option value="">No free models available right now</option>';
  }).catch(() => { $('#or-model').innerHTML = '<option value="">Couldn’t load the model list (offline?)</option>'; });
  $('#or-model').addEventListener('change', (e) => saveSettings({ assistModel: e.target.value }).then(() => toast('Saved')));
  $('#or-test').addEventListener('click', async () => {
    $('#or-status').textContent = 'Asking…';
    try {
      const { result, model } = await askStronger({ term: 'casa', sentence: 'Mi casa es tu casa.', prev: '', next: '' });
      $('#or-status').textContent = `✓ Works (${model}): “${result.gloss_in_context}”`;
    } catch (err) {
      $('#or-status').textContent = err.message;
    }
  });

  aiStatus().then((st) => {
    $('#ai-status').textContent = {
      available: 'Ready ✓', downloadable: 'Available — downloads the first time you tap Explain',
      downloading: 'Downloading…', unavailable: 'Not available on this device', unsupported: 'Not supported in this browser',
    }[st] || st;
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
