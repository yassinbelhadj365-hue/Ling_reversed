// The word / phrase / selection panel. Side sheet on desktop, bottom sheet on phones.
//
// One AI answer (explain.js, Gemini) gives the sentence's translation, what the word
// means here and a short explanation in the language you're learning. Only the meaning
// that fits this sentence is shown, never a list of other senses.
import { state, lang, getWord, setStatus, saveWord, undoAuto, recordSense, speak, esc, toast, statusOf } from './state.js';
import { NEW, KNOWN, IGNORED, isLearning } from './srs.js';
import { progress } from './knowledge.js';
import { sentenceLinks } from './ai.js';
import { tokenize, contextAt } from './text.js';
import { explain } from './explain.js';
import { hasDictionary, lookupNow, lookupWord } from './dictionary.js';
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
// compact: the reader shows the sentence just above (listen mode), so the panel shows only its
// translation and the levels come up within reach. onEdit: correct the transcript line.
export function openPanel(term, {
  mode = 'word', context = '', mark = null, around = {}, flag = null, transcript = '', onFlag = null, onChange, onClose,
  compact = false, onEdit = null,
} = {}) {
  current = {
    term, mode, context, mark, around, flag, transcript, onFlag, onChange, onClose, compact, onEdit,
    explain: null, deep: null, handoff: null, newSense: null, dict: null,
  };
  // The offline dictionary's meaning shows at once; the AI's meaning in this sentence replaces it.
  if (mode === 'word' && !term.includes(' ') && hasDictionary(lang(), state.settings.native)) {
    const me = current;
    me.dict = lookupNow(term, lang(), state.settings.native);
    if (!me.dict) {
      lookupWord(term, lang(), state.settings.native).then((d) => {
        if (d && stillOpen(me) && me.explain?.state !== 'done') { me.dict = d; renderDynamic(); }
      });
    }
  }
  render();
  panel.hidden = false;
  loadExplain();
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

// ---------- loading ----------

function aiInput() {
  if (current.mode === 'selection') return { kind: 'passage', term: current.term, sentence: current.context, transcript: current.transcript };
  const senses = (getWord(current.term)?.senses || []).map((s) => s.meaning);
  return { kind: 'word', term: current.term, sentence: current.context, transcript: current.transcript, senses };
}

// depth 'quick' fills the main answer; 'deep' is the "Still unclear?" answer.
async function loadExplain({ depth = 'quick', force = false } = {}) {
  const me = current;
  if (!me.context) return;
  const slot = depth === 'quick' ? 'explain' : 'deep';
  if (depth === 'quick' && !state.settings.aiAuto && !force) { me.explain = { state: 'idle' }; return renderDynamic(); }
  me[slot] = { state: 'loading' };
  renderDynamic();
  try {
    const v = await explain(aiInput(), { depth });
    if (!stillOpen(me)) return;
    me[slot] = { state: 'done', ...v };
  } catch (err) {
    if (!stillOpen(me)) return;
    me[slot] = err.message === 'no-provider' ? { state: 'none' } : { state: 'error', msg: err.message };
  }
  renderDynamic();
  if (slot === 'explain' && me[slot].state === 'done') await afterAnswer(me);
}

const answer = (slot = 'explain') => (current?.[slot]?.state === 'done' ? current[slot].result || {} : null);

// After the answer: record the meaning (a meaning the learner hasn't met before makes the
// word a LingQ again, state.recordSense) and keep the sentence for flashcards.
async function afterAnswer(me) {
  if (me.mode !== 'word') return;
  const res = await recordSense(me.term, me.context, me.explain.result).catch(() => null);
  if (res?.isNew) {
    me.onChange?.(me.term);
    // Said (with its Undo) in the panel itself, not in a toast on top of the controls.
    if (stillOpen(me)) { me.newSense = res; render(); }
  }
  await rememberContext(me);
}

// LingQs keep the sentence they were met in (and its translation) for flashcards.
async function rememberContext(me = current) {
  if (!me || me.mode !== 'word') return;
  const { term, context } = me;
  const tr = (me.explain?.state === 'done' && me.explain.result?.translation) || '';
  const w = getWord(term);
  if (!w || !isLearning(w.status) || !context) return;
  if (!w.context) { w.context = context; w.contextTr = tr; await saveWord(w); }
  else if (w.context === context && !w.contextTr && tr) { w.contextTr = tr; await saveWord(w); }
}

// ---------- rendering ----------
// Kept short on purpose: the meaning, the sentence with its translation, the levels.
// Everything else waits under "More".

function render() {
  const head = (title, cls = '') => `
    <div class="row spread panel-head">
      <h2 class="panel-word ${cls}" dir="auto">${esc(title)}</h2>
      <div class="row">
        <button class="btn small" data-act="speak" aria-label="Listen">🔊</button>
        <button class="btn small" data-act="close" aria-label="Close">✕</button>
      </div>
    </div>`;
  const flagBtn = current.onFlag
    ? '<button class="btn small" data-act="flag-wrong" title="Mark this as a transcript mistake">⚑ Wrong in the transcript</button>' : '';

  if (current.mode === 'selection') {
    panel.innerHTML = `${head('Selected text', 'small-title')}
      <div id="answer-area">${answerAreaHtml()}</div>
      ${chipsHtml()}
      <details class="more" ${current.moreOpen ? 'open' : ''}><summary>More</summary>
        <div id="assist-area">${assistHtml()}</div>
        ${flagBtn ? `<div class="row">${flagBtn}</div>` : ''}
      </details>`;
    return;
  }

  const { term } = current;
  const w = getWord(term);
  const status = w?.status ?? NEW;
  const where = w?.freq ? ` · appears ${w.freq}× in ${w.lessons.length} lesson${w.lessons.length === 1 ? '' : 's'}` : '';
  const related = term.includes(' ')
    ? []
    : [...state.vocab.values()].filter((x) => x.isPhrase && isLearning(x.status) && x.term.split(' ').includes(term)).slice(0, 5);
  panel.innerHTML = `${head(term)}
    ${flagBoxHtml()}
    <div id="answer-area">${answerAreaHtml()}</div>
    <div class="status-row" role="group" aria-label="Set status">
      ${[1, 2, 3, 4].map((s) => `<button data-s="${s}" class="${status === s ? 'on' : ''}" title="LingQ level ${s} (key ${s})">${s}</button>`).join('')}
      <button data-s="${KNOWN}" class="${status === KNOWN ? 'on' : ''}" title="Known (key K)">✓ Known</button>
      <button data-s="${IGNORED}" class="ignore ${status === IGNORED ? 'on' : ''}" title="Ignore — names, typos (key X)">Ignore</button>
    </div>
    ${undoLine(w)}
    <details class="more" ${current.moreOpen ? 'open' : ''}><summary>More</summary>
      <div id="assist-area">${assistHtml()}</div>
      <div class="muted small">${STATUS_LABEL[status]}${where}</div>
      ${autoLine(w)}
      <div class="field" style="margin-top:8px">
        <label for="hint">Your note for flashcards</label>
        <textarea id="hint" rows="2" style="min-height:48px" placeholder="Filled in with the meaning; change it if you like">${esc(w?.hint || '')}</textarea>
      </div>
      ${related.length ? `<p class="small">In phrases: ${related.map((r) => `<button class="btn small" data-open="${esc(r.term)}">${esc(r.term)}</button>`).join(' ')}</p>` : ''}
      <div class="row">
        ${status !== NEW ? `<button class="btn small" data-s="${NEW}">Reset to new</button>` : ''}
        ${flagBtn}
        ${current.onEdit ? '<button class="btn small" data-act="edit-line" title="Correct this line of the transcript">✎ Correct this line</button>' : ''}
      </div>
    </details>`;
}

function renderDynamic() {
  if (!current) return;
  for (const [id, fn] of [['answer-area', answerAreaHtml], ['assist-area', assistHtml]]) {
    const el = panel.querySelector(`#${id}`);
    if (el) el.innerHTML = fn();
  }
}

function sentenceHtml(translation) {
  const { context, mark } = current;
  if (!context || current.mode === 'selection') return '';
  if (current.compact) return translation ? `<div class="ctx-block">${translation}</div>` : '';
  const body = mark
    ? `${esc(context.slice(0, mark[0]))}<mark>${esc(context.slice(mark[0], mark[1]))}</mark>${esc(context.slice(mark[1]))}`
    : esc(context);
  return `<div class="ctx-block"><p class="ctx-sentence" dir="auto">${body}</p>${translation}</div>`;
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

const canUndo = (w) => w?.ev?.prev && Date.now() - (w.ev.autoAt || 0) < UNDO_WINDOW;

// Shown right under the levels only when an automatic change can be undone.
function undoLine(w) {
  if (!state.settings.autoStatus || !canUndo(w)) return '';
  return `<div class="auto-line small"><span>Level set automatically</span>
    <button class="btn small" data-act="undo" title="Undo the last automatic change">Undo</button></div>`;
}

function autoLine(w) {
  if (!w?.ev || !state.settings.autoStatus) return '';
  const parts = [w.ev.src === 'manual' ? 'Set by you' : 'Auto · from your reading'];
  if (isLearning(w.status)) {
    const p = progress(w, state.settings.autoPace);
    parts.push(`${Math.min(p.done, p.total)} / ${p.total} encounters toward known`);
  }
  return `<div class="auto-line small muted"><span>${parts.join(' · ')}</span></div>`;
}

// The normalized phrase of the AI's multi-word expression, when it really is several words.
function expressionTerm(r) {
  if (!r?.multiword_unit || current.mode !== 'word') return '';
  const terms = tokenize(r.multiword_unit, lang()).filter((t) => t.n).map((t) => t.n);
  const term = terms.join(' ');
  return terms.length >= 2 && term !== current.term ? term : '';
}

// The offline dictionary's meanings (dictionary.js), until the AI's meaning in this sentence arrives.
function dictHtml(note = 'not checked against this sentence') {
  if (!current.dict) return '';
  const text = current.dict.map((d) => (d.lemma ? `${d.meaning} (${d.lemma})` : d.meaning)).join(' · ');
  return `<p class="meaning guess" dir="auto">${esc(text)}</p><p class="small muted">📖 Dictionary · ${note}</p>`;
}

// The quick answer: the meaning here, big; a short explanation in the target language;
// the sentence with its translation; one-tap links to the dictionary form and expression.
function answerAreaHtml() {
  const x = current.explain;
  if (!current.context) return '';
  const isWord = current.mode === 'word';
  if (!x || x.state === 'loading') {
    const meaning = current.dict
      ? dictHtml('checking the meaning in this sentence…')
      : '<div class="meaning skeleton" aria-label="Loading"></div>';
    return `${meaning}${isWord && !current.dict ? '<div class="meaning-target skeleton short"></div>' : ''}
      ${sentenceHtml('<p class="ctx-tr muted" id="ctx-tr">Translating…</p>')}`;
  }
  if (x.state === 'idle') return `${dictHtml()}<button class="btn primary" data-act="explain">Translate</button>${sentenceHtml('')}`;
  if (x.state === 'none') {
    return `${dictHtml()}<p class="small muted">No AI is set up yet: <a href="#/settings/ai">set it up (about a minute, free)</a>, or log in
      to your account (top right). Meanwhile: ${linksHtml()}</p>${sentenceHtml('')}`;
  }
  if (x.state === 'error') {
    // Busy or used up: a backup AI would have answered.
    const fix = /busy|limit/i.test(x.msg) ? ` <a href="#/settings/ai">Add a free backup AI</a>` : '';
    return `${dictHtml()}<p class="small">${esc(x.msg)}${fix}</p><div class="row"><button class="btn small" data-act="explain">Try again</button>
      <span class="small">${linksHtml()}</span></div>${sentenceHtml('')}`;
  }
  const r = x.result || {};
  if (!isWord) {
    return `<p class="meaning sel" dir="auto" id="ctx-tr">${esc(r.translation || '')}</p>
      ${r.meaning_target ? `<p class="meaning-target" dir="auto">${esc(r.meaning_target)}</p>` : ''}`;
  }
  const lemma = r.lemma && r.lemma.toLocaleLowerCase() !== current.term.toLocaleLowerCase() ? r.lemma : '';
  const expr = expressionTerm(r);
  const links = [
    lemma && `<button class="btn small" data-open-lemma="${esc(lemma)}" title="Open the dictionary form">→ ${esc(lemma)}</button>`,
    expr && `<button class="btn small" data-act="save-expr" title="Save the expression as a phrase LingQ">+ Save phrase “${esc(r.multiword_unit)}”</button>`,
  ].filter(Boolean).join('');
  return `<p class="meaning meaning-here" dir="auto">${esc(r.meaning_native || '')}${r.part_of_speech
      ? ` <span class="pos small muted" dir="auto">${esc(r.part_of_speech)}</span>` : ''}</p>
    ${r.meaning_target ? `<p class="meaning-target" dir="auto">${esc(r.meaning_target)}</p>` : ''}
    ${current.newSense ? `<p class="new-sense small"><b>New meaning for you</b> (before: ${current.newSense.before.map((m) => `“${esc(m)}”`).join(', ')}).
      It’s a LingQ again for this meaning. <button class="btn small" data-act="undo-sense">Undo</button></p>` : ''}
    ${sentenceHtml(r.translation ? `<p class="ctx-tr" id="ctx-tr" dir="auto">${markIn(r.translation, r.highlight)}</p>` : '')}
    ${links ? `<div class="row answer-links">${links}</div>` : ''}`;
}

// The translation with the words that translate the tapped word marked. Only marked when
// the AI's highlight really occurs in its translation; otherwise nothing is marked.
function markIn(text, part) {
  const at = part ? text.toLocaleLowerCase().indexOf(String(part).trim().toLocaleLowerCase()) : -1;
  if (!part?.trim() || at === -1) return esc(text);
  const end = at + String(part).trim().length;
  return `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, end))}</mark>${esc(text.slice(end))}`;
}

// Under "More": examples and grammar, from a longer look at the transcript (loaded when More opens).
function detailHtml(x) {
  const r = x.result || {};
  const examples = (r.examples || []).map((e, k) => `<li dir="auto">${esc(e)}${r.examples_native?.[k]
    ? `<div class="small muted" dir="auto">${esc(r.examples_native[k])}</div>` : ''}</li>`).join('');
  // Examples first (each with its translation), then the grammar note.
  return `<div class="explain">
    ${examples ? `<div class="small muted">Examples</div><ul class="examples">${examples}</ul>` : ''}
    ${r.grammar ? `<p class="small" dir="auto">${esc(r.grammar)}</p>` : ''}
    <div class="small muted">${esc(x.source || '')}</div>
  </div>`;
}

function linksHtml() {
  return sentenceLinks(current.context, lang(), state.settings.native).map(([name, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${name}</a>`).join(' · ');
}

function assistHtml() {
  if (!current.context) return '';
  const d = current.deep, h = current.handoff;
  let body = '';
  if (!d || d.state === 'loading') body = '<p class="small muted">Finding examples…</p>';
  else if (d.state === 'error') body = `<p class="small">${esc(d.msg)}</p><button class="btn small" data-act="deep">Try again</button>`;
  else if (d?.state === 'none') body = '<p class="small">Log in to your account or add a free Gemini key in Settings, or use DeepSeek / ChatGPT.</p>';
  else if (d?.state === 'done') body = detailHtml(d);
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
  return `<div class="assist">
      ${body}
      <div class="row"><span class="small muted">Still unclear? Ask</span>
        <button class="btn small" data-act="deepseek" title="Copies the question (with the transcript) and opens DeepSeek’s free chat">DeepSeek ↗</button>
        <button class="btn small" data-act="chatgpt" title="Opens a private ChatGPT chat with the question (uses your own account)">ChatGPT ↗</button>
      </div>
    </div>`;
}

// ---------- actions ----------

async function changeStatus(status) {
  const me = current;
  const { term, context } = me;
  const w = getWord(term);
  await setStatus(term, status, { context: w?.context || context }, { manual: true });
  if (!stillOpen(me)) return; // another word was opened meanwhile: leave its panel alone
  afterChange();
  // Known or Ignore: nothing more to learn here, so the panel gets out of the way.
  if (status === KNOWN || status === IGNORED) closePanel();
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

// Save the expression the AI found as a phrase LingQ (underlined in the reader).
async function saveExpression() {
  const { context, onChange, onClose, transcript } = current;
  const term = expressionTerm(answer());
  if (!term) return;
  await setStatus(term, 1, { context }, { manual: true });
  onChange?.(term);
  openPanel(term, { context, transcript, onChange, onClose });
}

// The dictionary form the AI named (e.g. the infinitive of a conjugated verb).
function openLemma(lemma) {
  const term = tokenize(lemma, lang()).filter((t) => t.n).map((t) => t.n).join(' ');
  if (term) openPanel(term, { context: current.context, transcript: current.transcript, onChange: current.onChange, onClose: current.onClose });
}

function openWord(word) {
  const { context, onChange, onClose, transcript } = current;
  const at = tokenize(context, lang()).reduce((acc, t) => {
    if (acc.found == null && t.n === word) acc.found = acc.o;
    acc.o += t.t.length;
    return acc;
  }, { o: 0, found: null }).found ?? 0;
  const { sentence, start } = contextAt({ text: context }, at);
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
  const t = e.target.closest('button');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'close') return closePanel();
  if (act === 'speak') return speak(current.mode === 'selection' ? current.context : current.term);
  if (act === 'undo') return undo();
  if (act === 'undo-sense') {
    const me = current;
    return me.newSense.undo().then(() => { me.onChange?.(me.term); if (stillOpen(me)) { me.newSense = null; render(); } });
  }
  if (act === 'edit-line') return current.onEdit(); // the reader closes the panel, keeping the video paused
  if (act === 'save-expr') return saveExpression();
  if (act === 'flag-wrong') return current.onFlag();
  if (act === 'flag-replace') return current.flag.replace();
  if (act === 'flag-dismiss') return current.flag.dismiss();
  if (act === 'flag-edit') { const f = current.flag; closePanel(); return f.edit(); }
  if (act === 'explain') return loadExplain({ force: true });
  if (act === 'deep') return loadExplain({ depth: 'deep' });
  if (act === 'chatgpt') return handoff('ChatGPT');
  if (act === 'deepseek') return handoff('DeepSeek');
  if (act === 'copy-again') return copyText(current.handoff.text).then((ok) => toast(ok ? 'Copied' : 'Copying was blocked — select the text and copy it'));
  if (t.dataset.word) return openWord(t.dataset.word);
  if (t.dataset.openLemma) return openLemma(t.dataset.openLemma);
  if (t.dataset.open) return openPanel(t.dataset.open, { context: current.context, transcript: current.transcript, onChange: current.onChange, onClose: current.onClose });
  if (t.dataset.s !== undefined) return changeStatus(Number(t.dataset.s));
});

// Opening "More" fetches the examples (with their translations) right away.
panel.addEventListener('toggle', (e) => {
  if (!current || !e.target.matches?.('details.more')) return;
  current.moreOpen = e.target.open;
  if (e.target.open && !current.deep) loadExplain({ depth: 'deep' });
}, true);

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

// Closing without aiming: a tap anywhere outside the panel (except on a word, which opens that
// word, or on another control), or a swipe down on the sheet. Closing resumes the video.
document.addEventListener('click', (e) => {
  if (!current || panel.hidden || panel.contains(e.target)) return;
  if (e.target.closest('.w, button, a, input, select, textarea, label, iframe, video, audio, #toast, .tabbar, .topbar')) return;
  if (String(window.getSelection?.() || '').trim()) return; // selecting a phrase
  closePanel();
});
let swipeFrom = null;
panel.addEventListener('touchstart', (e) => { swipeFrom = panel.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
panel.addEventListener('touchmove', (e) => {
  if (swipeFrom != null && e.touches[0].clientY - swipeFrom > 80) { swipeFrom = null; closePanel(); }
}, { passive: true });
