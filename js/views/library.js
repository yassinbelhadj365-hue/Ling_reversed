import * as db from '../db.js';
import { LANGS, lang, langName, statusOf, esc } from '../state.js';
import { NEW, KNOWN, IGNORED, isLearning } from '../srs.js';
import { myJobs, jobStatusText, cancelJob, retryJob, createLesson } from '../relay.js';
import { hasProvider } from '../ai.js';
import { SAMPLES } from '../samples.js';

const KIND = { transcript: 'Transcript', text: 'Text' };

// How much of a lesson you can follow: the share of its running words you know (counted
// by occurrence, names and other ignored words left out). Research on reading finds
// comprehension rises steadily with this number, and about 95–98% feels comfortable,
// so it's shown as a label rather than used to block anything.
// -> {pct, label, cls}
export function lessonLevel(words, status = statusOf) {
  let known = 0, all = 0;
  for (const [term, n] of Object.entries(words || {})) {
    const s = status(term);
    if (s === IGNORED) continue;
    all += n;
    if (s === KNOWN) known += n;
  }
  const pct = all ? Math.floor((known / all) * 100) : 0;
  if (pct >= 95) return { pct, label: 'Easy', cls: 'easy' };
  if (pct >= 85) return { pct, label: 'Good level', cls: 'good' };
  return { pct, label: 'Challenging', cls: 'hard' };
}

// Imports this phone asked the computer to do.
async function jobsHtml() {
  const jobs = await myJobs();
  if (!jobs.length) return '';
  return `<div class="card jobs" id="jobs"><h3>Coming from your computer</h3>${jobs.map((j) => `
    <div class="job" data-job="${esc(j.id)}" data-status="${j.status}">
      <div><b dir="auto">${esc(j.title || j.ytTitle || j.url)}</b>${j.kind === 'asr' ? ' <span class="badge">🎙 AI</span>' : ''}
        <div class="small muted">${esc(jobStatusText(j))}</div></div>
      <div class="row">
        ${j.status === 'error' && j.tracks?.length ? `<select data-act="track" aria-label="Caption track"><option value="">Other captions…</option>${j.tracks.map((t) => `<option value="${t.index}">${esc(t.name)}</option>`).join('')}</select>` : ''}
        ${j.status === 'error' && j.kind !== 'asr' ? '<button class="btn small" data-act="asr">🎙 Transcribe with AI</button>' : ''}
        ${j.status === 'error' ? '<button class="btn small" data-act="retry">Retry</button>' : ''}
        <button class="btn small" data-act="cancel">${j.status === 'error' ? 'Remove' : 'Cancel'}</button>
      </div>
    </div>`).join('')}</div>`;
}

function wireJobs(view, rerender) {
  view.querySelector('#jobs')?.addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    const id = e.target.closest('[data-job]')?.dataset.job;
    if (!act || !id) return;
    if (act === 'cancel') await cancelJob(id);
    if (act === 'retry') await retryJob(id);
    if (act === 'asr') await retryJob(id, { kind: 'asr' });
    rerender();
  });
  view.querySelector('#jobs')?.addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'track' || e.target.value === '') return;
    await retryJob(e.target.closest('[data-job]').dataset.job, { track: e.target.value });
    rerender();
  });
}

export async function renderLibrary(view) {
  const jobs = await jobsHtml();
  const rerender = () => renderLibrary(view);
  const lessons = (await db.byLang('lessons', lang()))
    .sort((a, b) => (b.openedAt || b.createdAt) - (a.openedAt || a.createdAt));

  if (!lessons.length) {
    const sample = SAMPLES[lang()];
    const ai = await hasProvider();
    view.innerHTML = `
      <h1>${esc(langName(lang()))} library</h1>
      ${jobs}
      <div class="card welcome">
        <h2>Welcome! Let’s start with something short.</h2>
        <div class="field"><label for="w-lang">I’m learning</label>
          <select id="w-lang" style="width:auto">${LANGS.map(([c, n]) => `<option value="${c}" ${c === lang() ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <ol class="steps">
          <li><b>Read or watch</b> something you’re interested in.</li>
          <li><b>Tap any word</b> you don’t know to see what it means in that sentence.</li>
          <li><b>Watch your known words grow</b>, and review the ones you saved.</li>
        </ol>
        <div class="row">
          ${sample ? `<button class="btn primary" id="sample">Try a 2-minute sample lesson</button>` : ''}
          <a class="btn ${sample ? '' : 'primary'}" href="#/import">Import a YouTube video or text</a>
        </div>
        ${ai ? '' : `<p class="small muted">Tapping a word asks a free AI. To turn it on, <a href="#/account">log in to your account</a>
          or add a free key in <a href="#/settings">Settings</a>.</p>`}
      </div>`;
    wireJobs(view, rerender);
    view.querySelector('#w-lang').addEventListener('change', (e) => {
      const top = document.getElementById('lang-select');
      top.value = e.target.value;
      top.dispatchEvent(new Event('change')); // the app switches language and shows this screen again
    });
    view.querySelector('#sample')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const made = await createLesson({ raw: sample.text, title: sample.title, merge: false, source: 'sample' });
      if (made) location.hash = `#/lesson/${made.lesson.id}`;
    });
    return;
  }

  const cards = lessons.map((l) => {
    const terms = Object.keys(l.words || {});
    const total = terms.length || 1;
    let known = 0, learning = 0, fresh = 0;
    for (const t of terms) {
      const s = statusOf(t);
      if (s === NEW) fresh++;
      else if (isLearning(s)) learning++;
      else if (s === KNOWN) known++;
    }
    const pct = (n) => Math.round((n / total) * 100);
    const lvl = lessonLevel(l.words);
    return `
      <a class="card lesson-card" href="#/lesson/${l.id}">
        <h3 dir="auto">${esc(l.title)}</h3>
        <div class="row small muted">
          <span class="badge">${l.youtubeId ? 'YouTube' : KIND[l.kind] || 'Text'}</span>
          <span class="level ${lvl.cls}" title="Share of this lesson’s words you already know">${lvl.label} · you know ${lvl.pct}%</span>
          <span>${l.wordCount.toLocaleString()} words</span>
          ${l.completed ? '<span class="badge">✓ Completed</span>' : l.page ? `<span class="badge">In progress</span>` : ''}
        </div>
        <div class="meter" role="img" aria-label="${pct(known)}% known, ${pct(learning)}% LingQs, ${pct(fresh)}% new">
          <div style="width:${pct(known)}%"></div><div class="l" style="width:${pct(learning)}%"></div>
        </div>
        <div class="small muted">${fresh.toLocaleString()} new words · ${learning} LingQs · ${terms.length.toLocaleString()} different words</div>
      </a>`;
  }).join('');

  view.innerHTML = `
    <div class="row spread"><h1>${esc(langName(lang()))} library</h1><a class="btn primary small" href="#/import">+ Import</a></div>
    ${jobs}
    <div class="field"><input type="search" id="q" placeholder="Search lessons…" aria-label="Search lessons"></div>
    <div class="lesson-list" id="list">${cards}</div>`;
  wireJobs(view, rerender);

  view.querySelector('#q').addEventListener('input', (e) => {
    const q = e.target.value.toLocaleLowerCase();
    view.querySelectorAll('.lesson-card').forEach((c) => {
      c.hidden = q && !c.querySelector('h3').textContent.toLocaleLowerCase().includes(q);
    });
  });
}
