// Accounts and sync between devices, on Supabase's free plan (docs/SYNC_SETUP.md).
//
// - Each account has its own local database (db.useDatabase); "This device only"
//   is the guest database that never syncs.
// - Sync is last-write-wins per record: every synced record carries `updatedAt`;
//   the server keeps the newest version (push_records) and stamps `synced_at`,
//   which devices use as a cursor to pull what changed since their last sync.
// - Deletions travel as tombstones. Audio/video files go to Supabase Storage.
import * as db from './db.js';
import { SUPABASE } from './config.js';

const CONFIG_KEY = 'lingo-cloud';
const ACCOUNTS_KEY = 'lingo-accounts';
const ACTIVE_KEY = 'lingo-active';
const sessionKey = (id) => `lingo-session-${id}`;
const STATE_KEY = 'local:sync';           // per-account sync progress (device-only kv row)
const PAGE = 500;                          // rows per pull request
const BATCH_BYTES = 800_000;               // max JSON per push request
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;  // Supabase free plan file limit
const DEBOUNCE_MS = 4000;
const INTERVAL_MS = 60_000;

const ls = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

// ---------- configuration ----------

export function cloudConfig() {
  const saved = ls.get(CONFIG_KEY, null);
  const cfg = saved?.url ? saved : SUPABASE;
  return cfg.url && cfg.anonKey ? { url: cfg.url.replace(/\/+$/, ''), anonKey: cfg.anonKey } : null;
}
export function setCloudConfig(url, anonKey) {
  ls.set(CONFIG_KEY, { url: url.trim(), anonKey: anonKey.trim() });
}

// ---------- accounts ----------

export const accounts = () => ls.get(ACCOUNTS_KEY, []);
export function activeAccount() {
  const id = ls.get(ACTIVE_KEY, '');
  return accounts().find((a) => a.id === id) || null;
}
export const isSignedIn = (acc) => !!ls.get(sessionKey(acc.id), null);

function cfgOrThrow() {
  const cfg = cloudConfig();
  if (!cfg) throw new Error('Connect your free sync server first (Account → Sync server).');
  return cfg;
}

