// The word/phrase panel: status buttons, your hint, dictionary results.
// Side sheet on desktop, bottom sheet on phones.
import { state, lang, getWord, setStatus, saveWord, undoAuto, speak, esc } from './state.js';
import { lookup, externalLinks } from './dict.js';
import { NEW, KNOWN, IGNORED, isLearning } from './srs.js';
import { progress } from './knowledge.js';
import { translateSentence, sentenceLinks, ERROR_TEXT } from './translate.js';

const UNDO_WINDOW = 10 * 60 * 1000;

const panel = document.getElementById('word-panel');
// {term, context, mark: [start, end] of the word within context, onChange, onClose, defs, tr}
let current = null;

const STATUS_LABEL = { [NEW]: 'New word', 1: 'LingQ · level 1', 2: 'LingQ · level 2', 3: 'LingQ · level 3', 4: 'LingQ · level 4', [KNOWN]: 'Known', [IGNORED]: 'Ignored' };

export function openPanel(term, { context = '', mark = null, onChange, onClose } = {}) {
  current = { term, context, mark, onChange, onClose, defs: null, tr: null };
  render();
  panel.hidden = false;
  rememberContext();
  loadDefs(term);
  loadSentence(term, context);
}

// LingQs keep the sentence they were met in (and its translation) for flashcards.
async function rememberContext() {
  const { term, context, tr } = current;
  const w = getWord(term);
  if (!w || !isLearning(w.status) || !context) return;
  if (!w.context) { w.context = context; w.contextTr = tr?.text || ''; await saveWord(w); }
  else if (w.context === context && !w.contextTr && tr?.text) { w.contextTr = tr.text; await saveWord(w); }
}

async function loadSentence(term, context) {
  if (!context) return;
  let tr;
  try { tr = await translateSentence(context, lang(), state.settings.native); } catch { tr = { error: 'unavailable' }; }
  if (current?.term !== term) return;
  current.tr = tr || { error: 'unavailable' };
  const el = panel.querySelector('#ctx-tr');
  if (el) el.outerHTML = trHtml();
  rememberContext();
}

function sentenceHtml() {
  const { context, mark } = current;
  if (!context) return '';
  const body = mark
    ? `${esc(context.slice(0, mark[0]))}<mark>${esc(context.slice(mark[0], mark[1]))}</mark>${esc(context.slice(mark[1]))}`
    : esc(context);
  return `
    <div class="ctx-block">
      <div class="small muted">In this sentence</div>
      <p class="ctx-sentence" dir="auto">${body}</p>
      ${trHtml()}
      <p class="small">Open the sentence in ${sentenceLinks(context, lang(), state.settings.native)
        .map(([name, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${name}</a>`).join(' · ')}</p>
    </div>`;
}

function trHtml() {
  const tr = current.tr;
  if (!tr) return '<p class="ctx-tr muted" id="ctx-tr">Translating…</p>';
  if (tr.error) return `<p class="ctx-tr muted small" id="ctx-tr">${ERROR_TEXT[tr.error] || ERROR_TEXT.unavailable}</p>`;
  return `<p class="ctx-tr" id="ctx-tr" dir="auto">${esc(tr.text)} <span class="badge">${esc(tr.source)}</span></p>`;
}

export function closePanel() {
  const onClose = current?.onClose;
  panel.hidden = true;
  current = null;
  document.querySelectorAll('.w.active').forEach((n) => n.classList.remove('active'));
  onClose?.();
}

export const panelTerm = () => current?.term ?? null;

function render() {
  const { term } = current;
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
    ${autoLine(w)}
    <div class="status-row" role="group" aria-label="Set status">
      ${[1, 2, 3, 4].map((s) => `<button data-s="${s}" class="${status === s ? 'on' : ''}" title="LingQ level ${s} (key ${s})">${s}</button>`).join('')}
      <button data-s="${KNOWN}" class="${status === KNOWN ? 'on' : ''}" title="Known (key K)">✓ Known</button>
    </div>
    <div class="row">
      <button class="btn small" data-s="${IGNORED}" title="Ignore — names, typos (key X)">${status === IGNORED ? 'Ignored' : 'Ignore'}</button>
      ${status !== NEW ? `<button class="btn small" data-s="${NEW}">Reset to new</button>` : ''}
    </div>
    ${sentenceHtml()}
    <div class="field" style="margin-top:12px">
      <label for="hint">Your meaning / hint</label>
      <textarea id="hint" rows="2" style="min-height:64px" placeholder="Type a meaning, or tap one below">${esc(w?.hint || '')}</textarea>
    </div>
    ${related.length ? `<p class="small">In phrases: ${related.map((r) => `<button class="btn small" data-open="${esc(r.term)}">${esc(r.term)}</button>`).join(' ')}</p>` : ''}
    <h3 class="small muted">Dictionary</h3>
    <ul class="defs" id="defs">${defsHtml()}</ul>
    <p class="small">${externalLinks(term, lang(), state.settings.native)
      .map(([name, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${name}</a>`).join(' · ')}</p>`;
}

function autoLine(w) {
  if (!w?.ev || !state.settings.autoStatus) return '';
  const parts = [w.ev.src === 'manual' ? 'Set by you' : 'Auto · from your reading'];
  if (isLearning(w.status)) {
    const p = progress(w, state.settings.autoPace);
    parts.push(`${Math.min(p.done, p.total)} / ${p.total} encounters toward known`);
  }
  const undo = w.ev.prev && Date.now() - (w.ev.autoAt || 0) < UNDO_WINDOW
    ? `<button class="btn small" data-act="undo" title="Undo the last automatic change">Undo</button>` : '';
  return `<div class="auto-line"><span>${parts.join(' · ')}</span>${undo}</div>`;
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
  await setStatus(term, status, { context: w?.context || context }, { manual: true });
  afterChange();
}

async function undo() {
  await undoAuto(current.term);
  afterChange();
}

// Writing or picking a meaning turns a new/known word into a LingQ (level 1),
// the same way LingQ does.
async function saveHint(text) {
  const { term, context } = current;
  const w = getWord(term);
  const status = w?.status ?? NEW;
  if (!text.trim() && !isLearning(status)) return;
  if (isLearning(status)) await setStatus(term, status, { hint: text.trim(), context: w?.context || context });
  else await setStatus(term, 1, { hint: text.trim(), context: w?.context || context }, { manual: true });
  afterChange();
}

function afterChange() {
  if (!current) return;
  const { term, onChange } = current;
  render();
  rememberContext();
  onChange?.(term);
}

panel.addEventListener('click', (e) => {
  if (!current) return;
  const t = e.target.closest('button, li[data-def]');
  if (!t) return;
  if (t.dataset.act === 'close') return closePanel();
  if (t.dataset.act === 'speak') return speak(current.term);
  if (t.dataset.act === 'undo') return undo();
  if (t.dataset.open) return openPanel(t.dataset.open, { context: current.context, onChange: current.onChange, onClose: current.onClose });
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
