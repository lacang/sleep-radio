/* 只缓存外壳，不缓存音频流 */
const CACHE = 'sleepradio-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './stations.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  // 音频流 / 跨域请求一律直连，不插手
  if(url.origin !== self.location.origin) return;

  // 台站表优先走网络，失败回落缓存
  if(url.pathname.endsWith('stations.json')){
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 其余：缓存优先，后台更新
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(r => {
        if(r && r.ok){
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
