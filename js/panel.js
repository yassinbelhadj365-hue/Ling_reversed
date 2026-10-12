// The word / phrase / selection panel. Side sheet on desktop, bottom sheet on phones.
//
// Order of help, following the direct method: first an explanation in the language
// you're learning (simple words, examples), then — only when you press "Show English" —
// translations, English explanations and the bilingual dictionary.
import { state, lang, langName, getWord, setStatus, saveWord, undoAuto, speak, esc, toast, statusOf } from './state.js';
import { lookup, lookupExpression, externalLinks } from './dict.js';
import { NEW, KNOWN, IGNORED, isLearning } from './srs.js';
import { progress } from './knowledge.js';
import { translateSentence, rankByContext, sentenceLinks, ERROR_TEXT } from './translate.js';
import { expressionCandidates, tokenize, sentenceAt } from './text.js';
import { explain } from './explain.js';
import { openChatGpt, openDeepSeek, copyText } from './assist.js';

const UNDO_WINDOW = 10 * 60 * 1000;
const STATUS_LABEL = { [NEW]: 'New word', 1: 'LingQ · level 1', 2: 'LingQ · level 2', 3: 'LingQ · level 3', 4: 'LingQ · level 4', [KNOWN]: 'Known', [IGNORED]: 'Ignored' };

const panel = document.getElementById('word-panel');
let current = null;

// mode: 'word' (a word or phrase) | 'selection' (a sentence or longer passage).
// context: the sentence (word mode) or the selected text; mark: [start, end] of the word in it.
// around: {prev, next} neighbouring lines. transcript: the whole lesson text, for AI context.
// flag: a transcript flag on this word {said, heard, manual, replace(), dismiss(), edit()}.
// onFlag: marks this text as wrong in the transcript.
export function openPanel(term, {
  mode = 'word', context = '', mark = null, around = {}, flag = null, transcript = '', onFlag = null, onChange, onClose,
} = {}) {
  current = {
    term, mode, context, mark, around, flag, transcript, onFlag, onChange, onClose,
    showEnglish: !!state.settings.showEnglish,
    defs: null, tr: null, expr: null, list: [],
    explain: null, deep: null, handoff: null,
  };
  render();
  panel.hidden = false;
  loadSentence();
  loadExplain();
  if (mode === 'word') {
    rememberContext();
    loadDefs();
    loadExpression();
  }
}

export function closePanel() {
  const onClose = current?.onClose;
  panel.hidden = true;
  current = null;
  document.querySelectorAll('.w.active').forEach((n) => n.classList.remove('active'));
  onClose?.();
}

export const panelTerm = () => current?.term ?? null;

const stillOpen = (snapshot) => current && current === snapshot;
const L = () => langName(lang());
const N = () => langName(state.settings.native);

// ---------- loading ----------

function aiInput() {
  return { kind: current.mode === 'selection' ? 'passage' : 'word', term: current.term, sentence: current.context, transcript: current.transcript };
}

// depth 'quick' fills the main explanation; 'deep' is the "Still unclear?" answer.
async function loadExplain({ depth = 'quick', force = false } = {}) {
  const me = current;
  if (!me.context) return;
  const slot = depth === 'quick' ? 'explain' : 'deep';
  if (depth === 'quick' && !state.settings.aiAuto && !force) { me.explain = { state: 'idle' }; return renderDynamic(); }
  me[slot] = { state: 'loading' };
  renderDynamic();
  try {
    const v = await explain(aiInput(), {
      depth,
      onProgress: (p) => { if (stillOpen(me)) { me[slot] = { state: 'loading', progress: p }; renderDynamic(); } },
    });
    if (!stillOpen(me)) return;
    me[slot] = { state: 'done', ...v };
  } catch (err) {
    if (!stillOpen(me)) return;
    me[slot] = err.message === 'no-provider' ? { state: 'none' } : { state: 'error', msg: err.message };
  }
  renderDynamic();
}

