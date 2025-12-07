// Update cache name when core assets change. Bump the version number
// whenever new core files (like the main JS) are added or removed.
const CACHE_NAME = 'motorhouse-cache-v2';

// Files we want to cache for offline usage. When updating version numbers
// or adding new core files, update this array accordingly. The root
// path ("/") is cached implicitly by caching index.html.
const FILES_TO_CACHE = [
  '/',
  '/index.html',
  // Cache the latest main script. If this file is updated, update the version and
  // service worker accordingly.
  '/motorhouse-os-v30.js',
  '/manifest.json'
];

// Install event: populate cache with core files.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(FILES_TO_CACHE);
    })
  );
});

// Activate event: clean up old caches if necessary.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Fetch event: serve cached responses when available, otherwise fall back
// to network. This simple strategy helps the app work offline and
// provides basic caching for other assets.
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});