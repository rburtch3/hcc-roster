// HCC Roster: serves the app page and keeps one shared copy of the roster
// in a Durable Object (SQLite storage, no setup needed on Cloudflare).
import { DurableObject } from "cloudflare:workers";
import { rowsForWeek, syncRows, publishTest, publishWeek, TEST_ROWS } from "./sevenshifts.js";
import { handleAuthHub, handleSignOut, handleMe, sessionOf, rosterNameFor } from "./hub.js";

const MAX = 1_000_000;
const MAX_CONTACTS = 200_000;

export class RosterStore extends DurableObject {
  async get() {
    const [data, rev] = await Promise.all([this.ctx.storage.get("state"), this.ctx.storage.get("rev")]);
    return { rev: rev ?? 0, data: data ?? null };
  }
  /** Saves only if nobody saved since `base`; otherwise returns the newer copy. */
  async put(base, text) {
    const rev = (await this.ctx.storage.get("rev")) ?? 0;
    if (base !== rev) return { ok: false, rev, data: (await this.ctx.storage.get("state")) ?? null };
    await this.ctx.storage.put({ state: text, rev: rev + 1 });
    return { ok: true, rev: rev + 1 };
  }
  async getItem(k) { return (await this.ctx.storage.get(k)) ?? null; }
  async putItem(k, v) { await this.ctx.storage.put(k, v); }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The leader PIN's hash never leaves the server: readers see "set" or "". */
function hide(data) {
  if (data && typeof data === "object" && "pinHash" in data) data.pinHash = data.pinHash ? "set" : "";
  return data;
}
async function storedPin(store) {
  const { data } = await store.get();
  if (!data) return "";
  try { return JSON.parse(data).pinHash || ""; } catch { return ""; }
}
export async function hashPin(pin) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hcc-roster|" + pin));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** GET: { rev, data }. PUT { rev, data }: 200 { rev } when rev is the latest, else 409 with the latest. */
export async function handleState(request, store, env) {
  if (request.method === "GET") {
    const { rev, data } = await store.get();
    return json({ rev, data: data ? hide(JSON.parse(data)) : null });
  }
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX) return new Response("Too large", { status: 413 });
    let body;
    try { body = JSON.parse(text); } catch { return new Response("Bad JSON", { status: 400 }); }
    const data = body && body.data;
    if (!body || !Number.isInteger(body.rev) || !data || typeof data !== "object" || !Array.isArray(data.slots)) {
      return new Response("Not a roster", { status: 400 });
    }
    // Once a PIN is set, a save can't change it; before that, the first real hash wins.
    const pin = await storedPin(store);
    const kept = await guardAvailability(request, store, pin, data, env);
    if (pin) data.pinHash = pin;
    else if ("pinHash" in data && !/^[0-9a-f]{64}$|^d[0-9a-f]+$/.test(String(data.pinHash))) data.pinHash = "";
    const r = await store.put(body.rev, JSON.stringify(data));
    if (!r.ok) return json({ rev: r.rev, data: r.data ? hide(JSON.parse(r.data)) : null }, 409);
    return json(kept.length ? { rev: r.rev, kept } : { rev: r.rev });
  }
  return new Response("Method not allowed", { status: 405 });
}

/**
 * Volunteers with their own PIN: only they (or a leader) can change their
 * availability (regularBy, blockouts, tempBy). Anyone else's change to those
 * is put back before saving, and the names are returned as `kept`.
 */
