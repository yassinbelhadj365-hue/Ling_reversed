// Offline support: network-first for the app shell (so updates show up immediately),
// falling back to the cached copy when offline.
const CACHE = 'lingo-reader-v6';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icon.svg',
  './js/app.js', './js/db.js', './js/text.js', './js/srs.js', './js/state.js', './js/panel.js', './js/knowledge.js', './js/sync.js', './js/player.js', './js/ai.js', './js/assist.js', './js/asr.js', './js/asr-worker.js', './js/check.js', './js/explain.js', './js/cloud.js', './js/config.js', './js/relay.js', './js/video-ai.js', './js/story.js', './js/youtube.js', './js/samples.js', './js/progress.js', './js/views/account.js',
  './js/views/library.js', './js/views/import.js', './js/views/reader.js', './js/views/review.js',
  './js/views/vocab.js', './js/views/stats.js', './js/views/settings.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' so the install never stores a stale copy from the browser's HTTP cache.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only handle our own files; dictionary APIs and YouTube go straight to the network.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return; // the local server's live answers (transcripts, audio)
  e.respondWith(
    // no-cache: always ask the server whether a file changed (GitHub Pages lets browsers keep
    // files for 10 minutes otherwise, so phones kept running old code after an update).
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
