// IndexedDB storage, one database per account (useDatabase). Data lives on the
// device; with a cloud account, cloud.js syncs it between devices.
//
// Stores:
//   lessons    {id: string, lang, title, kind, source, youtubeId, segments[{text,start?,end?,marks?}],
//               words{term:count}, wordCount, flags, hasMedia, createdAt, openedAt, page, completed, updatedAt}
//   media      {lessonId, blob, type, updatedAt, uploadedAt}   audio/video file attached to a lesson
//   words      {key, lang, term, status, hint, context, contextTr, freq, lessons[], seen, isPhrase,
//               ev, srs, createdAt, updatedAt, knownAt}
//   dict       {key, ...}                                     lookup/AI cache (never synced)
//   activity   {key:"YYYY-MM-DD|lang|device", date, lang, device, known, lingqs, read, reviews, updatedAt}
//   kv         {key, value, updatedAt}                         settings; `secret:*`/`local:*` stay on this device
//   tombstones {key:"store|id", store, id, at}                 deletions, so other devices delete too
//
// Every write to a synced store stamps `updatedAt` (last-write-wins sync) and notifies onChange listeners.

const BASE_NAME = 'lingo-reader';
const DB_VERSION = 2;
export const SYNCED = ['lessons', 'words', 'activity', 'kv'];
const DEVICE_ONLY_KV = /^(secret:|local:)/;

let dbName = BASE_NAME;
let dbPromise = null;

// Switch to an account's own database (null = the guest / this-device-only database).
export function useDatabase(accountId) {
  const name = accountId ? `${BASE_NAME}-${accountId}` : BASE_NAME;
  if (name === dbName && dbPromise) return;
  dbPromise?.then((d) => d.close()).catch(() => {});
  dbPromise = null;
  dbName = name;
}
export const databaseName = () => dbName;

export function deviceId() {
  let id = null;
  try { id = localStorage.getItem('lingo-device'); } catch { /* storage blocked */ }
  if (!id) {
    id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    try { localStorage.setItem('lingo-device', id); } catch { /* storage blocked */ }
  }
  return id;
}

