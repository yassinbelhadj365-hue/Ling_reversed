// The word/phrase panel: status buttons, your hint, dictionary results.
// Side sheet on desktop, bottom sheet on phones.
import { state, lang, getWord, setStatus, saveWord, undoAuto, speak, esc } from './state.js';
import { lookup, lookupExpression, externalLinks } from './dict.js';
import { NEW, KNOWN, IGNORED, isLearning } from './srs.js';
import { progress } from './knowledge.js';
import { translateSentence, rankByContext, sentenceLinks, ERROR_TEXT } from './translate.js';
import { expressionCandidates } from './text.js';

const UNDO_WINDOW = 10 * 60 * 1000;

const panel = document.getElementById('word-panel');
// {term, context, mark: [start, end] of the word within context, onChange, onClose, defs, tr}
let current = null;

const STATUS_LABEL = { [NEW]: 'New word', 1: 'LingQ · level 1', 2: 'LingQ · level 2', 3: 'LingQ · level 3', 4: 'LingQ · level 4', [KNOWN]: 'Known', [IGNORED]: 'Ignored' };

export function openPanel(term, { context = '', mark = null, onChange, onClose } = {}) {
  current = { term, context, mark, onChange, onClose, defs: null, tr: null, expr: null, list: [] };
  render();
  panel.hidden = false;
  rememberContext();
  loadDefs(term);
  loadSentence(term, context);
  loadExpression(term, context, mark);
}

// Re-render the parts that fill in asynchronously (translation, dictionary, expression).
function refreshDynamic() {
  const tr = panel.querySelector('#ctx-tr');
  if (tr) tr.outerHTML = trHtml();
  const area = panel.querySelector('#dict-area');
  if (area) area.innerHTML = dictAreaHtml();
}

async function loadExpression(term, context, mark) {
  if (!context || !mark || term.includes(' ')) return;
  const cands = expressionCandidates(context, mark[0], lang());
  const found = await Promise.all(cands.map((c) => lookupExpression(c.surface, lang()).catch(() => [])));
  const k = found.findIndex((defs) => defs.length);
  if (current?.term !== term || k === -1) return;
  current.expr = { ...cands[k], defs: found[k] };
  refreshDynamic();
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
  refreshDynamic();
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
  // Highlight the translated word that the "meaning here" matched.
  const match = ranked().find((d) => d.fits)?.match;
  let body = esc(tr.text);
  if (match) {
    const re = new RegExp(`(^|[^\\p{L}])(${match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=[^\\p{L}]|$)`, 'giu');
    body = body.replace(re, '$1<mark>$2</mark>');
  }
  return `<p class="ctx-tr" id="ctx-tr" dir="auto">${body} <span class="badge">${esc(tr.source)}</span></p>`;
}

function ranked() {
  return current.defs ? rankByContext(current.defs, current.tr?.text, state.settings.native) : [];
}

function dictAreaHtml() {
  const { term, defs, expr } = current;
  const list = ranked();
  current.list = list;
  const parts = [];
  const form = list.find((d) => d.formOf);
  if (form) {
    const lemmaDef = list.find((d) => d.lemma === form.formOf);
    parts.push(`<div class="dict-line"><span class="small muted">Form</span>
      <div><i dir="auto">${esc(term)}</i> — ${esc(form.text)}${lemmaDef ? `<br><b dir="auto">${esc(form.formOf)}</b>: ${esc(lemmaDef.text)}` : ''}</div>
      <button class="btn small" data-open="${esc(form.formOf)}">Open “${esc(form.formOf)}”</button></div>`);
  }
  const here = list.find((d) => d.fits);
  if (here) {
    parts.push(`<div class="dict-line meaning-here"><span class="small muted">Meaning here</span>
      <div><b dir="auto">${esc(here.text)}</b> <span class="badge">fits this sentence</span></div>
      <button class="btn small" data-def="${list.indexOf(here)}">Use as hint</button></div>`);
  }
  if (expr) {
    parts.push(`<div class="dict-line"><span class="small muted">Expression</span>
      <div><b dir="auto">${esc(expr.surface)}</b> — ${esc(expr.defs[0].text)}</div>
      <button class="btn small" data-act="save-expr">Save as phrase</button></div>`);
  }
  let items;
  if (!defs) items = '<li class="muted">Looking up…</li>';
  else if (!list.length) items = '<li class="muted">No results (offline, or not in the dictionary). Try the links below.</li>';
  else {
    items = list.map((d, i) => `<li data-def="${i}" title="Use as my hint" class="${d.fits ? 'fits' : ''}">
      <span class="pos">${esc(d.source)} · ${esc(d.pos || '')}${d.lemma ? ` · ${esc(d.lemma)}` : ''}${d.fits ? ' · fits this sentence' : ''}</span>${esc(d.text)}</li>`).join('');
  }
  return `${parts.join('')}<h3 class="small muted">Dictionary</h3><ul class="defs" id="defs">${items}</ul>`;
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
    <div id="dict-area">${dictAreaHtml()}</div>
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

async function loadDefs(term) {
  let results = [];
  try {
    results = await lookup(term, lang(), state.settings.native);
  } catch { /* offline: the panel says so */ }
  if (current?.term !== term) return;
  current.defs = results;
  refreshDynamic();
}

// Save the detected expression as a phrase LingQ (underlined in the reader).
async function saveExpression() {
  const { expr, context } = current;
  const term = expr.terms.join(' ');
  await setStatus(term, 1, { hint: expr.defs[0].text, context }, { manual: true });
  current.onChange?.(term);
  openPanel(term, { context, onChange: current.onChange, onClose: current.onClose });
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
  if (t.dataset.act === 'save-expr') return saveExpression();
  if (t.dataset.open) return openPanel(t.dataset.open, { context: current.context, onChange: current.onChange, onClose: current.onClose });
  if (t.dataset.s !== undefined) return changeStatus(Number(t.dataset.s));
  if (t.dataset.def !== undefined) return saveHint(current.list[Number(t.dataset.def)].text);
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
