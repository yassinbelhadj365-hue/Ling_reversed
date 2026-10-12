// IndexedDB storage. Everything lives on the device; nothing is sent anywhere
// except dictionary lookups (see dict.js).
//
// Stores:
//   lessons   {id, lang, title, kind, source, mediaUrl, segments[{text,start?}], words{norm:count},
//              wordCount, createdAt, openedAt, page, completed}
//   media     {lessonId, blob, type}               audio/video file attached to a lesson
//   words     {key, lang, term, status, hint, notes, context, freq, lessons[], seen,
//              isPhrase, createdAt, updatedAt, knownAt, srs{due,interval,ease,reps}}
//   dict      {key, results, at}                    dictionary lookup cache
//   activity  {key:"YYYY-MM-DD|lang", date, lang, known, lingqs, read, reviews}
//   kv        {key, value}                          settings

const DB_NAME = 'lingo-reader';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('lessons', { keyPath: 'id', autoIncrement: true }).createIndex('lang', 'lang');
        db.createObjectStore('media', { keyPath: 'lessonId' });
        db.createObjectStore('words', { keyPath: 'key' }).createIndex('lang', 'lang');
        db.createObjectStore('dict', { keyPath: 'key' });
        db.createObjectStore('activity', { keyPath: 'key' }).createIndex('lang', 'lang');
        db.createObjectStore('kv', { keyPath: 'key' });
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

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function get(name, key) { return wrap((await store(name)).get(key)); }
export async function put(name, value) { return wrap((await store(name, 'readwrite')).put(value)); }
export async function del(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); }
export async function all(name) { return wrap((await store(name)).getAll()); }
export async function byLang(name, lang) { return wrap((await store(name)).index('lang').getAll(lang)); }

export async function putMany(name, values) {
  if (!values.length) return;
  const tx = (await open()).transaction(name, 'readwrite');
  const s = tx.objectStore(name);
  for (const v of values) s.put(v);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Read-modify-write in a single transaction so concurrent updates can't clobber each other.
export async function update(name, key, fn) {
  const tx = (await open()).transaction(name, 'readwrite');
  const s = tx.objectStore(name);
  const req = s.get(key);
  req.onsuccess = () => s.put(fn(req.result));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSetting(key, fallback) {
  const row = await get('kv', key);
  return row ? row.value : fallback;
}
export async function setSetting(key, value) { return put('kv', { key, value }); }

// Full backup / restore (media blobs are excluded to keep the file small).
export async function exportAll() {
  const out = {};
  for (const name of ['lessons', 'words', 'activity', 'kv']) out[name] = await all(name);
  out.kv = out.kv.filter((row) => !row.key.startsWith('secret:')); // API keys never leave this browser
  return { app: 'lingo-reader', version: 1, exportedAt: new Date().toISOString(), data: out };
}
export async function importAll(backup) {
  if (backup?.app !== 'lingo-reader' || !backup.data) throw new Error('Not a Lingo Reader backup file.');
  for (const [name, rows] of Object.entries(backup.data)) {
    if (['lessons', 'words', 'activity', 'kv'].includes(name)) await putMany(name, rows);
  }
}
