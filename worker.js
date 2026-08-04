/**
 * Baseline push worker — Cloudflare Workers + KV + Cron
 *
 * Sends a payload-less Web Push on a schedule and keeps re-sending until the
 * check-in is logged or skipped. No payload means no aes128gcm encryption to
 * implement or get wrong; the service worker wakes up and asks GET /due what
 * to say.
 *
 * KV namespace binding: BASELINE
 *   sub:<uid>     { sub, tz, windows[], nagMins, subject, createdAt }
 *   state:<uid>   { date, done[], skipped[], snoozeUntil }
 *   push:<uid>    { lastSent, failures }
 *   backup:<uid>  <json string>
 *
 * Secrets (wrangler secret put):
 *   VAPID_PRIVATE  base64url 32-byte P-256 scalar (the "d" value)
 *   VAPID_PUBLIC   base64url 65-byte uncompressed point
 *   VAPID_SUBJECT  mailto:you@example.com
 *   ALLOW_ORIGIN   https://melgard05.github.io   (optional; defaults to *)
 */

const enc = new TextEncoder();

/* ---------- base64url ---------- */
function b64url(buf) {
  const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const raw = atob(s), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ---------- CORS ---------- */
function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
function json(data, env, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors(env))
  });
}

/* ---------- VAPID ---------- */
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:baseline@example.com"
  };
  const part = o => b64url(enc.encode(JSON.stringify(o)));
  const unsigned = part(header) + "." + part(payload);

  const d = fromB64url(env.VAPID_PRIVATE);
  const pub = fromB64url(env.VAPID_PUBLIC);          // 0x04 || X(32) || Y(32)
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    d: b64url(d),
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65))
  };
  const key = await crypto.subtle.importKey("jwk", jwk,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto ECDSA returns raw r||s (64 bytes) — exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  return "vapid t=" + unsigned + "." + b64url(sig) + ", k=" + env.VAPID_PUBLIC;
}

async function sendPush(sub, env, urgency) {
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidAuth(sub.endpoint, env),
      "TTL": "1800",
      "Urgency": urgency || "high",
      "Content-Length": "0"
    }
  });
  return res.status;
}

