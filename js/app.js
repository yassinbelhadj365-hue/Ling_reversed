import { state, LANGS, lang, loadSettings, saveSettings, loadVocab, toast } from './state.js';
import { isLearning } from './srs.js';
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
import { warmUp } from './ai.js';

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

// Each screen comes back where you left it (the Library after a lesson, a long vocab list);
// a redraw of the same screen (after a sync) keeps its place. Lessons place themselves.
const scrolls = new Map(); // hash -> scrollY
let shownHash = null;
let routeRun = 0; // the newest route() call
let renderedRun = 0; // the newest one that finished

async function route() {
  cleanup?.();
  cleanup = null;
  closePanel();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (shownHash) scrolls.set(shownHash, window.scrollY);
  shownHash = location.hash;

  const [name = 'library', arg] = location.hash.replace(/^#\/?/, '').split('/');
  const render = VIEWS[name] || renderLibrary;
  const tab = name === 'lesson' ? 'library' : name;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  langSelect.value = lang();

  const hash = location.hash;
  // Two renders can overlap (a sync redraws the Library while you open a lesson): only the
  // newest one counts; an older one that finishes later cleans up after itself (players, timers).
  const run = ++routeRun;
  view.innerHTML = '';
  let done = null;
  try {
    done = (await render(view, arg)) || null;
  } catch (err) {
    console.error(err);
    if (run === routeRun) view.innerHTML = `<div class="empty">Something went wrong: ${String(err.message || err)}</div>`;
  }
  if (run !== routeRun) {
    done?.();
    if (renderedRun === routeRun) route(); // it drew over the newer screen: draw that again
    return;
  }
  renderedRun = run;
  cleanup = done;
  if (name !== 'lesson' && location.hash === hash && !arg) window.scrollTo(0, scrolls.get(hash) || 0);
  showDueCount();
}

// The Review tab shows how many cards are due, so there's no need to open it to find out.
function showDueCount() {
  const now = Date.now();
  let n = 0;
  for (const w of state.vocab.values()) if (isLearning(w.status) && (w.srs?.due ?? 0) <= now) n++;
  const tab = document.querySelector('.tabbar [data-tab="review"]');
  if (tab) tab.dataset.count = n > 99 ? '99+' : n ? String(n) : '';
}
let dueTimer = null;
const showDueCountSoon = () => { clearTimeout(dueTimer); dueTimer = setTimeout(showDueCount, 300); };

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
  document.addEventListener('lingo-db-blocked', () => toast('Close Lingo Reader in your other tabs or windows to finish updating.', 10000));
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
    // The app opens at once from this device's data; other devices' changes arrive in the
    // background and quietly redraw the Library, Vocab or Stats (a lesson or review in
    // progress is left alone: their words are already updated in memory).
    startSync({
      onRemoteChange: async () => {
        await loadSettings();
        await loadVocab();
        showDueCountSoon();
        const name = location.hash.split('/')[1] || 'library';
        if (['library', 'vocab', 'stats'].includes(name)) route();
      },
    }).catch(() => { /* offline: the account button shows it */ });
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
  warmUp().catch(() => {}); // the first word tap shouldn't wait for setup
  // Installed on the home screen: ask the system to keep this app's data even when storage runs
  // low (iOS honours it; browsers in a tab may show a prompt, so only here).
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) navigator.storage?.persist?.().catch(() => {});
  db.onChange((store) => { if (store === 'words') showDueCountSoon(); });
  setInterval(showDueCount, 60_000); // cards become due as time passes
  document.body.dataset.ready = '1';
}

init();
