/* sw.js — service worker: offline shell, install support, background reminders */
const CACHE_NAME = "hark-lite-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./ai.js",
  "./tools.js",
  "./storage.js",
  "./manifest.json",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ---------- reminders scheduled from the page ---------- */
self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type === "remind") {
    const delay = Math.max(0, Math.min(d.at - Date.now(), 2147483000));
    setTimeout(() => {
      self.registration.showNotification("⏰ hark reminder", {
        body: d.text,
        icon: "icon.svg",
        tag: "r" + d.id
      }).catch(() => {});
      /* also ping any open page so it can alert/mark fired */
      self.clients.matchAll({ includeUncontrolled: true }).then((cs) =>
        cs.forEach((c) => c.postMessage({ type: "remind-fired", id: d.id, text: d.text }))
      );
    }, delay);
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  /* AI + web-lookup traffic always goes to the network — never cached */
  if (url.hostname.endsWith("pollinations.ai")) return;
  if (url.hostname === "r.jina.ai" || url.hostname.endsWith("wikipedia.org")) return;

  if (event.request.method !== "GET" || !url.origin.startsWith("http")) return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) =>
      hit ??
      fetch(event.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        }
        return res;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