async function loadSentence() {
  const me = current;
  if (!me.context) return;
  let tr;
  try { tr = await translateSentence(me.context, lang(), state.settings.native); } catch { tr = { error: 'unavailable' }; }
  if (!stillOpen(me)) return;
  me.tr = tr || { error: 'unavailable' };
  renderDynamic();
  rememberContext();
}

async function loadDefs() {
  const me = current;
  let results = [];
  try { results = await lookup(me.term, lang(), state.settings.native); } catch { /* offline: the panel says so */ }
  if (!stillOpen(me)) return;
  me.defs = results;
  renderDynamic();
}

async function loadExpression() {
  const me = current;
  if (!me.context || !me.mark || me.term.includes(' ')) return;
  const cands = expressionCandidates(me.context, me.mark[0], lang());
  const found = await Promise.all(cands.map((c) => lookupExpression(c.surface, lang()).catch(() => [])));
  const k = found.findIndex((defs) => defs.length);
  if (!stillOpen(me) || k === -1) return;
  me.expr = { ...cands[k], defs: found[k] };
  renderDynamic();
}

// LingQs keep the sentence they were met in (and its translation) for flashcards.
async function rememberContext() {
  if (!current || current.mode !== 'word') return;
  const { term, context, tr } = current;
  const w = getWord(term);
  if (!w || !isLearning(w.status) || !context) return;
  if (!w.context) { w.context = context; w.contextTr = tr?.text || ''; await saveWord(w); }
  else if (w.context === context && !w.contextTr && tr?.text) { w.contextTr = tr.text; await saveWord(w); }
}

// ---------- rendering ----------

function render() {
  const head = (title, cls = '') => `
    <div class="row spread">
      <h2 class="panel-word ${cls}" dir="auto">${esc(title)}</h2>
      <div class="row">
        <button class="btn small" data-act="speak" aria-label="Listen">🔊</button>
        <button class="btn small" data-act="close" aria-label="Close">✕</button>
      </div>
    </div>`;
  const explainArea = `<div id="explain-area">${explainHtml()}</div>`;
  const common = `
    <div id="english-area">${englishHtml()}</div>
    <div id="assist-area">${assistHtml()}</div>
    ${current.onFlag ? `<p class="small"><button class="btn small" data-act="flag-wrong" title="Mark this as a transcript mistake">⚑ Flag as wrong in the transcript</button></p>` : ''}`;

  if (current.mode === 'selection') {
    panel.innerHTML = `${head('Selected text', 'small-title')}
      <p class="ctx-sentence sel-text" dir="auto">${esc(current.context)}</p>
      ${explainArea}
      ${chipsHtml()}
      ${common}`;
    return;
  }

  const { term } = current;
  const w = getWord(term);
  const status = w?.status ?? NEW;
  const where = w?.freq ? ` · appears ${w.freq}× in ${w.lessons.length} lesson${w.lessons.length === 1 ? '' : 's'}` : '';
  const related = term.includes(' ')
    ? []
    : [...state.vocab.values()].filter((x) => x.isPhrase && isLearning(x.status) && x.term.split(' ').includes(term)).slice(0, 5);
  // Meaning first: the sentence and the target-language explanation, then the levels.
  panel.innerHTML = `${head(term)}
    ${flagBoxHtml()}
    ${sentenceHtml()}
    ${explainArea}
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
    <div class="field" style="margin-top:12px">
      <label for="hint">Your meaning / hint</label>
      <textarea id="hint" rows="2" style="min-height:56px" placeholder="Write a meaning, or tap “Use as hint”">${esc(w?.hint || '')}</textarea>
    </div>
    ${related.length ? `<p class="small">In phrases: ${related.map((r) => `<button class="btn small" data-open="${esc(r.term)}">${esc(r.term)}</button>`).join(' ')}</p>` : ''}
    ${common}`;
}

