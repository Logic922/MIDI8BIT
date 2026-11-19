/* MIDI8BIT service worker
   —— 版本号由 build.mjs 注入（__BUILD_ID__ ← 产物 sha1 前 10 位），不要手改。
   每次构建产物变了 → 这个文件也变 → 浏览器装新 SW → activate 清掉旧缓存。

   策略：
   · 导航请求   network-first（4s 超时回退缓存，再退 offline.html）
   · 静态资源   stale-while-revalidate（先给缓存，后台刷新）
   · 非 GET / 跨域请求一律不管，交回浏览器 */
const BUILD_ID = '__BUILD_ID__';
const CACHE = 'midi8bit-' + BUILD_ID;
const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'offline.html',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 单个资源失败不阻断安装（离线时也能装）
    await Promise.allSettled(CORE.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

function sameOrigin(url) {
  try { return new URL(url).origin === self.location.origin; } catch (e) { return false; }
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !sameOrigin(req.url)) return;

  // 导航：网络优先
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await Promise.race([fetch(req), timeout(4000)]);
        if (res && res.ok) {
          cache.put('index.html', res.clone()).catch(() => {});
          return res;
        }
        throw new Error('bad status ' + (res && res.status));
      } catch (e) {
        const hit = await cache.match('index.html') || await cache.match('./');
        if (hit) return hit;
        const off = await cache.match('offline.html');
        return off || new Response('offline', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // 静态资源：先缓存，后台刷新
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(network.then(() => {}));
      return cached;
    }
    const res = await network;
    return res || new Response('', { status: 504, statusText: 'offline' });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'ping') event.source && event.source.postMessage('pong');
});
