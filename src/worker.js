// HCC Roster: serves the app page and keeps one shared copy of the roster
// in a Durable Object (SQLite storage, no setup needed on Cloudflare).
import { DurableObject } from "cloudflare:workers";
import { rowsForWeek, syncRows, publishTest, publishWeek, TEST_ROWS } from "./sevenshifts.js";
import { handleSignOut, handleHandoff } from "./hub.js";
import { handleRename } from "./rename.js";
import { whoIs, handleSignIn, handleConfig, handleMe, handleAccess, handleAdmins, handleAuthProxy, leadTeamsOf } from "./auth.js";
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
    // Only someone signed in can save: an admin, or a person linked to a Roster name. Strangers can still read.
    const who = await whoIs(request, store, env);
    if (!who.lead && !who.me) return json({ ok: false, reason: "signin" }, 401);
    const kept = await guardAvailability(request, store, data, who);
    const held = await guardRoster(request, store, data, who);
    delete data.pinHash; // the leader PIN is retired: admins sign in
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
export async function guardAvailability(request, store, data, who) {
  const { data: oldText } = await store.get();
  if (!oldText || typeof store.getItem !== "function") return [];
  let old; try { old = JSON.parse(oldText); } catch { return []; }
  const { lead, me } = who;
  if (lead) return [];
  // Protected: everyone linked to a sign-in.
  const own = new Set(Object.values((await store.getItem("hubLinks")) || {}));
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
 * Serves and set-up are guarded too (Nov 17). An admin (signed in) can change anything.
 * Volunteers don't accept or decline serves (Nov 17, user: like a restaurant shift, the leader rosters
 * them). A volunteer changes no serve; they can only ask for cover on their own serve, offer for an open
 * spot, or answer a swap asked of them. A team leader may change, add or remove their own team's serves,
 * lists and requests. Switches, levels, who leads a team and service
 * times stay as a leader set them. Anything else is put back before saving. Returns how many serves
 * were put back (set-up is put back quietly, since phones fill in empty set-up on their own).
 */
export async function guardRoster(request, store, data, who) {
  const { data: oldText } = await store.get(); if (!oldText) return 0;
  let old; try { old = JSON.parse(oldText); } catch { return 0; }
  const { lead, me } = who;
  if (lead) return 0;
  const cfg = old.cfg || {};
  const myTeams = new Set(leadTeamsOf(old, me));
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
/** Volunteer PINs and the leader PIN are retired (Nov 17): people sign in with Google or their phone. */
const retired = () => json({ ok: false, reason: "retired", error: "Sign in with Google or your phone instead." }, 410);

/** /api/emergency  GET ?name=: that volunteer or an admin (all if no name). PUT: only the volunteer. */
export async function handleEmergency(request, store, env) {
  const url = new URL(request.url);
  const { lead: isLead, me } = await whoIs(request, store, env);
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
  const { me } = await whoIs(request, store, env);
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

/** Phone numbers and emails, kept apart from the roster and only for admins. */
export async function handleContacts(request, store, env) {
  if (!(await whoIs(request, store, env)).lead) return new Response("Admins only", { status: 403 });
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
    const store = () => env.ROSTER.get(env.ROSTER.idFromName("hcc"));
    if (url.pathname.startsWith("/api/7shifts/")) {
      // 7shifts can create and publish shifts, so only admins (Nov 17).
      if (!(await whoIs(request, store(), env)).lead) return new Response("Admins only", { status: 403 });
      const loadRoster = async () => (await env.ASSETS.fetch(new URL("/sheet-shifts.json", url))).json();
      return handleSevenShifts(request, env, loadRoster);
    }
    if (url.pathname.startsWith("/__/auth/") || url.pathname.startsWith("/__/firebase/")) return handleAuthProxy(request, env);
    if (url.pathname === "/auth/config") return handleConfig(request, env);
    if (url.pathname === "/auth/signin") return handleSignIn(request, env, store());
    if (url.pathname === "/auth/hub") return new Response(null, { status: 302, headers: { location: "/signin", "cache-control": "no-store" } });
    if (url.pathname === "/auth/signout") return handleSignOut(request);
    if (url.pathname === "/api/me") return handleMe(request, env, store());
    if (url.pathname === "/api/handoff") return handleHandoff(request, store());
    if (url.pathname === "/hub/people") return handleHubPeople(request, env, store());
    if (url.pathname === "/hub/teams") return handleHubTeams(request, store());
    if (url.pathname === "/api/vpin" || url.pathname === "/api/unlock") return retired();
    if (url.pathname === "/api/access") { const st = store(); return handleAccess(request, st, (await whoIs(request, st, env)).lead); }
    if (url.pathname === "/api/hublinks") { const st = store(); return handleAccess(new Request(request.url, { method: request.method, body: request.method === "POST" ? await request.text() : undefined }), st, (await whoIs(request, st, env)).lead); }
    if (url.pathname === "/api/admins") { const st = store(); return handleAdmins(request, st, await whoIs(request, st, env)); }
    const routes = { "/api/state": handleState, "/api/contacts": handleContacts, "/api/emergency": handleEmergency, "/api/cal": handleCal };
    if (url.pathname === "/api/rename") return handleRename(request, store(), env);
    if (url.pathname === "/api/profile") return handleProfile(request, store(), env);
    if (url.pathname === "/api/photos") return handlePhotos(request, store());
    const h = routes[url.pathname];
    if (h) return h(request, store(), env);
    // App pages (/vol/..., /admin/...) are all the one page; it reads the path and opens that screen.
    if (request.method === "GET" && /^\/(vol|admin)(\/|$)/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL("/", url), request));
    return env.ASSETS.fetch(request);
  },
};
