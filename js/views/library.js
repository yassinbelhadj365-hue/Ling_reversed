import * as db from '../db.js';
import { lang, langName, statusOf, esc } from '../state.js';
import { NEW, KNOWN, isLearning } from '../srs.js';
import { myJobs, jobStatusText, cancelJob, retryJob } from '../relay.js';

const KIND = { transcript: 'Transcript', text: 'Text' };

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
    view.innerHTML = `
      <h1>${esc(langName(lang()))} library</h1>
      ${jobs}
      <div class="empty card">
        <p style="font-size:2rem;margin:0">📚</p>
        <p>No lessons yet. Import a YouTube transcript, subtitles, an article, or any text you want to learn from.</p>
        <a class="btn primary" href="#/import">Import content</a>
      </div>`;
    wireJobs(view, rerender);
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
    return `
      <a class="card lesson-card" href="#/lesson/${l.id}">
        <h3 dir="auto">${esc(l.title)}</h3>
        <div class="row small muted">
          <span class="badge">${l.youtubeId ? 'YouTube' : KIND[l.kind] || 'Text'}</span>
          <span>${l.wordCount.toLocaleString()} words</span>
          ${l.completed ? '<span class="badge">✓ Completed</span>' : l.page ? `<span class="badge">In progress</span>` : ''}
        </div>
        <div class="meter" role="img" aria-label="${pct(known)}% known, ${pct(learning)}% LingQs, ${pct(fresh)}% new">
          <div style="width:${pct(known)}%"></div><div class="l" style="width:${pct(learning)}%"></div>
        </div>
        <div class="small muted">${pct(fresh)}% new words · ${learning} LingQs · ${terms.length.toLocaleString()} unique</div>
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
