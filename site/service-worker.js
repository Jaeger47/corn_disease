const CACHE_NAME = "cornleaf-v9";
const CACHEABLE_ORIGINS = new Set([self.location.origin, "https://cdn.jsdelivr.net"]);
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=6",
  "./app.js?v=7",
  "./manifest.json",
  "./logo.png",
  "./demo-leaf.jpg",
  "./images/common-rust.jpg",
  "./images/gray-leaf-spot.png",
  "./images/northern-leaf-blight.jpg",
  "./menu/",
  "./menu/index.html",
  "./menu/corn_mang.html",
  "./menu/corn.png",
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.wasm.min.js",
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort-wasm-simd-threaded.mjs",
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort-wasm-simd-threaded.wasm"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const origin = new URL(event.request.url).origin;
        if ((response.ok || response.type === "opaque") && CACHEABLE_ORIGINS.has(origin)) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