/* ---------- local time in a tz ---------- */
function localParts(tz) {
  try {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
    const p = {};
    f.formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
    const h = (+p.hour) % 24;
    return { date: p.year + "-" + p.month + "-" + p.day, mins: h * 60 + (+p.minute) };
  } catch (e) {
    const d = new Date();
    return { date: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
}
const toMins = t => { const p = String(t || "0:0").split(":"); return (+p[0] || 0) * 60 + (+p[1] || 0); };

/* Chosen days can have their own time. altDays is 0=Sun … 6=Sat. */
function winTimeFor(w, dateISO, altDays) {
  if (!w.timeWe || !Array.isArray(altDays) || !altDays.length) return w.time;
  const p = String(dateISO).split("-");
  const dow = new Date(Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1)).getUTCDay();
  return altDays.indexOf(dow) > -1 ? w.timeWe : w.time;
}

/* Subscriptions are per device. Check-in state is per person — logging on the
   phone has to silence the desktop too, so state hangs off the account. */
const acctOf = (rec, uid) => (rec && rec.account) || uid;

/* ---------- what's due for one subscriber ---------- */
async function dueFor(uid, rec, env) {
  const now = localParts(rec.tz);
  const acct = acctOf(rec, uid);
  let st = null;
  try { st = JSON.parse(await env.BASELINE.get("state:" + acct) || "null"); } catch (e) {}
  if (!st || st.date !== now.date) st = { date: now.date, done: [], skipped: [], snoozeUntil: 0 };
  const closed = (st.done || []).concat(st.skipped || []);
  const due = (rec.windows || []).filter(w =>
    toMins(winTimeFor(w, now.date, rec.altDays)) <= now.mins && closed.indexOf(w.id) < 0);
  return { due, state: st, now, acct };
}

/* ---------- HTTP ---------- */
async function handle(req, env) {
  const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

  if (p === "/" || p === "/health")
    return json({ ok: true, service: "baseline-push", vapidPublic: env.VAPID_PUBLIC || null }, env);

  if (p === "/vapid") return json({ publicKey: env.VAPID_PUBLIC || null }, env);

  if (p === "/subscribe" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !b.uid || !b.sub || !b.sub.endpoint) return json({ error: "need uid and sub" }, env, 400);
    await env.BASELINE.put("sub:" + b.uid, JSON.stringify({
      sub: b.sub,
      account: (b.account || b.uid),
      tz: b.tz || "UTC",
      windows: Array.isArray(b.windows) ? b.windows : [],
      altDays: Array.isArray(b.altDays) ? b.altDays : [],
      digest: b.digest !== false,
      digestDow: b.digestDow == null ? 0 : +b.digestDow,
      digestMin: b.digestMin == null ? 18 * 60 : +b.digestMin,
      nagMins: Math.max(5, Math.min(180, +b.nagMins || 20)),
      createdAt: new Date().toISOString()
    }));
    return json({ ok: true, uid: b.uid, account: (b.account || b.uid) }, env);
  }

  if (p === "/unsubscribe" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !b.uid) return json({ error: "need uid" }, env, 400);
    await env.BASELINE.delete("sub:" + b.uid);
    await env.BASELINE.delete("push:" + b.uid);
    return json({ ok: true }, env);
  }

  /* app tells the worker which check-ins are closed so nagging stops.
     Keyed on the account, so closing one on the phone also silences the desktop. */
  if (p === "/state" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !b.uid) return json({ error: "need uid" }, env, 400);
    const rec = JSON.parse(await env.BASELINE.get("sub:" + b.uid) || "null");
    const acct = b.account || acctOf(rec, b.uid);
    const prev = JSON.parse(await env.BASELINE.get("state:" + acct) || "null") || {};
    // Union rather than replace. A device that hasn't finished syncing yet reports a
    // partial list, and overwriting with it would re-open check-ins done elsewhere.
    const sameDay = prev.date === b.date;
    const uni = (a, c) => Array.from(new Set((sameDay ? (a || []) : []).concat(c || [])));
    const done = uni(prev.done, b.done);
    const skipped = uni(prev.skipped, b.skipped).filter(id => done.indexOf(id) < 0);
    await env.BASELINE.put("state:" + acct, JSON.stringify({
      date: b.date,
      done: done,
      skipped: skipped,
      snoozeUntil: b.snoozeUntil != null ? b.snoozeUntil : (sameDay ? (prev.snoozeUntil || 0) : 0)
    }), { expirationTtl: 60 * 60 * 72 });
    // reset the nag clock on every device belonging to this account
    const subs = await env.BASELINE.list({ prefix: "sub:" });
    for (const k of subs.keys) {
      const r = JSON.parse(await env.BASELINE.get(k.name) || "null");
      if (r && acctOf(r, k.name.slice(4)) === acct) await env.BASELINE.delete("push:" + k.name.slice(4));
    }
    return json({ ok: true, account: acct }, env);
  }

  /* the service worker calls this on wake to find out what to say, and the app
     calls it to learn what was closed on a different device */
  if (p === "/due") {
    const uid = url.searchParams.get("uid");
    const acctQ = url.searchParams.get("account");
    if (!uid && !acctQ) return json({ error: "need uid or account" }, env, 400);
    const rec = uid ? JSON.parse(await env.BASELINE.get("sub:" + uid) || "null") : null;
    if (!rec) {
      // No subscription for this device — it may simply not have push enabled.
      // It still needs to know what the account has closed today.
      if (!acctQ) return json({ due: [], count: 0, closed: [], done: [], skipped: [] }, env);
      let st = null;
      try { st = JSON.parse(await env.BASELINE.get("state:" + acctQ) || "null"); } catch (e) {}
      const done = (st && st.done) || [], skipped = (st && st.skipped) || [];
      return json({ due: [], count: 0, date: st && st.date,
        closed: done.concat(skipped), done: done, skipped: skipped,
        test: false, digest: false, noSubscription: true }, env);
    }
    const { due, state, now } = await dueFor(uid, rec, env);
    let isTest = false, isDigest = false;
    if (await env.BASELINE.get("test:" + uid)) { isTest = true; await env.BASELINE.delete("test:" + uid); }
    if (await env.BASELINE.get("digest:" + uid)) { isDigest = true; await env.BASELINE.delete("digest:" + uid); }
    return json({
      test: isTest,
      digest: isDigest,
      count: due.length,
      due: due.map(w => ({ id: w.id, label: w.label, time: winTimeFor(w, now.date, rec.altDays) })),
      closed: (state.done || []).concat(state.skipped || []),
      done: state.done || [],
      skipped: state.skipped || [],
      date: now.date
    }, env);
  }

  if (p === "/snooze" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !b.uid) return json({ error: "need uid" }, env, 400);
    const rec = JSON.parse(await env.BASELINE.get("sub:" + b.uid) || "null");
    const acct = acctOf(rec, b.uid);
    const st = JSON.parse(await env.BASELINE.get("state:" + acct) || "null") || { done: [], skipped: [] };
    st.snoozeUntil = Date.now() + Math.max(1, Math.min(240, +b.mins || 15)) * 60000;
    await env.BASELINE.put("state:" + acct, JSON.stringify(st), { expirationTtl: 60 * 60 * 72 });
    return json({ ok: true, until: st.snoozeUntil }, env);
  }

  /* optional whole-dataset snapshot, last write wins */
  if (p === "/backup") {
    const uid = url.searchParams.get("uid");
    if (!uid) return json({ error: "need uid" }, env, 400);
    if (req.method === "POST") {
      const body = await req.text();
      if (body.length > 20 * 1024 * 1024) return json({ error: "too large" }, env, 413);
      await env.BASELINE.put("backup:" + uid, body);
      await env.BASELINE.put("backupmeta:" + uid,
        JSON.stringify({ at: new Date().toISOString(), bytes: body.length }));
      return json({ ok: true, bytes: body.length }, env);
    }
    const blob = await env.BASELINE.get("backup:" + uid);
    if (!blob) return json({ error: "no backup" }, env, 404);
    return new Response(blob, {
      headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors(env))
    });
  }

  if (p === "/backupmeta") {
    const uid = url.searchParams.get("uid");
    const m = await env.BASELINE.get("backupmeta:" + uid);
    return json(m ? JSON.parse(m) : { at: null }, env);
  }

  /* manual trigger, handy for testing without waiting for cron.
     Raises a one-shot flag so the service worker shows a notification even
     when nothing is actually due — otherwise a test is invisible by design. */
  if (p === "/test" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const rec = JSON.parse(await env.BASELINE.get("sub:" + b.uid) || "null");
    if (!rec) return json({ error: "not subscribed" }, env, 404);
    await env.BASELINE.put("test:" + b.uid, "1", { expirationTtl: 300 });
    const status = await sendPush(rec.sub, env);
    const ok = status >= 200 && status < 300;
    if (!ok) await env.BASELINE.delete("test:" + b.uid);
    return json({ ok, status,
      note: ok ? "accepted by the push service — it should appear on that device"
               : "push service rejected it" }, env);
  }

  /* which devices are registered — handy when reminders only reach one of them */
  if (p === "/devices") {
    const list = await env.BASELINE.list({ prefix: "sub:" });
    const out = [];
    for (const k of list.keys) {
      const r = JSON.parse(await env.BASELINE.get(k.name) || "null");
      if (!r) continue;
      out.push({ uid: k.name.slice(4), account: acctOf(r, k.name.slice(4)), tz: r.tz,
        windows: (r.windows || []).length, altDays: r.altDays || [],
        host: (function () { try { return new URL(r.sub.endpoint).host; } catch (e) { return "?"; } })(),
        since: r.createdAt });
    }
    return json({ count: out.length, devices: out }, env);
  }

  return json({ error: "not found" }, env, 404);
}

