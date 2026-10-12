// Accounts: several per app, each with its own data, synced across devices.
import * as db from '../db.js';
import { esc, toast } from '../state.js';
import {
  accounts, activeAccount, isSignedIn, signUp, logIn, logOut, switchTo,
  cloudConfig, setCloudConfig, syncNow, status, onStatus,
} from '../cloud.js';

const STATUS_TEXT = {
  off: 'Not syncing', syncing: 'Syncing…', ok: 'Synced', error: 'Sync problem', offline: 'Offline — will sync when back online',
};

async function guestHasData() {
  const prev = db.databaseName();
  if (prev === 'lingo-reader') return (await db.all('lessons')).length + (await db.all('words')).length > 0;
  return true; // assume yes; copyFrom simply copies nothing if empty
}

export async function renderAccount(view) {
  const cur = activeAccount();
  const cfg = cloudConfig();
  const list = accounts();

  view.innerHTML = `
    <h1>Account</h1>
    <div class="card">
      <div class="row spread">
        <div><div class="small muted">You’re using</div>
          <b>${cur ? esc(cur.name) : 'This device only'}</b>${cur ? ` <span class="small muted">${esc(cur.email)}</span>` : ''}</div>
        ${cur ? `<button class="btn small" id="sync-now">Sync now</button>` : ''}
      </div>
      <p class="small muted" id="sync-line">${cur ? '' : 'Your progress is saved on this device only. Create an account to keep it in sync between your computer and phone.'}</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Accounts on this device</h2>
      <div class="acc-list">
        <div class="acc-row ${cur ? '' : 'on'}"><div><b>This device only</b><div class="small muted">Not synced</div></div>
          ${cur ? '<button class="btn small" data-switch="">Switch</button>' : '<span class="badge">In use</span>'}</div>
        ${list.map((a) => `
          <div class="acc-row ${cur?.id === a.id ? 'on' : ''}">
            <div><b>${esc(a.name)}</b><div class="small muted">${esc(a.email)}${isSignedIn(a) ? '' : ' · signed out'}</div></div>
            <div class="row">
              ${cur?.id === a.id ? '<span class="badge">In use</span>' : `<button class="btn small" data-switch="${esc(a.id)}">Switch</button>`}
              <button class="btn small" data-logout="${esc(a.id)}">Log out</button>
            </div>
          </div>`).join('')}
      </div>
    </div>

    <div class="card" ${cfg ? '' : 'hidden'} id="auth-cards">
      <h2 style="margin-top:0">Create an account</h2>
      <div class="field"><label for="su-name">Name</label><input id="su-name" type="text" autocomplete="nickname"></div>
      <div class="field"><label for="su-email">Email</label><input id="su-email" type="text" inputmode="email" autocomplete="email"></div>
      <div class="field"><label for="su-pass">Password (at least 6 characters)</label><input id="su-pass" type="password" autocomplete="new-password"></div>
      <label class="row small"><input type="checkbox" id="su-bring" ${cur ? '' : 'checked'} ${cur ? 'disabled' : ''}>
        Bring this device’s current progress into the new account</label>
      <button class="btn primary" id="su-go">Create account</button>
      <h2>Log in</h2>
      <p class="small muted">Use this on your phone (or any device) to get the same account and all its data.</p>
      <div class="field"><label for="li-email">Email</label><input id="li-email" type="text" inputmode="email" autocomplete="email"></div>
      <div class="field"><label for="li-pass">Password</label><input id="li-pass" type="password" autocomplete="current-password"></div>
      <button class="btn primary" id="li-go">Log in</button>
      <p class="small" id="auth-msg" aria-live="polite"></p>
    </div>

    <details class="card" ${cfg ? '' : 'open'}>
      <summary><b>Sync server</b> ${cfg ? '<span class="badge">Connected</span>' : '<span class="badge">Not set up</span>'}</summary>
      <p class="small">Accounts and syncing run on a free <a href="https://supabase.com" target="_blank" rel="noopener">Supabase</a>
        project that belongs to you. One-time setup (about 5 minutes):</p>
      <ol class="small">
        <li>Sign up at supabase.com (free, no card) and create a new project.</li>
        <li>Open <b>SQL Editor → New query</b>, paste the contents of <code>docs/supabase-setup.sql</code> from this app’s folder, and click <b>Run</b>.</li>
        <li>Open <b>Authentication → Sign In / Providers → Email</b> and turn off <b>Confirm email</b> (or you’ll have to click a link in an email after signing up).</li>
        <li>Open <b>Project Settings → API</b> (or the <b>Connect</b> button) and copy the <b>Project URL</b> and the <b>anon / publishable</b> key here.</li>
      </ol>
      <div class="field"><label for="sv-url">Project URL</label><input id="sv-url" type="url" value="${esc(cfg?.url || '')}" placeholder="https://xxxx.supabase.co"></div>
      <div class="field"><label for="sv-key">anon / publishable key</label><input id="sv-key" type="text" value="${esc(cfg?.anonKey || '')}" placeholder="eyJ… or sb_publishable_…"></div>
      <div class="row"><button class="btn" id="sv-save">Save and check</button><span class="small muted" id="sv-msg"></span></div>
    </details>`;

  const $ = (s) => view.querySelector(s);
  const msg = (t) => { $('#auth-msg').textContent = t; };

  const showStatus = () => {
    const el = $('#sync-line');
    if (!el || !cur) return;
    el.textContent = `${STATUS_TEXT[status.state] || ''}${status.state === 'ok' && status.at ? ` · ${new Date(status.at).toLocaleTimeString()}` : ''}${status.error ? ` — ${status.error}` : ''}`;
  };
  showStatus();
  const off = onStatus(showStatus);

  $('#sync-now')?.addEventListener('click', () => syncNow());

  view.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => {
    const acc = list.find((a) => a.id === b.dataset.switch);
    if (acc && !isSignedIn(acc)) { $('#li-email').value = acc.email; $('#li-pass').focus(); return msg('Log in again to use this account.'); }
    switchTo(b.dataset.switch);
  }));
  view.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.logout;
    const forget = confirm('Also remove this account’s data from this device? (It stays safe in your account and comes back when you log in.)');
    await logOut(id, { forget });
    if (cur?.id === id) switchTo('');
    else renderAccount(view);
  }));

  $('#su-go').addEventListener('click', async () => {
    const name = $('#su-name').value.trim(), email = $('#su-email').value.trim(), pass = $('#su-pass').value;
    if (!email || pass.length < 6) return msg('Enter an email and a password of at least 6 characters.');
    msg('Creating your account…');
    try {
      const r = await signUp(email, pass, name);
      if (r.confirm) return msg('Almost done: open the confirmation email, click the link, then log in here.');
      if ($('#su-bring').checked && !cur && await guestHasData()) {
        msg('Copying this device’s progress into your account…');
        db.useDatabase(r.id);
        await db.copyFrom('lingo-reader');
      }
      toast('Account created');
      switchTo(r.id);
    } catch (err) {
      msg(err.message);
    }
  });

  $('#li-go').addEventListener('click', async () => {
    const email = $('#li-email').value.trim(), pass = $('#li-pass').value;
    if (!email || !pass) return msg('Enter your email and password.');
    msg('Logging in…');
    try {
      const acc = await logIn(email, pass);
      toast(`Welcome back, ${acc.name}`);
      switchTo(acc.id);
    } catch (err) {
      msg(/invalid/i.test(err.message) ? 'Wrong email or password.' : err.message);
    }
  });

  $('#sv-save').addEventListener('click', async () => {
    const url = $('#sv-url').value.trim(), key = $('#sv-key').value.trim();
    if (!/^https:\/\/.+/.test(url) || !key) { $('#sv-msg').textContent = 'Paste both the Project URL and the key.'; return; }
    $('#sv-msg').textContent = 'Checking…';
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/settings`, { headers: { apikey: key } });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      const s = await res.json();
      setCloudConfig(url, key);
      $('#sv-msg').textContent = `✓ Connected.${s.mailer_autoconfirm === false ? ' Note: “Confirm email” is still on (step 3).' : ''}`;
      $('#auth-cards').hidden = false;
    } catch (err) {
      $('#sv-msg').textContent = `Couldn’t connect: ${err.message}. Check the URL and key.`;
    }
  });

  return off;
}
