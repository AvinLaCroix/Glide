// Glide push server (Cloudflare Worker).
// Sends Glide's reminders as phone notifications, even when the app is closed.
// Setup: paste this whole file into a Cloudflare Worker, bind a KV namespace as SUBS,
// and add a cron trigger of "* * * * *". No keys to copy: it makes its own on first use.

const ORIGINS = ["https://avinlacroix.github.io"];
const SUBJECT = "https://avinlacroix.github.io/Glide/";
const OPTS = ["rem", "pb", "tir", "os", "stale", "recap", "pat", "fit", "meal", "groc"];

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    try {
      if (url.pathname === "/vapid") {
        const v = await vapid(env);
        return json({ key: v.pub }, cors);
      }
      if (req.method !== "POST") return new Response("Glide push server is running.", { headers: cors });
      const b = await req.json();
      const all = await loadSubs(env);
      const save = () => env.SUBS.put("subs", JSON.stringify(all));
      if (url.pathname === "/sub") {
        if (!validId(b.id) || !b.sub || !b.sub.endpoint || !b.sub.keys) return json({ error: "bad request" }, cors, 400);
        const prev = all[b.id] || {};
        const opt = {};
        OPTS.forEach(k => { opt[k] = !b.opt || b.opt[k] !== false; });
        all[b.id] = {
          os: prev.os || null, later: prev.later || [], st: prev.st || null, gap: prev.gap || 0, patK: prev.patK || "",
          sub: b.sub,
          tz: String(b.tz || "America/Chicago").slice(0, 64),
          opt,
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 60).map(i => ({
            t: String(i.t).slice(0, 5), ti: String(i.ti || "Glide").slice(0, 70), b: String(i.b || "").slice(0, 200),
            dw: Array.isArray(i.dw) ? i.dw.filter(d => d >= 0 && d <= 6).slice(0, 7) : null
          })),
          ns: b.ns && b.ns.u ? { u: String(b.ns.u).slice(0, 200), k: String(b.ns.k || "").slice(0, 100), lo: +b.ns.lo || 70, hi: +b.ns.hi || 180, goal: +b.ns.goal || 70, at: String(b.ns.at || "20:00").slice(0, 5), sk: Math.max(0, Math.min(9999, +b.ns.sk || 0)), skd: String(b.ns.skd || "").slice(0, 10) } : null,
          up: Date.now()
        };
        await save();
        return json({ ok: true }, cors);
      }
      const s = all[b.id];
      if (url.pathname === "/unsub") { delete all[b.id]; await save(); return json({ ok: true }, cors); }
      if (!s) return json({ error: "not signed up" }, cors, 404);
      if (url.pathname === "/seen") {
        s.os = { d: String(b.d || "").slice(0, 10), n: Math.max(0, Math.min(99999, +b.n || 0)) };
        await save();
        return json({ ok: true }, cors);
      }
      if (url.pathname === "/stats") {
        const msg = m => m && m.ti ? { k: String(m.k || "").slice(0, 60), ti: String(m.ti).slice(0, 70), b: String(m.b || "").slice(0, 200) } : null;
        s.st = { at: Date.now(), recap: msg(b.recap), pat: msg(b.pat) };
        await save();
        return json({ ok: true }, cors);
      }
      if (url.pathname === "/later") {
        const at = +b.at;
        if (!(at > Date.now() && at < Date.now() + 864e5)) return json({ error: "bad time" }, cors, 400);
        s.later = (s.later || []).filter(x => x.at > Date.now() - 36e5).slice(-10);
        s.later.push({ at, ti: String(b.ti || "Glide").slice(0, 70), b: String(b.b || "").slice(0, 200) });
        await save();
        return json({ ok: true }, cors);
      }
      if (url.pathname === "/test") {
        const r = await sendPush(env, s.sub, { title: "Glide", body: "Notifications are working." });
        return json({ ok: r.ok, status: r.status }, cors);
      }
      return json({ error: "unknown" }, cors, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, cors, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  }
};