/* ---------- cron ---------- */
async function tick(env) {
  const list = await env.BASELINE.list({ prefix: "sub:" });
  const report = [];
  for (const k of list.keys) {
    const uid = k.name.slice(4);
    const rec = JSON.parse(await env.BASELINE.get(k.name) || "null");
    if (!rec || !rec.sub) continue;

    // once a week, a nudge to look at the summary
    const lp = localParts(rec.tz);
    const dowNow = new Date(lp.date + "T00:00:00Z").getUTCDay();
    const wantDow = rec.digestDow == null ? 0 : rec.digestDow;      // Sunday
    const wantMin = rec.digestMin == null ? 18 * 60 : rec.digestMin; // 18:00 local
    if (rec.digest !== false && dowNow === wantDow && lp.mins >= wantMin) {
      const seen = await env.BASELINE.get("digestdone:" + uid);
      if (seen !== lp.date) {
        await env.BASELINE.put("digestdone:" + uid, lp.date, { expirationTtl: 60 * 60 * 24 * 8 });
        await env.BASELINE.put("digest:" + uid, "1", { expirationTtl: 3600 });
        try { await sendPush(rec.sub, env, "normal"); } catch (e) {}
        report.push(uid + ":digest");
      }
    }

    const { due, state } = await dueFor(uid, rec, env);
    if (!due.length) { await env.BASELINE.delete("push:" + uid); continue; }
    if (state.snoozeUntil && Date.now() < state.snoozeUntil) { report.push(uid + ":snoozed"); continue; }

    const pk = "push:" + uid;
    const pstate = JSON.parse(await env.BASELINE.get(pk) || "null") || { lastSent: 0, failures: 0 };
    const gap = (rec.nagMins || 20) * 60000;
    if (Date.now() - pstate.lastSent < gap) { report.push(uid + ":waiting"); continue; }

    let status = 0;
    try { status = await sendPush(rec.sub, env); } catch (e) { status = 0; }

    if (status === 404 || status === 410) {
      // subscription is dead — stop pushing to it
      await env.BASELINE.delete(k.name);
      await env.BASELINE.delete(pk);
      report.push(uid + ":gone(" + status + ")");
      continue;
    }
    const okSend = status >= 200 && status < 300;
    await env.BASELINE.put(pk, JSON.stringify({
      lastSent: Date.now(),
      failures: okSend ? 0 : (pstate.failures || 0) + 1
    }), { expirationTtl: 60 * 60 * 48 });
    report.push(uid + ":" + status + "(" + due.length + " due)");
  }
  console.log("baseline tick", report.join(" | ") || "nothing due");
}

export default {
  fetch: (req, env) => handle(req, env).catch(e =>
    json({ error: String(e && e.message || e) }, env, 500)),
  scheduled: (evt, env, ctx) => ctx.waitUntil(tick(env))
};
