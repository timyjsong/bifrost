/* Bifrost service worker — Web Push receiver. Hand-written (no build step) so the
 * push/notification handlers stay dead simple and fully in our control. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// App-shell freshness. iOS standalone PWAs cling to a cached start page even
// past `no-cache` — and after a rebuild that page points at asset hashes that no
// longer exist, so the app loads blank. Serve navigations network-first (cache:
// no-store) so a rebuild just appears. Hashed assets (immutable) and /api/* are
// not navigations, so they fall through to the network untouched.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request, { cache: "no-store" }));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Bifrost", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Bifrost";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag, // collapse-key: a repeat replaces, doesn't stack
      renotify: !!data.tag,
      data: { url: data.url || "/" },
      icon: "/favicon.svg",
      badge: "/favicon.svg",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        for (const w of wins) {
          if ("focus" in w) {
            if ("navigate" in w) w.navigate(url);
            return w.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
