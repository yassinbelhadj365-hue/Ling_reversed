import * as db from '../db.js';
import { state, LANGS, lang, saveSettings, loadSettings, loadVocab, toast, download, esc } from '../state.js';

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
      <label class="row"><input type="checkbox" id="pagingKnown" ${s.pagingKnown ? 'checked' : ''}>
        Turning a page marks blue words I didn’t tap as known</label>
      <p class="small muted">This is how LingQ grows your known-word count without extra clicks. Turn it off if you prefer to mark words yourself.</p>
      <div class="field"><label for="dailyGoal">Daily goal (LingQs created)</label>
        <input id="dailyGoal" type="number" min="1" max="500" value="${s.dailyGoal}"></div>
      <label class="row"><input type="checkbox" id="mergeCues" ${s.mergeCues ? 'checked' : ''}>
        Merge short caption lines into sentences when importing</label>
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
