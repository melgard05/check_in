/* Baseline service worker — sticky check-in notifications + offline shell */

const CACHE = "baseline-v3";
const SHELL = ["./", "./index.html", "./manifest.json"];

/* WORKER_URL and UID are written in by the app on first subscribe. */
let CFG = { worker: "", uid: "" };

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* the page hands us the worker URL + uid so the push handler can call /due */
self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "skip-waiting") { self.skipWaiting(); return; }
  if (d.type === "clear-notifs") {
    e.waitUntil((async () => {
      try {
        const open = await self.registration.getNotifications();
        open.forEach(n => { if (n.tag && n.tag.indexOf("baseline") === 0 && n.tag !== "baseline-digest") n.close(); });
      } catch (err) {}
      try { if (self.navigator && navigator.clearAppBadge) await navigator.clearAppBadge(); } catch (err) {}
    })());
    return;
  }
  if (d.type === "config") {
    CFG.worker = d.worker || "";
    CFG.uid = d.uid || "";
    // stash it so it survives the SW being killed between pushes
    caches.open(CACHE).then(c =>
      c.put("__cfg", new Response(JSON.stringify(CFG), { headers: { "Content-Type": "application/json" } })));
  }
});

async function loadCfg() {
  if (CFG.worker && CFG.uid) return CFG;
  try {
    const c = await caches.open(CACHE);
    const r = await c.match("__cfg");
    if (r) CFG = await r.json();
  } catch (e) {}
  return CFG;
}

/* offline shell: network first for the html so updates land, cache as fallback */
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // the build poll is cache-busted and ranged; caching it would grow the shell
  // cache by one entry every few minutes
  if (req.headers.get("range") || new URL(req.url).searchParams.has("cb")) return;
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then(r => r || new Response("Offline", { status: 503 })))
  );
});

/* ---------- push: no payload, so ask the worker what's open ---------- */
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    const cfg = await loadCfg();
    let due = [], count = 0, isTest = false, isDigest = false;

    if (cfg.worker && cfg.uid) {
      try {
        const r = await fetch(cfg.worker.replace(/\/+$/, "") + "/due?uid=" + encodeURIComponent(cfg.uid),
          { cache: "no-store" });
        if (r.ok) { const j = await r.json(); due = j.due || []; count = j.count || 0;
          isTest = !!j.test; isDigest = !!j.digest; }
      } catch (err) {}
    }
    // if a payload did come through, prefer it
    if (!count && e.data) {
      try { const j = e.data.json(); due = j.due || []; count = j.count || due.length; } catch (err) {}
    }

    if (isTest) {
      try { if (self.navigator && navigator.setAppBadge) await navigator.setAppBadge(count || 1); } catch (err) {}
      return self.registration.showNotification("Push is working", {
        body: count ? count + " check-in" + (count > 1 ? "s" : "") + " open right now."
                    : "Test notification. Nothing is due at the moment.",
        tag: "baseline-test", renotify: true, icon: "./icon-192.png", badge: "./icon-badge.png",
        data: { test: true }
      });
    }

    if (isDigest) {
      return self.registration.showNotification("Your week in review", {
        body: "Seven days of check-ins are summarised in Patterns.",
        tag: "baseline-digest", renotify: false, requireInteraction: false,
        icon: "./icon-192.png", badge: "./icon-badge.png", data: { digest: true }
      });
    }

    if (!count) {
      // Nothing open. Take down any prompt still on screen and clear the badge —
      // a sticky notification does not remove itself when the check-in gets done
      // somewhere else.
      try { if (self.navigator && navigator.clearAppBadge) await navigator.clearAppBadge(); } catch (err) {}
      try {
        const open = await self.registration.getNotifications();
        open.forEach(n => { if (n.tag && n.tag.indexOf("baseline") === 0 && n.tag !== "baseline-digest") n.close(); });
      } catch (err) {}
      // userVisibleOnly still has to be honoured, so leave one quiet, self-explanatory note
      return self.registration.showNotification("All caught up", {
        body: "That check-in was logged on another device.",
        tag: "baseline-checkin", renotify: false, requireInteraction: false,
        silent: true, icon: "./icon-192.png", badge: "./icon-badge.png",
        data: { transient: true }
      });
    }

    const names = due.map(w => w.label).join(", ");
    const title = count === 1 ? names + " check-in" : count + " check-ins open";
    const body = count === 1
      ? "Still open. This keeps coming back until you log it or skip it."
      : names + " — all still open.";

    try { if (self.navigator && navigator.setAppBadge) await navigator.setAppBadge(count); } catch (err) {}

    return self.registration.showNotification(title, {
      body,
      tag: "baseline-checkin",     // one notification, replaced not stacked
      renotify: true,              // but re-alert each time it's re-sent
      requireInteraction: true,    // desktop: stays until touched
      silent: false,
      badge: "./icon-badge.png",
      icon: "./icon-192.png",
      data: { count, due, at: Date.now() },
      actions: [
        { action: "log", title: "Log it" },
        { action: "snooze", title: "Snooze 15m" }
      ]
    });
  })());
});

self.addEventListener("notificationclick", e => {
  const act = e.action, data = e.notification.data || {};
  e.notification.close();

  e.waitUntil((async () => {
    const cfg = await loadCfg();

    if (act === "snooze") {
      if (cfg.worker && cfg.uid) {
        try {
          await fetch(cfg.worker.replace(/\/+$/, "") + "/snooze", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uid: cfg.uid, mins: 15 })
          });
        } catch (err) {}
      }
      return;
    }

    // open or focus THIS app, and tell it to jump straight to the open check-in.
    // Match on the registration scope — matching on origin alone would focus
    // whatever other app on this domain happened to have a tab open.
    const scope = self.registration.scope;
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.indexOf(scope) === 0) {
        await c.focus();
        c.postMessage({ type: "open-checkin", due: data.due || [] });
        return;
      }
    }
    await self.clients.openWindow(scope);
  })());
});

self.addEventListener("notificationclose", e => {
  // dismissing does not count as done — the cron will bring it back
});

/* let the page force a re-check */
self.addEventListener("pushsubscriptionchange", e => {
  e.waitUntil((async () => {
    const cfg = await loadCfg();
    if (!cfg.worker || !cfg.uid) return;
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (!sub) return;
      await fetch(cfg.worker.replace(/\/+$/, "") + "/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: cfg.uid, sub: sub.toJSON(),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
      });
    } catch (err) {}
  })());
});