export const AVAIL_KEYS = ["regularBy", "blockouts", "tempBy"];
export async function guardAvailability(request, store, pin, data, env) {
  const { data: oldText } = await store.get();
  if (!oldText || typeof store.getItem !== "function") return [];
  let old; try { old = JSON.parse(oldText); } catch { return []; }
  if (old.feat && old.feat.volpin === false) return [];
  const vp = (await store.getItem("vpins")) || {};
  const { lead, me } = await whoIs(request, store, env, pin, vp);
  if (lead) return [];
  // Protected: anyone with their own PIN, and anyone linked to an HCC Hub sign-in.
  const own = new Set([...Object.keys(vp), ...Object.values((await store.getItem("hubLinks")) || {})]);
  const kept = [];
  for (const k of AVAIL_KEYS) {
    const a = old[k] && typeof old[k] === "object" ? old[k] : {};
    const b = data[k] && typeof data[k] === "object" ? data[k] : (data[k] = {});
    for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!own.has(n) || n === me || JSON.stringify(a[n]) === JSON.stringify(b[n])) continue;
      if (n in a) b[n] = a[n]; else delete b[n];
      if (!kept.includes(n)) kept.push(n);
    }
  }
  return kept;
}
const vHash = (name, pin) => hashPin("v|" + name + "|" + pin);
/** The volunteer this request signs in as (x-vol-name is URI-encoded), or "". */
function volMe(request, vp) {
  let who = ""; try { who = decodeURIComponent(request.headers.get("x-vol-name") || ""); } catch { return ""; }
  const key = request.headers.get("x-vol-key") || "";
  return who && vp[who] && key === vp[who] ? who : "";
}
/**
 * Who this request is: lead = the leader PIN key or an HCC Hub admin session; me = the volunteer
 * (their own PIN key, or the Roster name their Hub session is linked to), else "".
 */
export async function whoIs(request, store, env, pin, vp) {
  const sess = env && typeof store.getItem === "function" ? await sessionOf(request, env, store) : null;
  const lead = (!!pin && request.headers.get("x-roster-key") === pin) || (!!sess && sess.role === "admin");
  let me = volMe(request, vp || {});
  if (!me && sess) me = (await rosterNameFor(sess, store)).name;
  return { lead, me, sess };
}

/**
 * /api/vpin  GET: { names } of volunteers who have their own PIN.
 * POST { name, pin }: sets it the first time, else checks it (10 wrong tries lock it for 15 minutes); 200 { ok, key }.
 * POST { name, reset: true } with x-roster-key: a leader clears it.
 */
