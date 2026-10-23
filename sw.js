// 홈 화면 설치 + 오프라인용 서비스 워커(v2.27)
// · 이 앱의 파일: 네트워크 우선, 끊겼을 때만 마지막으로 받은 것
// · 라이브러리·글꼴(CDN): 받아 둔 것을 먼저 쓰고 뒤에서 새로 받아 둔다 — 오프라인에서도 앱이 뜨게
const CACHE = 'cal-shell-v2';
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//;
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('cal-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (CDN.test(req.url)) {
    e.respondWith(caches.open(CACHE).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; });
      if (hit) { net.catch(() => {}); return hit; }
      return net;
    })));
    return;
  }
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then(r => r || (req.mode === 'navigate' ? caches.match(self.registration.scope).then(x => x || caches.match(self.registration.scope + 'index.html')) : undefined))
    .then(r => r || Response.error())));
});
