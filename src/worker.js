// HCC Roster: serves the app page and keeps one shared copy of the roster
// in a Durable Object (SQLite storage, no setup needed on Cloudflare).
import { DurableObject } from "cloudflare:workers";
import { rowsForWeek, syncRows, publishTest, publishWeek, TEST_ROWS } from "./sevenshifts.js";
import { handleAuthHub, handleSignOut, handleMe, handleHandoff, handleHubLinks, sessionOf, rosterNameFor } from "./hub.js";
import { handleHubPeople, handleHubTeams } from "./hubpeople.js";

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
    // Once a leader PIN is set (and volunteer sign-in is on), only someone signed in can save:
    // a leader, a volunteer with their own PIN, or an HCC Hub session. Strangers can still read.
    if (pin && !(await savesOpen(store)) && typeof store.getItem === "function") {
      const who = await whoIs(request, store, env, pin, (await store.getItem("vpins")) || {});
      if (!who.lead && !who.me && !who.sess) return json({ ok: false, reason: "signin" }, 401);
    }
    const kept = await guardAvailability(request, store, pin, data, env);
    const held = pin && !(await savesOpen(store)) ? await guardRoster(request, store, pin, data, env) : 0;
    if (pin) data.pinHash = pin;
    else if ("pinHash" in data && !/^[0-9a-f]{64}$|^d[0-9a-f]+$/.test(String(data.pinHash))) data.pinHash = "";
    const r = await store.put(body.rev, JSON.stringify(data));
    if (!r.ok) return json({ rev: r.rev, data: r.data ? hide(JSON.parse(r.data)) : null }, 409);
    const out = { rev: r.rev }; if (kept.length) out.kept = kept; if (held) out.held = held;
    return json(out);
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
/**
 * Serves and set-up are guarded too (Nov 17). A leader (leader PIN or Hub admin) can change anything.
 * Volunteers don't accept or decline serves (Nov 17, user: like a restaurant shift, the leader rosters
 * them). A volunteer changes no serve; they can only ask for cover on their own serve, offer for an open
 * spot, or answer a swap asked of them. A team leader may change, add or remove their own team's serves,
 * lists and requests. Switches, levels, who leads a team and service
 * times stay as a leader set them. Anything else is put back before saving. Returns how many serves
 * were put back (set-up is put back quietly, since phones fill in empty set-up on their own).
 */
