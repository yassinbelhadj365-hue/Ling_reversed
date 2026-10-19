import * as db from '../db.js';
import { state, LANGS, lang, langName, saveSettings, loadSettings, loadVocab, toast, download, esc } from '../state.js';
import { getKey, listModels, PROVIDERS, getProviderKey, setProviderKey, keyKind, testProvider, sharedStatus, dashboardUrl,
  keysSynced, setKeysSynced } from '../ai.js';
import { activeAccount, isSignedIn } from '../cloud.js';
import { hash32 } from '../text.js';
import { explain } from '../explain.js';
import { MODELS as ASR_MODELS } from '../asr.js';

const langOptions = (selected) =>
  LANGS.map(([code, name]) => `<option value="${code}" ${code === selected ? 'selected' : ''}>${name}</option>`).join('');

export async function renderSettings(view, arg) {
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

    ${aiCardHtml(s)}

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

  const stopAi = initAiCard(view, arg);
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

  return () => { stopAi(); if ('speechSynthesis' in window) speechSynthesis.removeEventListener('voiceschanged', fillVoices); };
}

// ---------- the AI card: Gemini, then the Mistral and Groq backups, then the shared server ----------
// Getting a key is: tap "Get a free key", copy it on that site, come back, tap "Paste a key".
// The app tells from the key's look which AI it belongs to, saves it and checks it at once.

const STEPS = {
  gemini: ['Sign in with your Google account.', 'Tap <b>Create API key</b> (any project is fine).', 'Copy the key (it starts with <b>AIza</b>).'],
  mistral: ['Sign up or sign in (a Google account works).', 'Choose the free <b>Experiment</b> plan; it may ask to verify your phone number.',
    'Tap <b>Create new key</b> and copy it.'],
  groq: ['Sign in (a Google account works).', 'Tap <b>Create API Key</b> and give it any name.', 'Copy the key (it starts with <b>gsk_</b>).'],
};
const ROLE = { gemini: 'main AI', mistral: 'answers when Google is busy', groq: 'second backup' };
const providerName = (id) => PROVIDERS.find((p) => p.id === id)?.name || id;

function aiCardHtml(s) {
  return `
    <div class="card" id="ai-card">
      <h2 style="margin-top:0">AI for translations</h2>
      <p class="small muted">Each tap asks a free AI what the word means in its sentence. Gemini answers first; Mistral and Groq
        answer when Google is busy. All three are free with no card and take about a minute each.</p>
      <div class="row"><button class="btn primary" id="key-paste">📋 Paste a key</button>
        <span class="small muted" id="key-paste-st">Copied a key? Tap here: the app sees which AI it’s for and checks it.</span></div>
      ${PROVIDERS.map((p, i) => `
      <div class="ai-row" data-p="${p.id}">
        <div class="row"><b>${i + 1}. ${esc(p.name)}</b><span class="small muted">${ROLE[p.id]}</span>
          <span class="ai-st small" id="st-${p.id}"></span></div>
        <details class="small"><summary>How to get the key</summary><ol>${STEPS[p.id].map((t) => `<li>${t}</li>`).join('')}</ol></details>
        <div class="row">
          <a class="btn small" href="${p.keyUrl}" target="_blank" rel="noopener" data-get="${p.id}">Get a free key ↗</a>
          <input type="password" autocomplete="off" data-key="${p.id}" placeholder="…or paste it here" aria-label="${esc(p.name)} key">
          <button class="btn small" data-test="${p.id}">Test</button>
        </div>
      </div>`).join('')}
      <label class="row ai-row" id="keysync-row" hidden><span><input type="checkbox" id="keysync">
        Use these keys on all my devices: paste them once, and your phone and computer get them when they sync</span></label>
      <div class="ai-row" id="shared-row" hidden></div>
      <div class="field" style="margin-top:12px"><label for="gm-model">Gemini model</label>
        <select id="gm-model"><option value="">Automatic (newest free Flash model)</option></select>
        <span class="small muted">The list needs your Gemini key. When this model’s free limit is used up or Google is busy, the other free Flash models answer by themselves, then Gemma (weaker, but rarely busy), then your backups.</span></div>
      <label class="row"><input type="checkbox" data-bool="aiAuto" ${s.aiAuto ? 'checked' : ''}>
        Ask automatically when I tap (otherwise there’s an Explain button, which saves the daily limit)</label>
      <div class="row"><button class="btn small" id="gm-test">Test a lookup</button><span id="gm-status" class="small muted"></span></div>
      <p class="small muted">“More” in the word panel asks the same AI for a longer answer. It can also open DeepSeek or ChatGPT
        (your own subscription) with the question ready.</p>
    </div>`;
}

