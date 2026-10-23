// StarBrain service worker：只負責讓 App 能安裝、開啟更快；資料（/api）一律不快取
// 改了這個檔案或要強制清掉舊快取時，把版本號加一
const CACHE = 'starbrain-v2'
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

async function put(request, response) {
  if (response.ok) {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
  }
  return response
}

// 電腦關機時，Cloudflare 會回 502/503/504 或 520–530 的錯誤頁，這些也視為沒網路
const isGatewayError = (status) => status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)

// 開頁面：優先拿最新的 index.html；連不到電腦時改用快取的外殼，App 才打得開
async function networkFirst(request) {
  let response = null
  try {
    response = await fetch(request)
  } catch {
    // 連不上，往下用快取
  }
  if (response && !isGatewayError(response.status)) return put('/', response)
  const cached = await caches.match('/')
  // 沒有快取就把原本的回應（或網路錯誤）交給瀏覽器
  return cached ?? response ?? Response.error()
}

// /assets/ 的檔名帶 hash，內容不會變，有快取就直接用
async function cacheFirst(request) {
  const cached = await caches.match(request)
  return cached ?? put(request, await fetch(request))
}

// 其他靜態檔：先給快取的，同時在背景更新
async function staleWhileRevalidate(event) {
  const cached = await caches.match(event.request)
  const refresh = fetch(event.request).then((response) => put(event.request, response))
  if (cached) {
    event.waitUntil(refresh.catch(() => {}))
    return cached
  }
  return refresh
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return // 不處理，交給瀏覽器直接連網路

  if (request.mode === 'navigate') event.respondWith(networkFirst(request))
  else if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirst(request))
  else event.respondWith(staleWhileRevalidate(event))
})
