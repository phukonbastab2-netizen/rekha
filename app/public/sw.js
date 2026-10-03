const CACHE = 'rekha-shell-v26';
// Only public customer code and artwork enter this cache. Chats, cookies,
// private media and owner routes stay outside CacheStorage.
const PUBLIC = ['/index.html','/offline.html','/styles.css','/chat.css','/media.css','/calls.css','/permissions.css','/app.js','/media.js','/countdown.js','/locales.js','/messaging-ui.js','/calls.js','/send-queue.js','/adaptive-poll.js','/chat-history.js','/device-chat-store.js','/chat-icons.js','/chat-sounds.js','/video-onboarding.js','/permissions.js','/voice-effects.js','/voice-effects-worklet.js','/icon-192.png','/rekha-portrait.png','/art.svg','/manifest.webmanifest'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PUBLIC))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;
  if (event.request.mode === 'navigate') { event.respondWith(fetch(event.request).then(response=>{if(response.ok&&['/','/index.html'].includes(url.pathname))event.waitUntil(caches.open(CACHE).then(cache=>cache.put('/index.html',response.clone())));return response;}).catch(async()=>await caches.match(['/', '/index.html'].includes(url.pathname)?'/index.html':'/offline.html')||Response.error())); return; }
  if (PUBLIC.includes(url.pathname)) event.respondWith(fetch(event.request).then(response=>{if(response.ok)event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,response.clone())));return response;}).catch(async()=>await caches.match(event.request)||Response.error()));
});
