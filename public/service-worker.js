const CACHE_PREFIX = "srtl-static-";
const MAX_STATIC_CACHES = 2;
const BUILD_REVISION = "__SRTL_BUILD_REVISION__";
const GENERATED_ASSET_URLS = /* __SRTL_GENERATED_ASSETS__ */ [];
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_REVISION}`;
const ACTIVATE_UPDATE_MESSAGE = "SRTL_ACTIVATE_UPDATE";
const PRECACHE_URLS = [
  "/",
  "/base.css",
  "/theme-init.js",
  "/manifest.webmanifest",
  "/icons/srtl-icon.svg",
  "/icons/srtl-icon-192.png",
  "/icons/srtl-icon-512.png",
  "/icons/srtl-maskable-512.png",
  "/icons/apple-touch-icon.png",
  ...GENERATED_ASSET_URLS
];
const STATIC_SHELL_PATHS = new Set(PRECACHE_URLS.filter((url) => url !== "/"));

function isExcludedPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/documentation" || pathname.startsWith("/documentation/");
}

function isStaticShellRequest(request, url) {
  return url.pathname.startsWith("/assets/") || STATIC_SHELL_PATHS.has(url.pathname);
}

function isCacheableResponse(response) {
  return response.ok && (response.type === "basic" || response.type === "default");
}

async function matchPreviousStaticCache(request) {
  const cacheNames = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).reverse();
  for (const cacheName of cacheNames) {
    const cached = await (await caches.open(cacheName)).match(request);
    if (cached) return cached;
  }
  return undefined;
}

async function cacheStaticRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const retainedCached = await matchPreviousStaticCache(request);
  if (retainedCached) return retainedCached;

  const response = await fetch(request);
  if (isCacheableResponse(response)) await cache.put(request, response.clone());
  return response;
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    return await fetch(request);
  } catch (error) {
    const shell = await cache.match("/");
    if (shell) return shell;
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(async (error) => {
        await caches.delete(CACHE_NAME);
        throw error;
      })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => {
        const appCaches = names.filter((name) => name.startsWith(CACHE_PREFIX));
        const previousCaches = appCaches.filter((name) => name !== CACHE_NAME).slice(-(MAX_STATIC_CACHES - 1));
        const retainedCaches = new Set([CACHE_NAME, ...previousCaches]);
        return Promise.all(appCaches.filter((name) => !retainedCaches.has(name)).map((name) => caches.delete(name)));
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === ACTIVATE_UPDATE_MESSAGE) self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isExcludedPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isStaticShellRequest(request, url)) event.respondWith(cacheStaticRequest(request));
});