// Lesson ids are strings that are unique across devices.
export const newLessonId = () => `l${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// v1 -> v2: numeric lesson ids become unique strings (so two devices can't collide),
// activity rows get a device id (so per-device counters can be summed after syncing).
function migrateToV2(tx) {
  const device = deviceId();
  const lessons = tx.objectStore('lessons');
  lessons.getAll().onsuccess = (e) => {
    const map = new Map();
    for (const l of e.target.result) {
      if (typeof l.id !== 'number') continue;
      const id = `l${l.id}-${Math.random().toString(36).slice(2, 8)}`;
      map.set(l.id, id);
      lessons.delete(l.id);
      lessons.put({ ...l, id, updatedAt: Date.now() });
    }
    if (!map.size) return;
    const words = tx.objectStore('words');
    words.getAll().onsuccess = (we) => {
      for (const w of we.target.result) {
        if (!w.lessons?.some((id) => map.has(id))) continue;
        words.put({ ...w, lessons: w.lessons.map((id) => map.get(id) ?? id), updatedAt: Date.now() });
      }
    };
    const media = tx.objectStore('media');
    media.getAll().onsuccess = (me) => {
      for (const m of me.target.result) {
        if (!map.has(m.lessonId)) continue;
        media.delete(m.lessonId);
        media.put({ ...m, lessonId: map.get(m.lessonId), updatedAt: Date.now() });
      }
    };
  };
  const activity = tx.objectStore('activity');
  activity.getAll().onsuccess = (e) => {
    for (const a of e.target.result) {
      if (a.key.split('|').length === 3) continue;
      activity.delete(a.key);
      activity.put({ ...a, key: `${a.date}|${a.lang}|${device}`, device, updatedAt: Date.now() });
    }
  };
}

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (e.oldVersion < 1) {
          db.createObjectStore('lessons', { keyPath: 'id', autoIncrement: true }).createIndex('lang', 'lang');
          db.createObjectStore('media', { keyPath: 'lessonId' });
          db.createObjectStore('words', { keyPath: 'key' }).createIndex('lang', 'lang');
          db.createObjectStore('dict', { keyPath: 'key' });
          db.createObjectStore('activity', { keyPath: 'key' }).createIndex('lang', 'lang');
          db.createObjectStore('kv', { keyPath: 'key' });
        }
        if (e.oldVersion < 2) {
          db.createObjectStore('tombstones', { keyPath: 'key' });
          if (e.oldVersion >= 1) migrateToV2(req.transaction);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

// ---------- change tracking ----------

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const synced = (name, key) => SYNCED.includes(name) && !(name === 'kv' && DEVICE_ONLY_KV.test(key));
function stamp(name, value) {
  if (synced(name, value.key)) value.updatedAt = Date.now();
  return value;
}
function notify(name, key) {
  if (synced(name, key)) listeners.forEach((fn) => fn(name));
}

// ---------- normal access (stamped, tombstoned, notified) ----------

export async function get(name, key) { return wrap((await store(name)).get(key)); }
export async function all(name) { return wrap((await store(name)).getAll()); }
export async function byLang(name, lang) { return wrap((await store(name)).index('lang').getAll(lang)); }

export async function put(name, value) {
  const r = await wrap((await store(name, 'readwrite')).put(stamp(name, value)));
  notify(name, value.key);
  return r;
}

export async function putMany(name, values) {
  if (!values.length) return;
  const tx = (await open()).transaction(name, 'readwrite');
  const s = tx.objectStore(name);
  for (const v of values) s.put(stamp(name, v));
  await done(tx);
  if (values.some((v) => synced(name, v.key))) notify(name);
}

export async function del(name, key) {
  if (!synced(name, key)) return wrap((await store(name, 'readwrite')).delete(key));
  const tx = (await open()).transaction([name, 'tombstones'], 'readwrite');
  tx.objectStore(name).delete(key);
  tx.objectStore('tombstones').put({ key: `${name}|${key}`, store: name, id: key, at: Date.now() });
  await done(tx);
  notify(name, key);
}

// Read-modify-write in a single transaction so concurrent updates can't clobber each other.
export async function update(name, key, fn) {
  const tx = (await open()).transaction(name, 'readwrite');
  const s = tx.objectStore(name);
  const req = s.get(key);
  req.onsuccess = () => s.put(stamp(name, fn(req.result)));
  await done(tx);
  notify(name, key);
}

export async function getSetting(key, fallback) {
  const row = await get('kv', key);
  return row ? row.value : fallback;
}
export async function setSetting(key, value) { return put('kv', { key, value }); }

// ---------- raw access for sync (no stamping, no tombstones, no notifications) ----------

export async function putRaw(name, values) {
  if (!values.length) return;
  const tx = (await open()).transaction(name, 'readwrite');
  for (const v of values) tx.objectStore(name).put(v);
  await done(tx);
}
export async function delRaw(name, keys) {
  if (!keys.length) return;
  const tx = (await open()).transaction([name, 'tombstones'], 'readwrite');
  for (const k of keys) {
    tx.objectStore(name).delete(k);
    tx.objectStore('tombstones').delete(`${name}|${k}`);
  }
  await done(tx);
}
export const isSyncedKv = (key) => !DEVICE_ONLY_KV.test(key);

// Full backup / restore (media blobs are excluded to keep the file small).
export async function exportAll() {
  const out = {};
  for (const name of ['lessons', 'words', 'activity', 'kv']) out[name] = await all(name);
  out.kv = out.kv.filter((row) => !DEVICE_ONLY_KV.test(row.key)); // API keys never leave this browser
  return { app: 'lingo-reader', version: 2, exportedAt: new Date().toISOString(), data: out };
}
export async function importAll(backup) {
  if (backup?.app !== 'lingo-reader' || !backup.data) throw new Error('Not a Lingo Reader backup file.');
  for (const [name, rows] of Object.entries(backup.data)) {
    if (['lessons', 'words', 'activity', 'kv'].includes(name)) await putMany(name, rows);
  }
}

// Copy everything (including media) from another local database into this one —
// used to bring guest data into a new account.
export async function copyFrom(otherName) {
  const other = await new Promise((resolve, reject) => {
    const req = indexedDB.open(otherName, DB_VERSION);
    req.onupgradeneeded = () => { req.transaction.abort(); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    for (const name of ['lessons', 'words', 'activity', 'media', 'kv']) {
      const rows = await wrap(other.transaction(name).objectStore(name).getAll());
      await putMany(name, name === 'kv' ? rows.filter((r) => !DEVICE_ONLY_KV.test(r.key)) : rows);
    }
  } finally {
    other.close();
  }
}