export async function handleVolPin(request, store, now = Date.now(), env) {
  const vp = (await store.getItem("vpins")) || {};
  if (request.method === "GET") return json({ names: Object.keys(vp) });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let b; try { b = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const name = String((b && b.name) || "").slice(0, 80), pin = String((b && b.pin) || "");
  if (!name) return json({ ok: false, reason: "name" }, 400);
  if (b.reset) {
    if (!(await whoIs(request, store, env, await storedPin(store), vp)).lead) return new Response("Leaders only", { status: 403 });
    delete vp[name]; await store.putItem("vpins", vp); return json({ ok: true });
  }
  if (!/^\d{4,8}$/.test(pin)) return json({ ok: false, reason: "pin" }, 400);
  const fails = (await store.getItem("vfails")) || {}, f = fails[name] || { n: 0, since: now };
  if (now - f.since > 15 * 60_000) { f.n = 0; f.since = now; }
  if (f.n >= 10) return json({ ok: false, reason: "locked" }, 429);
  const h = await vHash(name, pin);
  if (!vp[name]) { vp[name] = h; await store.putItem("vpins", vp); return json({ ok: true, key: h, first: true }); }
  if (vp[name] === h) { fails[name] = { n: 0, since: now }; await store.putItem("vfails", fails); return json({ ok: true, key: h }); }
  f.n += 1; fails[name] = f; await store.putItem("vfails", fails);
  return json({ ok: false, reason: "wrong" }, 403);
}

/** /api/emergency  GET ?name=: that volunteer (x-vol-name/x-vol-key) or a leader (x-roster-key, all if no name). PUT: only the volunteer. */
export async function handleEmergency(request, store, env) {
  const url = new URL(request.url), vp = (await store.getItem("vpins")) || {};
  const { lead: isLead, me } = await whoIs(request, store, env, await storedPin(store), vp);
  const all = (await store.getItem("emergency")) || {};
  if (request.method === "GET") {
    const name = url.searchParams.get("name") || "";
    if (isLead) return json(name ? { contact: all[name] || null } : { contacts: all });
    if (me && (!name || name === me)) return json({ contact: all[me] || null });
    return new Response("Not yours", { status: 403 });
  }
  if (request.method === "PUT") {
    if (!me) return new Response("Only the volunteer can change this", { status: 403 });
    const text = await request.text();
    if (text.length > 2000) return new Response("Too large", { status: 413 });
    let c; try { c = JSON.parse(text).contact; } catch { return new Response("Bad JSON", { status: 400 }); }
    if (c === null) delete all[me];
    else if (c && typeof c === "object") all[me] = { name: String(c.name || "").slice(0, 80), phone: String(c.phone || "").slice(0, 30), relation: String(c.relation || "").slice(0, 40) };
    else return new Response("Not a contact", { status: 400 });
    await store.putItem("emergency", all);
    return json({ ok: true });
  }
  return new Response("Method not allowed", { status: 405 });
}

/** POST { pin }: 200 { ok, key } when it matches the leader PIN. 10 wrong tries lock it for 15 minutes. */
export async function handleUnlock(request, store, now = Date.now()) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let pin = "";
  try { pin = String((await request.json()).pin || ""); } catch { return new Response("Bad JSON", { status: 400 }); }
  const want = await storedPin(store);
  if (!want) return json({ ok: false, reason: "no-pin" }, 409);
  const f = (await store.getItem("fails")) || { n: 0, since: now };
  if (now - f.since > 15 * 60_000) { f.n = 0; f.since = now; }
  if (f.n >= 10) return json({ ok: false, reason: "locked" }, 429);
  const got = /^\d{4,8}$/.test(pin) ? await hashPin(pin) : "";
  if (got && got === want) { await store.putItem("fails", { n: 0, since: now }); return json({ ok: true, key: want }); }
  f.n += 1; await store.putItem("fails", f);
  return json({ ok: false, reason: "wrong" }, 403);
}

/** Phone numbers and emails, kept apart from the roster and only for leaders (x-roster-key). */
export async function handleContacts(request, store, env) {
  if (!(await whoIs(request, store, env, await storedPin(store))).lead) return new Response("Leaders only", { status: 403 });
  if (request.method === "GET") return json({ contacts: (await store.getItem("contacts")) || {} });
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_CONTACTS) return new Response("Too large", { status: 413 });
    let c;
    try { c = JSON.parse(text).contacts; } catch { return new Response("Bad JSON", { status: 400 }); }
    if (!c || typeof c !== "object" || Array.isArray(c)) return new Response("Not contacts", { status: 400 });
    await store.putItem("contacts", c);
    return json({ ok: true });
  }
  return new Response("Method not allowed", { status: 405 });
}

/**
 * /api/7shifts/preview?week=SUNDAY   GET: what a sync would create (reads 7shifts only)
 * /api/7shifts/sync?week=SUNDAY      POST: creates missing draft shifts, up to 40 a call
 * /api/7shifts/test                  POST: creates the one approved test shift as a draft
 * /api/7shifts/publish-test          POST: publishes that one test shift, nothing else
 * /api/7shifts/publish?week=SUNDAY   POST: publishes this app's drafts in an approved week, up to 40 a call (GET: counts only)
 * Roster weeks are only ever added as drafts; a leader publishes them in 7shifts.
 */