function renderDynamic() {
  if (!current) return;
  for (const [id, fn] of [['explain-area', explainHtml], ['english-area', englishHtml], ['assist-area', assistHtml]]) {
    const el = panel.querySelector(`#${id}`);
    if (el) el.innerHTML = fn();
  }
}

function sentenceHtml() {
  const { context, mark } = current;
  if (!context) return '';
  const body = mark
    ? `${esc(context.slice(0, mark[0]))}<mark>${esc(context.slice(mark[0], mark[1]))}</mark>${esc(context.slice(mark[1]))}`
    : esc(context);
  return `<div class="ctx-block"><div class="small muted">In this sentence</div><p class="ctx-sentence" dir="auto">${body}</p></div>`;
}

// Selection mode: the words of the passage, coloured by status; tap one to open it.
function chipsHtml() {
  const seen = new Set();
  const chips = tokenize(current.context, lang()).filter((t) => t.n && !seen.has(t.n) && seen.add(t.n));
  return `<div class="chips">${chips.map((t) => {
    const s = statusOf(t.n);
    const cls = s === NEW ? 'st-0' : isLearning(s) ? `st-${s}` : '';
    return `<button class="chip w ${cls}" data-word="${esc(t.n)}" dir="auto">${esc(t.t)}</button>`;
  }).join('')}</div>`;
}