function localParts(tz, ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = t => f.find(p => p.type === t).value;
  return { hm: g("hour") + ":" + g("minute"), min: +g("minute"), dw: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")), day: g("year") + "-" + g("month") + "-" + g("day") };
}

async function latestReading(ns) {
  const r = await fetch(ns.u.replace(/\/+$/, "") + "/api/v1/entries/sgv.json?count=1" + (ns.k ? "&token=" + encodeURIComponent(ns.k) : ""));
  if (!r.ok) return null;
  const a = await r.json();
  return a && a[0] && a[0].sgv ? a[0] : null;
}

async function tick(env) {
  const all = await loadSubs(env);
  let changed = false;
  const now = Date.now();
  for (const id of Object.keys(all)) {
    const s = all[id], o = s.opt || {}, L = localParts(s.tz || "America/Chicago", now), hm = L.hm;
    const on = k => o[k] !== false;
    const due = s.items.filter(i => i.t === hm && (!i.dw || i.dw.indexOf(L.dw) >= 0)).map(i => ({ title: i.ti, body: i.b }));
    // daily 🩸 streak
    if (on("os") && s.os && s.os.n > 0 && hm === "21:00" && s.os.d === localParts(s.tz, now - 864e5).day)
      due.push({ title: "Glide: keep your " + s.os.n + "-day streak 🩸", body: "You haven't opened Glide today. Open it before midnight to keep your streak." });
    // 8 PM time in range
    if (on("tir") && s.ns && s.ns.at === hm) {
      const m = await tirMessage(s.ns, s.tz).catch(() => null);
      if (m) due.push(m);
    }
    // live readings stopped (checked every 10 minutes)
    if (on("stale") && s.ns && L.min % 10 === 0) {
      const e = await latestReading(s.ns).catch(() => null);
      const age = e ? (now - e.date) / 60000 : 999;
      if (age > 30 && !s.gap) {
        due.push({ title: "Glide: no new readings", body: e ? "Glide hasn't gotten a Dexcom reading in " + (age > 1440 ? "over a day" : age >= 90 ? Math.round(age / 60) + " hours" : Math.round(age) + " minutes") + ". Check your Dexcom app, then Nightscout." : "Glide can't reach your Nightscout site. Check your Dexcom app, then Nightscout." });
        s.gap = now; changed = true;
      } else if (age <= 30 && s.gap) { s.gap = 0; changed = true; }
    }
    // after-meal checks
    if (s.later && s.later.length) {
      const ready = s.later.filter(x => x.at <= now);
      if (ready.length) {
        s.later = s.later.filter(x => x.at > now); changed = true;
        if (on("meal")) for (const x of ready) {
          let body = x.b;
          if (s.ns) {
            const e = await latestReading(s.ns).catch(() => null);
            if (e && now - e.date < 15 * 60000) body = "You're at " + e.sgv + " now (" + (e.sgv < s.ns.lo ? "low" : e.sgv > s.ns.hi ? "high" : "in range") + "). " + body;
          }
          due.push({ title: x.ti, body });
        }
      }
    }
    // Sunday recap and new patterns (worked out by Glide when you open it)
    const fresh = s.st && now - s.st.at < 3 * 864e5;
    if (on("recap") && fresh && s.st.recap && L.dw === 0 && hm === "18:00") due.push({ title: s.st.recap.ti, body: s.st.recap.b });
    if (on("pat") && fresh && s.st.pat && s.st.pat.k && s.st.pat.k !== s.patK && hm === "19:00") {
      due.push({ title: s.st.pat.ti, body: s.st.pat.b }); s.patK = s.st.pat.k; changed = true;
    }
    for (const msg of due) {
      const r = await sendPush(env, s.sub, msg);
      if (r.status === 404 || r.status === 410) { delete all[id]; changed = true; break; }
    }
  }
  if (changed) await env.SUBS.put("subs", JSON.stringify(all));
}

async function tirMessage(ns, tz) {
  const now = Date.now();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(now));
  const h = +parts.find(p => p.type === "hour").value, m = +parts.find(p => p.type === "minute").value;
  const since = now - (h * 60 + m) * 60000;
  const base = ns.u.replace(/\/+$/, "");
  const url = base + "/api/v1/entries/sgv.json?count=400&find[date][$gte]=" + since + (ns.k ? "&token=" + encodeURIComponent(ns.k) : "");
  const r = await fetch(url);
  if (!r.ok) return null;
  const a = (await r.json()).filter(e => e.sgv >= 20 && e.sgv <= 600 && e.date >= since);
  if (a.length < 24) return null;
  const inR = a.filter(e => e.sgv >= ns.lo && e.sgv <= ns.hi).length;
  const pct = Math.round(inR / a.length * 100);
  if (pct >= ns.goal) return null;
  const y = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now - 864e5));
  const sk = ns.skd === y ? ns.sk : 0;
  if (sk > 0) return { title: "Glide: your " + sk + "-day streak is at risk", body: "You're at " + pct + "% in range today, under your " + ns.goal + "% goal. Bring it up tonight to keep your streak going." };
  return { title: "Glide: time in range check", body: "You're at " + pct + "% in range today, under your " + ns.goal + "% goal. There's still time this evening." };
}

// ---------- storage ----------
async function loadSubs(env) {
  try { return JSON.parse(await env.SUBS.get("subs")) || {}; } catch (e) { return {}; }
}
function validId(id) { return typeof id === "string" && /^[a-z0-9]{12,40}$/.test(id); }

// ---------- helpers ----------
function corsHeaders(req) {
  const o = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
function json(o, h, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, h) });
}
function localHM(tz) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  } catch (e) {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  }
}
const enc = new TextEncoder();
function b64u(buf) {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s), o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}
function concat(...arrs) {
  let n = 0; arrs.forEach(a => n += a.length);
  const o = new Uint8Array(n); let p = 0;
  arrs.forEach(a => { o.set(a, p); p += a.length; });
  return o;
}

// ---------- VAPID keys (made once, kept in KV) ----------
async function vapid(env) {
  const saved = await env.SUBS.get("vapid");
  if (saved) {
    const v = JSON.parse(saved);
    v.key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return v;
  }
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  await env.SUBS.put("vapid", JSON.stringify({ jwk, pub }));
  return { jwk, pub, key: kp.privateKey };
}
async function vapidAuth(env, endpoint) {
  const v = await vapid(env);
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, enc.encode(head + "." + body));
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + v.pub;
}

// ---------- Web Push payload encryption (RFC 8291, aes128gcm) ----------
async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}
async function encryptPayload(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(env, sub, msg) {
  const body = await encryptPayload(sub, JSON.stringify(msg));
  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidAuth(env, sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "3600",
      "Urgency": "high"
    },
    body
  });
}