export async function handleSevenShifts(request, env, loadRoster, fetchFn) {
  const url = new URL(request.url);
  const action = url.pathname.split("/")[3];
  if (!env.SEVENSHIFTS_TOKEN) return json({ error: "The 7shifts token isn't set up yet." }, 503);
  const isTest = action === "test";
  if (!["preview", "sync", "test", "publish-test", "publish"].includes(action)) return new Response("Not found", { status: 404 });
  if (action === "publish-test") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    try {
      const r = await publishTest(env, await loadRoster(), { fetchFn });
      return json(r, r.error ? 409 : 200);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  }
  if (action === "publish") {
    if (!["GET", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
    try {
      const r = await publishWeek(env, url.searchParams.get("week"), { fetchFn, dryRun: request.method === "GET" });
      return json(r, r.error ? 403 : 200);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  }
  if (action === "preview" ? request.method !== "GET" : request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const roster = await loadRoster();
  const week = isTest ? TEST_ROWS[0][0] : url.searchParams.get("week");
  const rows = isTest ? TEST_ROWS : rowsForWeek(roster, week);
  if (!rows) return json({ error: "week must be a Sunday, like 2026-11-15" }, 400);
  if (week < new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10)) return json({ error: "That week is in the past." }, 400);
  try {
    return json(await syncRows(env, roster, rows, week, { create: action !== "preview", fetchFn }));
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

/** GET /api/cal?n=Name: that person's published serves as a calendar feed (times are India time, like the app). */
export async function handleCal(request, store) {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const name = new URL(request.url).searchParams.get("n") || "";
  const { data } = await store.get();
  let st = {};
  try { st = data ? JSON.parse(data) : {}; } catch { st = {}; }
  const svcs = {}; (st.services || []).forEach((v) => { svcs[v.id] = v; });
  const cfg = (st.cfg && st.cfg.services) || {};
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const hm = (t) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*([AP]M)/i); return m ? [(+m[1] % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0), +m[2]] : [10, 0]; };
  const stamp = (iso, t, add = 0) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), t[0], t[1]) - 330 * 60000 + add).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const clean = (t) => String(t || "").replace(/[\\;,]/g, " ").replace(/[\r\n]+/g, " ");
  const now = stamp(new Date().toISOString().slice(0, 10), [0, 0]);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HCC//Roster//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:HCC Roster" + (name ? " " + clean(name) : ""), "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"];
  if (name) (st.slots || []).forEach((x) => {
    const sv = svcs[x.sid];
    if (x.person !== name || x.status === "declined" || !sv || sv.published === false || !sv.date || sv.date < since) return;
    const c = cfg[sv.svc] || {}, t = hm(c.call);
    lines.push("BEGIN:VEVENT", "UID:" + String(x.id).replace(/[^A-Za-z0-9]/g, "") + "@hcc-roster", "DTSTAMP:" + now, "DTSTART:" + stamp(sv.date, t), "DTEND:" + stamp(sv.date, t, 2 * 3600000),
      "SUMMARY:" + clean((x.role || "Serving") + " · " + (c.name || sv.svc)), "DESCRIPTION:" + clean((x.team || "") + ". Call time " + (c.call || "") + " service " + (c.time || "")), "END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/7shifts/")) {
      const loadRoster = async () => (await env.ASSETS.fetch(new URL("/sheet-shifts.json", url))).json();
      return handleSevenShifts(request, env, loadRoster);
    }
    const store = () => env.ROSTER.get(env.ROSTER.idFromName("hcc"));
    if (url.pathname === "/auth/hub") return handleAuthHub(request, env, store());
    if (url.pathname === "/auth/signout") return handleSignOut(request);
    if (url.pathname === "/api/me") return handleMe(request, env, store());
    const routes = { "/api/state": handleState, "/api/contacts": handleContacts, "/api/emergency": handleEmergency, "/api/cal": handleCal };
    if (url.pathname === "/api/unlock") return handleUnlock(request, store());
    if (url.pathname === "/api/vpin") return handleVolPin(request, store(), Date.now(), env);
    const h = routes[url.pathname];
    if (h) return h(request, store(), env);
    return env.ASSETS.fetch(request);
  },
};
