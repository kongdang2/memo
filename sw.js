// 홈 화면 설치 + 오프라인용 서비스 워커(v2.27) + 푸시 알림(v2.30)
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
// 푸시 알림(v2.30) — 서버(Edge Function 'pushcron')가 보낸 알림을 띄운다. 앱을 닫아 둬도 온다
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '일정 알림', {
    body: d.body || '', tag: d.tag || 'pms', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: self.registration.scope },
  }));
});
// 알림을 누르면 설치한 앱(홈 화면 아이콘) 창으로 간다 — 앱 창은 주소에 ?app=1 이 붙어 있다(v2.30.2)
// 열린 앱 창이 있으면 그 창을, 없으면 앱 주소를 연다(설치돼 있으면 폰이 브라우저 대신 앱으로 연다)
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = self.registration.scope + '?app=1';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if (w.url.startsWith(self.registration.scope) && /[?&]app=1/.test(w.url) && 'focus' in w) return w.focus();
    return self.clients.openWindow(url);
  }));
});