async function auth(path, body) {
  const cfg = cfgOrThrow();
  let res;
  try {
    res = await fetch(`${cfg.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Couldn’t reach the sync server (offline?).');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || `Sign-in failed (${res.status})`);
  return data;
}

function saveSession(r, name) {
  const u = r.user;
  ls.set(sessionKey(u.id), { access: r.access_token, refresh: r.refresh_token, expires: Date.now() + (r.expires_in || 3600) * 1000 });
  const acc = { id: u.id, email: u.email, name: name || u.user_metadata?.name || u.email.split('@')[0] };
  ls.set(ACCOUNTS_KEY, [...accounts().filter((a) => a.id !== acc.id), acc]);
  return acc;
}

// -> account | {confirm: true} when the server wants the email confirmed first.
export async function signUp(email, password, name) {
  const r = await auth('signup', { email, password, data: { name } });
  if (r.access_token) return saveSession(r, name);
  if (r.identities?.length === 0 || r.user?.identities?.length === 0) throw new Error('An account with this email already exists. Log in instead.');
  return { confirm: true };
}

export async function logIn(email, password) {
  return saveSession(await auth('token?grant_type=password', { email, password }));
}

// Make an account (or null = this device only) the active one, then reload the app with its data.
export function switchTo(id) {
  ls.set(ACTIVE_KEY, id || '');
  location.hash = '#/library';
  location.reload();
}

export async function logOut(id, { forget = false } = {}) {
  ls.del(sessionKey(id));
  if (forget) {
    ls.set(ACCOUNTS_KEY, accounts().filter((a) => a.id !== id));
    await new Promise((r) => { const req = indexedDB.deleteDatabase(`lingo-reader-${id}`); req.onsuccess = req.onerror = req.onblocked = r; });
  }
}

async function accessToken(acc) {
  const s = ls.get(sessionKey(acc.id), null);
  if (!s) throw new Error('signed-out');
  if (Date.now() < s.expires - 60_000) return s.access;
  const r = await auth('token?grant_type=refresh_token', { refresh_token: s.refresh });
  saveSession(r);
  return r.access_token;
}

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const cfg = cfgOrThrow();
  const acc = activeAccount();
  const token = await accessToken(acc);
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || data.error || `Sync server error (${res.status})`);
  }
  return res;
}

// ---------- sync ----------

const keyOf = (store, r) => (store === 'lessons' ? r.id : r.key);
const listeners = new Set();
export const status = { state: 'off', at: 0, error: '' };
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const setStatus = (patch) => { Object.assign(status, patch); listeners.forEach((fn) => fn(status)); };

async function push(st) {
  const startedAt = Date.now();
  const rows = [];
  for (const store of db.SYNCED) {
    for (const r of await db.all(store)) {
      if ((r.updatedAt || 0) <= st.pushedAt) continue;
      if (store === 'kv' && !db.isSyncedKv(r.key)) continue;
      rows.push({ kind: store, key: String(keyOf(store, r)), data: r, deleted: false, updated_at: r.updatedAt });
    }
  }
  for (const t of await db.all('tombstones')) {
    if (t.at > st.pushedAt) rows.push({ kind: t.store, key: String(t.id), data: null, deleted: true, updated_at: t.at });
  }
  // A record deleted and re-created has both a tombstone and a row: keep only the newest
  // (the server can't apply two changes to the same row in one batch).
  const newest = new Map();
  for (const row of rows) {
    const k = `${row.kind}|${row.key}`;
    if (!newest.has(k) || newest.get(k).updated_at < row.updated_at) newest.set(k, row);
  }
  rows.length = 0;
  rows.push(...newest.values());
  let batch = [], size = 0;
  const flush = async () => {
    if (batch.length) await api('/rest/v1/rpc/push_records', { method: 'POST', body: { rows: batch } });
    batch = []; size = 0;
  };
  for (const row of rows) {
    const n = JSON.stringify(row).length;
    if (size + n > BATCH_BYTES) await flush();
    batch.push(row); size += n;
  }
  await flush();
  await pushMedia();
  st.pushedAt = startedAt;
  return rows.length;
}

async function pushMedia() {
  const uid = activeAccount().id;
  for (const m of await db.all('media')) {
    if ((m.uploadedAt || 0) >= (m.updatedAt || 1) || m.blob.size > MAX_MEDIA_BYTES) continue;
    await api(`/storage/v1/object/media/${uid}/${encodeURIComponent(m.lessonId)}`, {
      method: 'POST', raw: true, body: m.blob,
      headers: { 'Content-Type': m.type || 'application/octet-stream', 'x-upsert': 'true' },
    });
    await db.putRaw('media', [{ ...m, uploadedAt: Date.now() }]);
  }
}

async function pull(st) {
  let applied = 0;
  const known = new Map(); // store -> Map(key -> updatedAt), loaded on first use
  const localTimes = async (store) => {
    if (!known.has(store)) known.set(store, new Map((await db.all(store)).map((r) => [String(keyOf(store, r)), r.updatedAt || 0])));
    return known.get(store);
  };
  const tombs = new Map((await db.all('tombstones')).map((t) => [t.key, t.at]));
  for (;;) {
    const cursor = st.cursor || '1970-01-01T00:00:00Z';
    const res = await api(`/rest/v1/records?select=kind,key,data,deleted,updated_at,synced_at&synced_at=gte.${encodeURIComponent(cursor)}&order=synced_at.asc&limit=${PAGE}`);
    const rows = await res.json();
    const puts = {}, dels = {};
    for (const row of rows) {
      if (!db.SYNCED.includes(row.kind)) continue;
      const times = await localTimes(row.kind);
      const mine = Math.max(times.get(row.key) || 0, tombs.get(`${row.kind}|${row.key}`) || 0);
      if (mine >= Number(row.updated_at)) continue; // ours is newer or the same
      if (row.deleted) (dels[row.kind] ||= []).push(row.key);
      else (puts[row.kind] ||= []).push(row.data);
      times.set(row.key, Number(row.updated_at));
      applied++;
    }
    for (const [store, values] of Object.entries(puts)) await db.putRaw(store, values);
    for (const [store, keys] of Object.entries(dels)) {
      await db.delRaw(store, keys);
      if (store === 'lessons') await db.delRaw('media', keys).catch(() => {});
    }
    const last = rows.at(-1)?.synced_at;
    if (!last || rows.length < PAGE || last === cursor) { if (last) st.cursor = last; break; }
    st.cursor = last;
  }
  return applied;
}

let running = null;
let again = false;
let onRemote = () => {};

// Sync now (pull, then push). Calls onRemoteChange when other devices changed something.
export function syncNow() {
  if (!activeAccount() || !cloudConfig()) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    setStatus({ state: 'syncing', error: '' });
    try {
      const st = await db.getSetting(STATE_KEY, { pushedAt: 0, cursor: null });
      const pulled = await pull(st);
      await push(st);
      await db.setSetting(STATE_KEY, st);
      setStatus({ state: 'ok', at: Date.now() });
      if (pulled) onRemote(pulled);
    } catch (err) {
      setStatus({ state: navigator.onLine === false ? 'offline' : 'error', error: err.message === 'signed-out' ? 'Signed out — log in again' : err.message });
    } finally {
      running = null;
      if (again) { again = false; syncNow(); }
    }
  })();
  return running;
}

// Start automatic syncing for the active account.
export function startSync({ onRemoteChange } = {}) {
  if (!activeAccount() || !cloudConfig()) { setStatus({ state: 'off' }); return; }
  if (onRemoteChange) onRemote = onRemoteChange;
  let timer;
  db.onChange(() => { clearTimeout(timer); timer = setTimeout(syncNow, DEBOUNCE_MS); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') syncNow(); });
  window.addEventListener('online', () => syncNow());
  return syncNow();
}

// A lesson's audio/video file from the cloud (when it was added on another device).
export async function fetchLessonMedia(lessonId) {
  const acc = activeAccount();
  if (!acc || !cloudConfig()) return null;
  try {
    const res = await api(`/storage/v1/object/authenticated/media/${acc.id}/${encodeURIComponent(lessonId)}`);
    const blob = await res.blob();
    const m = { lessonId, blob, type: blob.type, updatedAt: Date.now(), uploadedAt: Date.now() };
    await db.putRaw('media', [m]);
    return m;
  } catch {
    return null;
  }
}

// Call one of the sync server's Edge Functions (e.g. "transcript").
// -> parsed JSON | null when the function isn't deployed or can't be reached.
export async function callFunction(name, params) {
  const cfg = cloudConfig();
  if (!cfg) return null;
  const acc = activeAccount();
  let token = cfg.anonKey;
  if (acc && isSignedIn(acc)) token = await accessToken(acc).catch(() => cfg.anonKey);
  try {
    const res = await fetch(`${cfg.url}/functions/v1/${name}?${new URLSearchParams(params)}`, {
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Checks that the sync server is set up (tables, function and storage exist).
export async function testServer() {
  await api('/rest/v1/records?select=key&limit=1');
  await api('/rest/v1/rpc/push_records', { method: 'POST', body: { rows: [] } });
  return true;
}