export async function guardRoster(request, store, pin, data, env) {
  const { data: oldText } = await store.get(); if (!oldText) return 0;
  let old; try { old = JSON.parse(oldText); } catch { return 0; }
  const { lead, me } = await whoIs(request, store, env, pin, (await store.getItem("vpins")) || {});
  if (lead) return 0;
  const cfg = old.cfg || {}, leaders = cfg.leaders || {}, pool = cfg.pool || {}, levels = old.levels || {};
  const levelsOn = !(old.feat && old.feat.levels === false);
  const myTeams = new Set(Object.keys(leaders).filter((t) => me && leaders[t] === me));
  if (me && levelsOn && (levels[me] === "assistant" || levels[me] === "leader")) Object.keys(pool).forEach((t) => { if ((pool[t] || []).includes(me)) myTeams.add(t); });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const empty = (v) => v === undefined || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
  const putBack = (to, k, from) => { if (empty(from[k]) && empty(to[k])) return; if (k in from) to[k] = from[k]; else delete to[k]; };
  // leader-only set-up, put back quietly
  for (const k of ["feat", "levels"]) if (!same(old[k], data[k])) putBack(data, k, old);
  const nc = data.cfg && typeof data.cfg === "object" ? data.cfg : (data.cfg = {});
  for (const k of new Set([...Object.keys(cfg), ...Object.keys(nc)])) {
    if (same(cfg[k], nc[k])) continue;
    if ((k === "pool" || k === "roles") && myTeams.size && nc[k] && typeof nc[k] === "object") {
      const a = cfg[k] || {}, b = nc[k]; // a team leader changes only their own teams' lists
      for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) if (!myTeams.has(t) && !same(a[t], b[t])) putBack(b, t, a);
      continue;
    }
    putBack(nc, k, cfg);
  }
  if (!myTeams.size && !same(old.services, data.services)) data.services = old.services;
  // serves
  const before = new Map((old.slots || []).map((x) => [x.id, x]));
  const out = []; let held = 0;
  for (const x of data.slots) {
    const o = x && before.get(x.id);
    if (!o) { if (x && myTeams.has(x.team)) out.push(x); else held++; continue; }
    before.delete(o.id);
    if (same(o, x) || myTeams.has(o.team)) { out.push(x); continue; }
    const where = o.sid === x.sid && o.team === x.team && o.role === x.role && o.person === x.person;
    const tidy = where && o.status === "pending" && x.status === "confirmed" && same({ ...o, status: 0 }, { ...x, status: 0 });
    if (tidy) out.push(x); else { out.push(o); held++; }
  }
  const at = new Map((old.slots || []).map((x, i) => [x.id, i]));
  for (const o of before.values()) { if (!myTeams.has(o.team)) { out.splice(Math.min(at.get(o.id), out.length), 0, o); held++; } } // removed serves come back in place
  data.slots = out;
  // requests: a volunteer only asks for cover on their own serve, offers for an open spot,
  // or answers a swap someone asked them for. The leader approves.
  const slotOf = new Map((old.slots || []).map((x) => [x.id, x]));
  const teamOf = (r) => (slotOf.get(r && r.slot) || {}).team;
  const was = new Map((old.requests || []).map((r) => [r.id, r]));
  const reqs = []; const nr = Array.isArray(data.requests) ? data.requests : [];
  for (const r of nr) {
    const o = r && was.get(r.id);
    if (!o) {
      const x = slotOf.get(r && r.slot);
      const ok = myTeams.has(teamOf(r)) || (me && x && r.from === me && r.state === "pending" &&
        (r.kind === "pickup" ? !x.person || x.status === "open" || x.status === "declined" : ["cant", "swap", "giveaway"].includes(r.kind) && x.person === me));
      if (ok) reqs.push(r); else held++;
      continue;
    }
    was.delete(o.id);
    if (same(o, r) || myTeams.has(teamOf(o))) { reqs.push(r); continue; }
    const answer = me && o.kind === "swap" && o.to === me && o.state === "pending" &&
      same({ ...o, stage: 0, state: 0 }, { ...r, stage: 0, state: 0 }) && ((r.stage === 2 && r.state === "pending") || (r.stage === o.stage && r.state === "declined"));
    if (answer) reqs.push(r); else { reqs.push(o); held++; }
  }
  for (const o of was.values()) { if (!myTeams.has(teamOf(o))) { reqs.push(o); held++; } }
  if (Array.isArray(old.requests) || nr.length) data.requests = reqs;
  return held;
}
/** Volunteer sign-in switched off in the saved roster: anyone may save, as before. */
async function savesOpen(store) {
  const { data } = await store.get(); if (!data) return true;
  try { const d = JSON.parse(data); return !!(d.feat && d.feat.volpin === false); } catch { return true; }
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
 * POST { name, pin }: checks their PIN (10 wrong tries lock it for 15 minutes); 200 { ok, key }.
 *   A first PIN is set only by that person signed in with HCC Hub, or by a leader; anyone else gets 403 "ask".
 * POST { name, pin, change: true }: a new PIN, only by that person (their own PIN key or Hub sign-in) or a leader.
 * POST { name, reset: true }: a leader clears it.
 */
export async function handleVolPin(request, store, now = Date.now(), env) {
  const vp = (await store.getItem("vpins")) || {};
  if (request.method === "GET") return json({ names: Object.keys(vp) });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let b; try { b = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const name = String((b && b.name) || "").slice(0, 80), pin = String((b && b.pin) || "");
  if (!name) return json({ ok: false, reason: "name" }, 400);
  const { lead, me } = await whoIs(request, store, env, await storedPin(store), vp);
  if (b.reset) {
    if (!lead) return new Response("Leaders only", { status: 403 });
    delete vp[name]; await store.putItem("vpins", vp); return json({ ok: true });
  }
  if (!/^\d{4,8}$/.test(pin)) return json({ ok: false, reason: "pin" }, 400);
  if (b.change || !vp[name]) {
    // Setting or changing a PIN: only the person themselves, or a leader.
    if (!lead && me !== name) return json({ ok: false, reason: vp[name] ? "notyou" : "ask" }, 403);
    const h = await vHash(name, pin), first = !vp[name];
    vp[name] = h; await store.putItem("vpins", vp);
    const fails = (await store.getItem("vfails")) || {}; if (fails[name]) { delete fails[name]; await store.putItem("vfails", fails); }
    return json(me === name ? { ok: true, key: h, first: first || undefined } : { ok: true, first: first || undefined });
  }
  const fails = (await store.getItem("vfails")) || {}, f = fails[name] || { n: 0, since: now };
  if (now - f.since > 15 * 60_000) { f.n = 0; f.since = now; }
  if (f.n >= 10) return json({ ok: false, reason: "locked" }, 429);
  const h = await vHash(name, pin);
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

/**
 * /api/profile  GET: this volunteer's own { phone, whatsapp, email, photo }.
 * PUT { phone, whatsapp, email, photo }: saves them. Phone and email go to the leader-only contacts;
 * photo is a small JPEG data URL (or "" to remove) that everyone in the app sees on their avatar.
 * /api/photos  GET: { photos: { name: dataURL } } for the avatars.
 */
const MAX_PHOTO = 60000;
export async function handleProfile(request, store, env) {
  const vp = (await store.getItem("vpins")) || {};
  const { me } = await whoIs(request, store, env, await storedPin(store), vp);
  if (!me) return new Response("Sign in first", { status: 403 });
  const contacts = (await store.getItem("contacts")) || {}, photos = (await store.getItem("photos")) || {};
  if (request.method === "GET") { const c = contacts[me] || {}; return json({ name: me, phone: c.phone || "", whatsapp: c.whatsapp || "", email: c.email || "", photo: photos[me] || "" }); }
  if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
  const text = await request.text();
  if (text.length > MAX_PHOTO + 2000) return new Response("Too large", { status: 413 });
  let b; try { b = JSON.parse(text); } catch { return new Response("Bad JSON", { status: 400 }); }
  if (!b || typeof b !== "object") return new Response("Bad JSON", { status: 400 });
  const c = { ...(contacts[me] || {}) };
  for (const [k, n] of [["phone", 30], ["whatsapp", 30], ["email", 120]]) if (typeof b[k] === "string") { const v = b[k].trim().slice(0, n); if (v) c[k] = k === "email" ? v.toLowerCase() : v; else delete c[k]; }
  contacts[me] = c; await store.putItem("contacts", contacts);
  if (typeof b.photo === "string") {
    if (!b.photo) delete photos[me];
    else if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.photo) && b.photo.length <= MAX_PHOTO) photos[me] = b.photo;
    else return new Response("Bad photo", { status: 400 });
    await store.putItem("photos", photos);
  }
  return json({ ok: true });
}
export async function handlePhotos(request, store) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  return json({ photos: (await store.getItem("photos")) || {} });
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
    if (url.pathname === "/api/handoff") return handleHandoff(request, store());
    if (url.pathname === "/hub/people") return handleHubPeople(request, env, store());
    if (url.pathname === "/hub/teams") return handleHubTeams(request, store());
    const routes = { "/api/state": handleState, "/api/contacts": handleContacts, "/api/emergency": handleEmergency, "/api/cal": handleCal };
    if (url.pathname === "/api/unlock") return handleUnlock(request, store());
    if (url.pathname === "/api/hublinks") { const st = store(); return handleHubLinks(request, st, (await whoIs(request, st, env, await storedPin(st))).lead); }
    if (url.pathname === "/api/profile") return handleProfile(request, store(), env);
    if (url.pathname === "/api/photos") return handlePhotos(request, store());
    if (url.pathname === "/api/vpin") return handleVolPin(request, store(), Date.now(), env);
    const h = routes[url.pathname];
    if (h) return h(request, store(), env);
    // App pages (/vol/..., /admin/...) are all the one page; it reads the path and opens that screen.
    if (request.method === "GET" && /^\/(vol|admin)(\/|$)/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL("/", url), request));
    return env.ASSETS.fetch(request);
  },
};
