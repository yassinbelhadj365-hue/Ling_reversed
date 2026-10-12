// The word/phrase panel: status buttons, your hint, dictionary results.
// Side sheet on desktop, bottom sheet on phones.
import { state, lang, getWord, setStatus, speak, esc } from './state.js';
import { lookup, externalLinks } from './dict.js';
import { NEW, KNOWN, IGNORED, isLearning } from './srs.js';

const panel = document.getElementById('word-panel');
let current = null; // {term, context, onChange, defs}

const STATUS_LABEL = { [NEW]: 'New word', 1: 'LingQ · level 1', 2: 'LingQ · level 2', 3: 'LingQ · level 3', 4: 'LingQ · level 4', [KNOWN]: 'Known', [IGNORED]: 'Ignored' };

export function openPanel(term, { context = '', onChange } = {}) {
  current = { term, context, onChange, defs: null };
  render();
  panel.hidden = false;
  loadDefs(term);
}

export function closePanel() {
  panel.hidden = true;
  current = null;
  document.querySelectorAll('.w.active').forEach((n) => n.classList.remove('active'));
}

export const panelTerm = () => current?.term ?? null;

function render() {
  const { term, context } = current;
  const w = getWord(term);
  const status = w?.status ?? NEW;
  const where = w?.freq
    ? ` · appears ${w.freq}× in ${w.lessons.length} lesson${w.lessons.length === 1 ? '' : 's'}`
    : '';
  const related = term.includes(' ')
    ? []
    : [...state.vocab.values()]
        .filter((x) => x.isPhrase && isLearning(x.status) && x.term.split(' ').includes(term))
        .slice(0, 5);

  panel.innerHTML = `
    <div class="row spread">
      <h2 class="panel-word" dir="auto">${esc(term)}</h2>
      <div class="row">
        <button class="btn small" data-act="speak" aria-label="Listen">🔊</button>
        <button class="btn small" data-act="close" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="muted small">${STATUS_LABEL[status]}${where}</div>
    <div class="status-row" role="group" aria-label="Set status">
      ${[1, 2, 3, 4].map((s) => `<button data-s="${s}" class="${status === s ? 'on' : ''}" title="LingQ level ${s} (key ${s})">${s}</button>`).join('')}
      <button data-s="${KNOWN}" class="${status === KNOWN ? 'on' : ''}" title="Known (key K)">✓ Known</button>
    </div>
    <div class="row">
      <button class="btn small" data-s="${IGNORED}" title="Ignore — names, typos (key X)">${status === IGNORED ? 'Ignored' : 'Ignore'}</button>
      ${status !== NEW ? `<button class="btn small" data-s="${NEW}">Reset to new</button>` : ''}
    </div>
    <div class="field" style="margin-top:12px">
      <label for="hint">Your meaning / hint</label>
      <textarea id="hint" rows="2" style="min-height:64px" placeholder="Type a meaning, or tap one below">${esc(w?.hint || '')}</textarea>
    </div>
    ${context ? `<p class="ctx" dir="auto">“${esc(context)}”</p>` : ''}
    ${related.length ? `<p class="small">In phrases: ${related.map((r) => `<button class="btn small" data-open="${esc(r.term)}">${esc(r.term)}</button>`).join(' ')}</p>` : ''}
    <h3 class="small muted">Dictionary</h3>
    <ul class="defs" id="defs">${defsHtml()}</ul>
    <p class="small">${externalLinks(term, lang(), state.settings.native)
      .map(([name, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${name}</a>`).join(' · ')}</p>`;
}

function defsHtml() {
  const defs = current.defs;
  if (!defs) return '<li class="muted">Looking up…</li>';
  if (!defs.length) return '<li class="muted">No results (offline, or not in the dictionary). Try the links below.</li>';
  return defs.map((d, i) => `<li data-def="${i}" title="Use as my hint"><span class="pos">${esc(d.source)} · ${esc(d.pos || '')}</span>${esc(d.text)}</li>`).join('');
}

async function loadDefs(term) {
  let results = [];
  try {
    results = await lookup(term, lang(), state.settings.native);
  } catch { /* offline: the panel says so */ }
  if (current?.term !== term) return;
  current.defs = results;
  const ul = panel.querySelector('#defs');
  if (ul) ul.innerHTML = defsHtml();
}

async function changeStatus(status) {
  const { term, context } = current;
  const w = getWord(term);
  await setStatus(term, status, { context: w?.context || context });
  afterChange();
}

// Writing or picking a meaning turns a new/known word into a LingQ (level 1),
// the same way LingQ does.
async function saveHint(text) {
  const { term, context } = current;
  const w = getWord(term);
  const status = w?.status ?? NEW;
  if (!text.trim() && !isLearning(status)) return;
  await setStatus(term, isLearning(status) ? status : 1, { hint: text.trim(), context: w?.context || context });
  afterChange();
}

function afterChange() {
  if (!current) return;
  const { term, onChange } = current;
  render();
  onChange?.(term);
}

panel.addEventListener('click', (e) => {
  if (!current) return;
  const t = e.target.closest('button, li[data-def]');
  if (!t) return;
  if (t.dataset.act === 'close') return closePanel();
  if (t.dataset.act === 'speak') return speak(current.term);
  if (t.dataset.open) return openPanel(t.dataset.open, { context: current.context, onChange: current.onChange });
  if (t.dataset.s !== undefined) return changeStatus(Number(t.dataset.s));
  if (t.dataset.def !== undefined) return saveHint(current.defs[Number(t.dataset.def)].text);
});

panel.addEventListener('change', (e) => {
  if (current && e.target.id === 'hint') saveHint(e.target.value);
});

document.addEventListener('keydown', (e) => {
  if (!current || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  const k = e.key.toLowerCase();
  if (['1', '2', '3', '4'].includes(k)) changeStatus(Number(k));
  else if (k === 'k') changeStatus(KNOWN);
  else if (k === 'x') changeStatus(IGNORED);
  else if (k === 'escape') closePanel();
  else return;
  e.preventDefault();
});