function flagBoxHtml() {
  const f = current.flag;
  if (!f) return '';
  const what = f.manual
    ? `You flagged <b dir="auto">${esc(f.said)}</b> as possibly wrong in the transcript.`
    : `The transcript says <b dir="auto">${esc(f.said)}</b>, but the audio may say <b dir="auto">${f.heard ? esc(f.heard) : '(nothing)'}</b>.`;
  return `<div class="dict-line flag-box"><span class="small muted">Transcript check</span><div>${what}</div>
    <div class="row" style="grid-column:1/-1">
      ${f.heard ? `<button class="btn small primary" data-act="flag-replace">Replace with “${esc(f.heard)}”</button>` : ''}
      <button class="btn small" data-act="flag-edit">Edit the line</button>
      <button class="btn small" data-act="flag-dismiss">${f.manual ? 'Remove flag' : 'Not a mistake'}</button>
    </div></div>`;
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

// The target-language part of an AI answer (+ example translations when English is shown).
function answerHtml(x, slot) {
  const r = x.result || {};
  const t = r.target || {}, n = r.native || {};
  const examples = (t.examples || []).map((e, k) => `<li dir="auto">${esc(e)}${current.showEnglish && n.examples?.[k]
    ? `<div class="small muted" dir="auto">${esc(n.examples[k])}</div>` : ''}</li>`).join('');
  const lemma = r.lemma && r.lemma.toLocaleLowerCase() !== current.term.toLocaleLowerCase() ? r.lemma : '';
  return `<div class="explain">
    <p class="ex-meaning" dir="auto">${esc(t.meaning || '')}</p>
    ${lemma || r.part_of_speech ? `<div class="small muted" dir="auto">${esc([r.part_of_speech, lemma && `→ ${lemma}`].filter(Boolean).join(' '))}</div>` : ''}
    ${t.grammar ? `<p class="small" dir="auto">${esc(t.grammar)}</p>` : ''}
    ${r.multiword_unit ? `<p class="small">Expression: <b dir="auto">${esc(r.multiword_unit)}</b></p>` : ''}
    ${examples ? `<div class="small muted">Examples</div><ul class="examples">${examples}</ul>` : ''}
    <div class="row"><button class="btn small" data-act="hint-target" data-slot="${slot}">Use as hint</button>
      <span class="small muted">${esc(x.source || '')}</span></div>
  </div>`;
}

function explainHtml() {
  const x = current.explain;
  const label = `<div class="small muted">Explanation in ${esc(L())}</div>`;
  if (!x) return '';
  if (x.state === 'loading') {
    return `${label}<p class="small muted">${x.progress != null && x.progress < 1
      ? `Downloading Chrome’s AI model (one time)… ${Math.round(x.progress * 100)}%` : 'Explaining…'}</p>`;
  }
  if (x.state === 'idle') return `${label}<button class="btn small" data-act="explain">Explain in ${esc(L())}</button>`;
  if (x.state === 'none') {
    return `${label}<p class="small muted">No free AI is set up for automatic explanations yet. Add a free OpenRouter key in
      Settings (or use Chrome, which has one built in), or ask DeepSeek or ChatGPT below.</p>`;
  }
  if (x.state === 'error') return `${label}<p class="small">${esc(x.msg)}</p><button class="btn small" data-act="explain">Try again</button>`;
  return `${label}${answerHtml(x, 'explain')}`;
}

function englishHtml() {
  const btn = `<button class="btn small english-toggle" data-act="toggle-english" aria-expanded="${current.showEnglish}">
    ${current.showEnglish ? `Hide ${esc(N())}` : `Show ${esc(N())}`} ▾</button>`;
  if (!current.showEnglish) return btn;
  const parts = [];
  if (current.context) {
    parts.push(`<div class="dict-line"><span class="small muted">Translation</span>${trHtml()}
      <p class="small" style="grid-column:1/-1;margin:0">Open in ${sentenceLinks(current.context, lang(), state.settings.native)
        .map(([name, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${name}</a>`).join(' · ')}</p></div>`);
  }
  for (const slot of ['explain', 'deep']) {
    const n = current[slot]?.state === 'done' ? current[slot].result?.native : null;
    if (!n || !(n.meaning || n.grammar)) continue;
    parts.push(`<div class="dict-line"><span class="small muted">${slot === 'deep' ? 'Detailed explanation' : 'Explanation'} in ${esc(N())}</span>
      <div><b dir="auto">${esc(n.meaning || '')}</b>${n.grammar ? `<div class="small">${esc(n.grammar)}</div>` : ''}</div>
      <button class="btn small" data-act="hint-native" data-slot="${slot}">Use as hint</button></div>`);
  }
  if (current.mode === 'word') {
    parts.push(dictAreaHtml());
    parts.push(`<p class="small">${externalLinks(current.term, lang(), state.settings.native)
      .map(([name, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${name}</a>`).join(' · ')}</p>`);
  }
  return `${btn}<div class="english">${parts.join('')}</div>`;
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

function assistHtml() {
  if (!current.context) return '';
  const d = current.deep, h = current.handoff;
  let body = '';
  if (d?.state === 'loading') body = '<p class="small muted">Asking a stronger free model (it reads the whole transcript)…</p>';
  else if (d?.state === 'error') body = `<p class="small">${esc(d.msg)}</p>`;
  else if (d?.state === 'none') body = '<p class="small">Add your free OpenRouter key in Settings to ask in the app, or use DeepSeek / ChatGPT.</p>';
  else if (d?.state === 'done') body = answerHtml(d, 'deep');
  if (h) {
    body += h.site === 'DeepSeek'
      ? `<div class="handoff">${h.copied
        ? `<p class="small"><b>✓ Your question is copied.</b> In DeepSeek, click the message box, press <b>Ctrl+V</b>
            (on a phone: long-press → Paste), then send. DeepSeek can’t be filled in automatically.</p>`
        : '<p class="small"><b>Copy this question</b>, then paste it into DeepSeek:</p>'}
        ${h.copied ? '' : `<textarea class="handoff-text" readonly rows="5">${esc(h.text)}</textarea>`}
        <div class="row"><button class="btn small" data-act="copy-again">Copy again</button>
          <a class="btn small" href="https://chat.deepseek.com/" target="_blank" rel="noopener">Open DeepSeek ↗</a></div></div>`
      : `<p class="small handoff">Opened a private ChatGPT chat with your question${h.copied ? ' (also copied — press Ctrl+V if the box is empty)' : ''}.</p>`;
  }
  return `<details class="assist" ${d || h ? 'open' : ''}>
      <summary class="small"><b>Still unclear?</b> Ask a stronger AI (reads the whole transcript)</summary>
      <div class="row" style="margin:8px 0">
        <button class="btn small" data-act="deep" title="A free model through your free OpenRouter key">Ask in the app</button>
        <button class="btn small" data-act="deepseek" title="Copies the question (with the transcript) and opens DeepSeek’s free chat">DeepSeek ↗</button>
        <button class="btn small" data-act="chatgpt" title="Opens a private ChatGPT chat with the question (uses your own account)">ChatGPT ↗</button>
      </div>
      ${body}
    </details>`;
}

// ---------- actions ----------

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
  if (current.mode !== 'word') return copyText(text).then(() => toast('Copied'));
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

// Save the detected expression as a phrase LingQ (underlined in the reader).
async function saveExpression() {
  const { expr, context, onChange, onClose, transcript } = current;
  const term = expr.terms.join(' ');
  await setStatus(term, 1, { hint: expr.defs[0].text, context }, { manual: true });
  onChange?.(term);
  openPanel(term, { context, transcript, onChange, onClose });
}

function openWord(word) {
  const { context, onChange, onClose, transcript } = current;
  const at = tokenize(context, lang()).reduce((acc, t) => {
    if (acc.found == null && t.n === word) acc.found = acc.o;
    acc.o += t.t.length;
    return acc;
  }, { o: 0, found: null }).found ?? 0;
  const { sentence, start } = sentenceAt(context, at);
  const end = at - start + (tokenize(context.slice(at), lang())[0]?.t.length || 0);
  openPanel(word, { context: sentence, mark: [at - start, end], transcript, onChange, onClose });
}

async function handoff(site) {
  const fn = site === 'DeepSeek' ? openDeepSeek : openChatGpt;
  const { text, copied } = await fn(aiInput());
  current.handoff = { site, text, copied };
  renderDynamic();
  if (site === 'DeepSeek' && !copied) panel.querySelector('.handoff-text')?.select();
}

panel.addEventListener('click', (e) => {
  if (!current) return;
  const t = e.target.closest('button, li[data-def]');
  if (!t) return;
  const act = t.dataset.act;
  const slotAnswer = () => current[t.dataset.slot]?.result;
  if (act === 'close') return closePanel();
  if (act === 'speak') return speak(current.mode === 'selection' ? current.context : current.term);
  if (act === 'undo') return undo();
  if (act === 'save-expr') return saveExpression();
  if (act === 'flag-wrong') return current.onFlag();
  if (act === 'flag-replace') return current.flag.replace();
  if (act === 'flag-dismiss') return current.flag.dismiss();
  if (act === 'flag-edit') { const f = current.flag; closePanel(); return f.edit(); }
  if (act === 'explain') return loadExplain({ force: true });
  if (act === 'deep') return loadExplain({ depth: 'deep' });
  if (act === 'toggle-english') { current.showEnglish = !current.showEnglish; return renderDynamic(); }
  if (act === 'hint-target') return saveHint(slotAnswer()?.target?.meaning || '');
  if (act === 'hint-native') return saveHint(slotAnswer()?.native?.meaning || '');
  if (act === 'chatgpt') return handoff('ChatGPT');
  if (act === 'deepseek') return handoff('DeepSeek');
  if (act === 'copy-again') return copyText(current.handoff.text).then((ok) => toast(ok ? 'Copied' : 'Copying was blocked — select the text and copy it'));
  if (t.dataset.word) return openWord(t.dataset.word);
  if (t.dataset.open) return openPanel(t.dataset.open, { context: current.context, transcript: current.transcript, onChange: current.onChange, onClose: current.onClose });
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
  if (k === 'escape') closePanel();
  else if (current.mode === 'selection') return;
  else if (['1', '2', '3', '4'].includes(k)) changeStatus(Number(k));
  else if (k === 'k') changeStatus(KNOWN);
  else if (k === 'x') changeStatus(IGNORED);
  else return;
  e.preventDefault();
});