function initAiCard(view, arg) {
  const $ = (sel) => view.querySelector(sel);
  if (arg === 'ai') $('#ai-card').scrollIntoView();
  let waiting = null; // the provider whose key page was just opened

  const show = (id, st) => {
    const el = $(`#st-${id}`);
    el.className = `ai-st small ${st.ok ? 'good' : st.ok === false ? 'bad' : 'muted'}`;
    el.textContent = `${st.ok ? '✓ ' : st.ok === false ? '✗ ' : ''}${st.msg}`;
  };
  async function refresh(id) {
    const key = await getProviderKey(id);
    view.querySelector(`[data-key="${id}"]`).value = key;
    view.querySelector(`[data-p="${id}"] details`).open = !key && id === 'gemini';
    const last = await db.getSetting(`local:aitest:${id}`, null);
    show(id, !key ? { msg: 'Not set up' } : last?.key === hash32(key) ? last : { msg: 'Saved, not checked yet' });
  }
  async function check(id) {
    const key = await getProviderKey(id);
    if (!key) return refresh(id);
    show(id, { msg: 'Checking…' });
    const r = await testProvider(id, key);
    await db.setSetting(`local:aitest:${id}`, { ...r, key: hash32(key) });
    show(id, r);
    if (id === 'gemini') { fillModels(); showShared(); }
  }
  // Saves a key with the provider it belongs to (a Groq key pasted in the Gemini box goes to Groq).
  async function save(text, into) {
    const kind = keyKind(text) || into;
    await setProviderKey(kind, text);
    await refresh(kind);
    if (text.trim()) await check(kind);
    return kind;
  }

  // Keys follow the account to its other devices (on unless turned off). Opening this card also
  // shares keys typed before that existed.
  const acc = activeAccount();
  if (acc && isSignedIn(acc)) {
    $('#keysync-row').hidden = false;
    keysSynced().then(async (on) => {
      $('#keysync').checked = on;
      if (on) await setKeysSynced(true);
    });
    $('#keysync').addEventListener('change', async (e) => {
      await setKeysSynced(e.target.checked);
      PROVIDERS.forEach((p) => refresh(p.id));
      toast(e.target.checked ? 'Your keys will reach your other devices when they sync' : 'Keys now stay on each device');
    });
  }

  PROVIDERS.forEach((p) => refresh(p.id));
  view.querySelectorAll('[data-key]').forEach((el) => el.addEventListener('change', async () => {
    const into = el.dataset.key;
    const kind = await save(el.value, into);
    if (kind !== into) {
      el.value = await getProviderKey(into);
      toast(`That’s a ${providerName(kind)} key: saved there.`);
    }
  }));
  view.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => check(b.dataset.test)));
  view.querySelectorAll('[data-get]').forEach((a) => a.addEventListener('click', () => {
    waiting = a.dataset.get;
    $('#key-paste-st').textContent = `When you’ve copied the ${providerName(waiting)} key, come back here and tap Paste a key.`;
    $('#key-paste').classList.add('pulse');
  }));
  // Coming back from the key page: put the Paste button in view.
  const onVisible = () => { if (document.visibilityState === 'visible' && waiting) $('#key-paste').scrollIntoView({ block: 'center' }); };
  document.addEventListener('visibilitychange', onVisible);

  $('#key-paste').addEventListener('click', async () => {
    const st = $('#key-paste-st');
    let clip = '';
    try { clip = (await navigator.clipboard.readText()).trim(); } catch { /* refused or unsupported */ }
    if (!clip) { st.textContent = 'Couldn’t read the clipboard: long-press a key box below and choose Paste.'; return; }
    // A key of an unknown shape is accepted for the provider whose page was just opened.
    const kind = keyKind(clip) || (waiting && clip.length >= 20 && !/\s/.test(clip) ? waiting : null);
    if (!kind) { st.textContent = 'The copied text doesn’t look like a Gemini, Mistral or Groq key. Copy the key itself and try again.'; return; }
    $('#key-paste').classList.remove('pulse');
    st.textContent = `${providerName(kind)} key found. Checking it…`;
    await save(clip, kind);
    st.textContent = `${providerName(kind)} key saved.${kind === 'gemini' ? ' Want a backup for busy times? Get a Mistral key next.' : ''}`;
    waiting = null;
  });

  // The shared AI on the sync server: its state and, if needed, the steps to deploy or update it.
  const code = fetch('./supabase/functions/ai/index.ts', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { toast(`Couldn’t copy the ${what.toLowerCase()}.`); }
  }
  async function showShared() {
    const row = $('#shared-row');
    const st = await sharedStatus();
    if (!row.isConnected) return;
    row.hidden = st === 'none';
    if (st === 'none') return;
    const fn = dashboardUrl('/functions') || 'https://supabase.com/dashboard';
    const secrets = dashboardUrl('/functions/secrets') || 'https://supabase.com/dashboard';
    const label = { ok: '✓ Up to date', old: '⚠ Needs updating', nokey: '⚠ Its Gemini key is missing', missing: 'Not set up' }[st];
    const steps = [];
    if (st === 'missing' || st === 'old') {
      steps.push('<button class="btn small" data-copy="code">Copy the code</button>');
      steps.push(`<a class="btn small" href="${fn}" target="_blank" rel="noopener">Open Supabase ↗</a> ${st === 'old'
        ? 'open the function <b>ai</b> → <b>Code</b>, select everything, paste, then <b>Deploy</b>.'
        : '<b>Deploy a new function</b> → <b>Via Editor</b>, name it <b>ai</b>, replace the example with what you copied, then <b>Deploy</b>.'}`);
    }
    if (st === 'missing' || st === 'nokey') {
      steps.push(`<button class="btn small" data-copy="key">Copy your Gemini key</button> <a class="btn small" href="${secrets}" target="_blank" rel="noopener">Open Secrets ↗</a>
        add a secret named <b>GEMINI_API_KEY</b> and paste the key.`);
    }
    if (steps.length) steps.push('<button class="btn small" data-recheck>Check again</button>');
    row.innerHTML = `
      <div class="row"><b>Shared AI on your sync server</b><span class="small muted">works on any device you log in to, no key needed</span>
        <span class="ai-st small ${st === 'ok' ? 'good' : 'bad'}">${label}</span></div>
      ${steps.length ? `<ol class="small">${steps.map((t) => `<li>${t}</li>`).join('')}</ol>` : ''}`;
    row.querySelector('[data-copy="code"]')?.addEventListener('click', async () => {
      const text = await code;
      if (!text) return toast('Couldn’t load the code: open supabase/functions/ai/index.ts in the project.', 6000);
      copy(text, 'Code');
    });
    row.querySelector('[data-copy="key"]')?.addEventListener('click', async () => {
      const key = await getKey();
      if (!key) return toast('Add your Gemini key above first.');
      copy(key, 'Key');
    });
    row.querySelector('[data-recheck]')?.addEventListener('click', showShared);
  }
  showShared();

  async function fillModels() {
    const key = await getKey();
    const chosen = state.settings.geminiModel;
    let models = [];
    if (key) try { models = await listModels(key); } catch { /* offline or bad key: its status says which */ }
    if (chosen && !models.some((m) => m.id === chosen)) models.unshift({ id: chosen, name: chosen });
    if (!$('#gm-model')) return;
    $('#gm-model').innerHTML = '<option value="">Automatic (newest free Flash model)</option>' +
      models.map((m) => `<option value="${esc(m.id)}" ${m.id === chosen ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  }
  fillModels();
  $('#gm-model').addEventListener('change', (e) => saveSettings({ geminiModel: e.target.value }).then(() => toast('Saved')));
  $('#gm-test').addEventListener('click', async () => {
    $('#gm-status').textContent = 'Asking…';
    try {
      const { result, source } = await explain({ kind: 'word', term: 'casa', sentence: 'Mi casa es tu casa.', transcript: '' }, { fresh: true });
      $('#gm-status').textContent = `✓ Works (${source}): “${result.meaning_native || result.translation || ''}”`;
    } catch (err) {
      $('#gm-status').textContent = err.message === 'no-provider' ? 'No AI yet: paste a key above, or log in to your account.' : err.message;
    }
  });

  return () => document.removeEventListener('visibilitychange', onVisible);
}
