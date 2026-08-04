# Baseline — setup

Two halves. The app on GitHub Pages, the reminder engine on Cloudflare.
The app works without the Worker; you just lose reminders that survive the app being closed.

---

## 1. GitHub Pages

Drop these in the repo root (same folder, all of them — the service worker's scope
depends on it):

```
index.html
sw.js
manifest.json
icon-192.png
icon-512.png
icon-badge.png
```

That's it. `https://melgard05.github.io/check_in/`

**Install it to the home screen.** On iOS this is mandatory — Safari only allows
push for installed PWAs, and the app-icon badge won't appear otherwise. Share →
Add to Home Screen. On Android, Chrome will offer Install.

---

## 2. Cloudflare Worker

```bash
npm install -g wrangler
wrangler login

# KV namespace — paste the returned id into wrangler.toml
wrangler kv namespace create BASELINE

# secrets (values are in vapid-keys.json)
wrangler secret put VAPID_PUBLIC      # BPrnW2BgDOCAj0CNQbaPFmDL9Q28-t_ItQkxE9ILtH6U0cjcFnbMImsgzElfgG0gymlDAfB8shJyHIfq_pIlpdI
wrangler secret put VAPID_PRIVATE     # xP0thk9K7kbmhvjOU8yxr2ao1zo1O6ltQtvfKJqTvAA
wrangler secret put VAPID_SUBJECT     # mailto:your@email.com
wrangler secret put ALLOW_ORIGIN      # https://melgard05.github.io

wrangler deploy
```

`VAPID_SUBJECT` has to be a real mailto: you own — push services use it to contact
you if your pushes start misbehaving, and some will reject a bogus one.

`ALLOW_ORIGIN` is the CORS lock. Leave it unset and any site can call your Worker.

**Check it:** open `https://baseline-push.<you>.workers.dev/health`. You should see
`{"ok":true,...}` with your public key echoed back.

---

## 3. Connect them

In the app: **Data → Cloudflare**. Paste the Worker URL, pick a device id
(`kelly-phone`), press **Save and connect**. It will register the service worker,
ask for notification permission, subscribe, and report today's state. The three
dots at the bottom of that panel should all go green.

Press **Send a test push** to confirm the round trip.

---

## How the nagging works

```
cron every 5 min
   ↓
worker: is a window past its time and not closed?
   ↓ yes, and it's been >= nag interval since the last one
send payload-less push
   ↓
service worker wakes, calls GET /due
   ↓
notification: requireInteraction, tag "baseline-checkin", badge count
```

Nothing stops until the app POSTs `/state` saying that window is logged or skipped.
That happens automatically on save, on skip, and every time you foreground the app.

**Why payload-less.** A push with an encrypted body needs `aes128gcm` with an ECDH
shared secret per subscription. Skipping the payload means the only crypto is the
VAPID JWT, and the service worker just asks the Worker what to say. Far fewer ways
to break, and the notification text is always current rather than whatever was true
when the push was queued.

**What the Worker knows:** your check-in times, your timezone, and which windows are
closed today. Not a single rating. Turn on *Store snapshots in Cloudflare* and it
also holds a JSON copy of everything in KV — useful insurance, but that is your
health data sitting in a KV namespace, so it's off by default and your call.

### Platform reality check

| | sticky notification | app badge |
|---|---|---|
| Android / Chrome | yes | yes |
| Desktop Chrome, Edge | yes, `requireInteraction` holds it open | yes |
| iOS 16.4+ | only if installed to home screen; iOS ignores `requireInteraction`, so persistence comes from the repeat | yes |
| Firefox | yes | no |

iOS also drops push subscriptions if you don't open the app for a long stretch.
If reminders go quiet for a few days, open Data → Cloudflare and press
**Save and connect** again.

The in-app blocking gate is the part that works everywhere regardless.

---

## Troubleshooting

| symptom | cause |
|---|---|
| service worker dot red | not on https, or `sw.js` isn't beside `baseline.html` |
| "worker didn't return a VAPID key" | `VAPID_PUBLIC` secret not set |
| subscribe fails on iOS | not installed to the home screen |
| pushes stop after a while | subscription expired — reconnect |
| CORS error in console | `ALLOW_ORIGIN` doesn't match your Pages origin exactly |

`wrangler tail` shows each cron tick and what it decided.

---

## Rotating the keys

The keypair in `vapid-keys.json` was generated for you. If you'd rather make your own:

```bash
node -e "const{generateKeyPairSync}=require('crypto');
const{privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const j=privateKey.export({format:'jwk'});
console.log('public :',Buffer.concat([Buffer.from([4]),
  Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]).toString('base64url'));
console.log('private:',j.d);"
```

Change the keys and every existing subscription dies. The app notices the key
changed and re-subscribes on its own, but you'll have to press **Save and connect**
on each device.

Keep `vapid-keys.json` out of the public repo — the private key is what authorizes
sending push to your devices.
