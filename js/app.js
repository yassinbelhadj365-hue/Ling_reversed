import { LANGS, lang, loadSettings, saveSettings, loadVocab, toast } from './state.js';
import { closePanel } from './panel.js';
import { renderLibrary } from './views/library.js';
import { renderImport } from './views/import.js';
import { renderReader } from './views/reader.js';
import { renderReview } from './views/review.js';
import { renderVocab } from './views/vocab.js';
import { renderStats } from './views/stats.js';
import { renderSettings } from './views/settings.js';

const VIEWS = {
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

async function init() {
  await loadSettings();
  await loadVocab();

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

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode unavailable */ });
  }
  document.body.dataset.ready = '1';
}

init();
