import { LANGS, lang, loadSettings, saveSettings, loadVocab, toast } from './state.js';
import { closePanel } from './panel.js';
import { renderLibrary } from './views/library.js';
import { renderImport } from './views/import.js';
import { renderReader } from './views/reader.js';
import { renderReview } from './views/review.js';
import { renderVocab } from './views/vocab.js';
import { renderStats } from './views/stats.js';
import { renderSettings } from './views/settings.js';
import { renderAccount } from './views/account.js';
import * as db from './db.js';
import { activeAccount, startSync, onStatus } from './cloud.js';
import { startRelay } from './relay.js';

const VIEWS = {
  account: renderAccount,
  library: renderLibrary,
  import: renderImport,
  lesson: renderReader,
  review: renderReview,
  vocab: renderVocab,
  stats: renderStats,
  settings: renderSettings,
};

const view = document.getElementById('view');
const langSelect = document.getElementById('lang-select');
let cleanup = null;

async function route() {
  cleanup?.();
  cleanup = null;
  closePanel();
  if ('speechSynthesis' in window) speechSynthesis.cancel();

  const [name = 'library', arg] = location.hash.replace(/^#\/?/, '').split('/');
  const render = VIEWS[name] || renderLibrary;
  const tab = name === 'lesson' ? 'library' : name;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  langSelect.value = lang();

  view.innerHTML = '';
  try {
    cleanup = (await render(view, arg)) || null;
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty">Something went wrong: ${String(err.message || err)}</div>`;
  }
}

function showError(msg) {
  document.body.dataset.error = msg;
  toast(`Error: ${msg}`, 8000);
}
window.addEventListener('error', (e) => showError(e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason?.message || String(e.reason)));

// Sticky elements (the listen-mode player) sit just below the top bar.
function measureChrome() {
  const h = document.querySelector('.topbar').offsetHeight;
  document.documentElement.style.setProperty('--topbar-h', `${h}px`);
}

// Top-bar account button: name + a sync dot.
function showAccount(st) {
  const acc = activeAccount();
  const btn = document.getElementById('account-btn');
  btn.querySelector('.acc-name').textContent = acc ? acc.name : 'Guest';
  btn.dataset.sync = acc ? st?.state || 'off' : 'none';
  btn.title = acc ? `${acc.email} — ${st?.state === 'ok' ? 'synced' : st?.state || ''}${st?.error ? `: ${st.error}` : ''}` : 'Not synced — tap to create an account';
}

// Android "Share → Lingo Reader" opens ./?title=…&text=…&url=… (manifest share_target).
function takeShareTarget() {
  const q = new URLSearchParams(location.search);
  if (!q.has('text') && !q.has('url')) return;
  try {
    sessionStorage.setItem('lingo-share', JSON.stringify({ title: q.get('title') || '', text: q.get('text') || '', url: q.get('url') || '' }));
  } catch { /* storage blocked */ }
  history.replaceState(null, '', `${location.pathname}#/import`);
}

async function init() {
  takeShareTarget();
  measureChrome();
  window.addEventListener('resize', measureChrome);
  const account = activeAccount();
  db.useDatabase(account?.id || null); // each account has its own local database
  await loadSettings();
  await loadVocab();
  showAccount();
  onStatus(showAccount);
  if (account) {
    // Get other devices' changes before showing anything (but don't wait long when offline).
    await Promise.race([
      startSync({
        onRemoteChange: async () => {
          await loadSettings();
          await loadVocab();
          const name = location.hash.split('/')[1];
          if (['lesson', 'import', 'review'].includes(name)) toast('Synced changes from your other device');
          else route();
        },
      }),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    await loadSettings();
    await loadVocab();
    // Imports a phone asked this computer to do, and lessons coming back to the phone.
    startRelay({ onChange: () => { if (/^#\/library/.test(location.hash) || !location.hash) route(); } });
  }

  langSelect.innerHTML = LANGS.map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
  langSelect.value = lang();
  langSelect.addEventListener('change', async () => {
    await saveSettings({ lang: langSelect.value });
    await loadVocab();
    if (location.hash === '#/library') route();
    else location.hash = '#/library';
  });

  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/library';
  else route();

  // The phone app ships its files inside the app, so it needs no offline cache.
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.Capacitor?.isNativePlatform?.()) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode unavailable */ });
  }
  document.body.dataset.ready = '1';
}

init();
