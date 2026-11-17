// Roster's own sign-in (Nov 17, user: "stop using hub authentication for now and just add Auth layer to
// this app - phone or Gmail"). People sign in on Roster's /signin page with Google or an SMS code. It uses
// the church's Firebase project (HUB_PROJECT_ID), so the same accounts and SMS billing as before, but no
// HCC Hub page and no Hub roles: Roster decides who is an admin, a team leader or a volunteer.
// - Admins: a list of verified emails or phone numbers kept in the store ("admins"), starting with the
//   church account. Only admins change who is an admin, who leads a team, and who is who.
// - Team leaders: whoever Roster's own data names (team leader, or level assistant/leader on that team).
// - Everyone else signed in and linked to a Roster name is a volunteer.
// - Who is who: a saved link (sign-in -> Roster name), else the one person whose saved phone or email
//   matches the verified one. Anyone else asks for their name and an admin approves it.
import { verifyHubToken, makeSession, sessionSecret, sessionCookie, sessionOf, rosterNameFor, saveHandoff, moveLink, SESSION_DAYS } from "./hub.js";

export const ADMIN_SEED = ["info@hyderabadchristiancenter.com"];
const NONCE_RE = /^[0-9a-f]{32,64}$/;
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const digits = (s) => String(s || "").replace(/\D/g, "");
const last10 = (s) => digits(s).slice(-10);

/** One admin entry: a lower-case email, or a phone kept as its last 10 digits; "" if neither. */
export function adminKey(v) {
  const t = String(v || "").trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return t;
  return last10(t).length === 10 ? last10(t) : "";
}
export async function adminList(store) {
  const a = await store.getItem("admins");
  return Array.isArray(a) && a.length ? a : ADMIN_SEED.slice();
}
export function isAdminSess(sess, admins) {
  if (!sess) return false;
  const em = (sess.email || "").toLowerCase(), ph = sess.phone ? last10(sess.phone) : "";
  return admins.some((k) => (!!em && k === em) || (ph.length === 10 && k === ph));
}

/** The teams `name` leads in roster data `d`: named team leader, or level assistant/leader on that team. */
export function leadTeamsOf(d, name) {
  if (!d || !name) return [];
  const cfg = d.cfg || {}, leaders = cfg.leaders || {}, pool = cfg.pool || {}, levels = d.levels || {};
  const t = Object.keys(leaders).filter((k) => leaders[k] === name);
  const levelsOn = !(d.feat && d.feat.levels === false);
  if (levelsOn && (levels[name] === "assistant" || levels[name] === "leader")) Object.keys(pool).forEach((k) => { if ((pool[k] || []).includes(name) && !t.includes(k)) t.push(k); });
  return t;
}

/** Who this request is: lead = a signed-in admin; me = the Roster name their sign-in is linked to. */
export async function whoIs(request, store, env) {
  const sess = env && typeof store.getItem === "function" ? await sessionOf(request, env, store) : null;
  if (!sess) return { lead: false, me: "", sess: null };
  const lead = isAdminSess(sess, await adminList(store));
  const me = (await rosterNameFor(sess, store)).name;
  return { lead, me, sess };
}

/** GET /auth/config: the Firebase web settings for the sign-in page (public values), read from the project's Hosting. */
let configCache = null;
export async function handleConfig(request, env, fetchFn = fetch) {
  const host = new URL(request.url).host;
  const id = env.HUB_PROJECT_ID || "";
  if (!id) return json({ error: "not set up" }, 503);
  if (!configCache) {
    // The project's Hosting serves its web settings; the church's own Hub address is the same site.
    let c = null;
    for (const u of ["https://" + id + ".web.app/__/firebase/init.json", "https://hub.hyderabadchristiancenter.com/__/firebase/init.json"]) {
      try { const r = await fetchFn(u); if (r.ok) { const j = await r.json(); if (j && j.apiKey && (!j.projectId || j.projectId === id)) { c = j; break; } } } catch {}
    }
    if (!c) return json({ error: "config" }, 502);
    configCache = { apiKey: c.apiKey, projectId: c.projectId || id, appId: c.appId };
  }
  // authDomain is Roster's own address: /__/auth/* is passed through to Firebase (see handleAuthProxy), so
  // Google sign-in stays on one site. iPhone Safari and in-app browsers lose the sign-in otherwise.
  return json({ ...configCache, authDomain: host }, 200, { "cache-control": "no-cache" });
}

/**
 * POST /auth/signin { idToken, n? }: checks the Firebase token (Google or SMS sign-in on /signin) and sets
 * Roster's session cookie. With n (from the installed app), the session also waits 10 minutes for that app.
 */
export async function handleSignIn(request, env, store, fetchFn = fetch) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  const r = await verifyHubToken(String((b && b.idToken) || ""), env.HUB_PROJECT_ID || "", Date.now(), fetchFn, { anyone: true });
  if (!r.ok) { console.log("Roster sign-in refused:", r.detail); return json({ ok: false, error: "That sign-in didn't work. Try again." }, 401); }
  const value = await makeSession(await sessionSecret(env, store), r.claims);
  const n = String((b && b.n) || "");
  if (NONCE_RE.test(n)) await saveHandoff(store, n, value);
  return json({ ok: true, handoff: NONCE_RE.test(n) || undefined }, 200, { "set-cookie": sessionCookie(value, SESSION_DAYS * 86400) });
}

/**
 * GET /api/me: { signedIn: false } or { signedIn, signedInAs, admin, name, how, asked }.
 * POST /api/me { name }: an admin links their own sign-in at once; anyone else asks, and an admin approves.
 */
export async function handleMe(request, env, store) {
  const sess = await sessionOf(request, env, store);
  if (!sess) return json({ signedIn: false });
  const admin = isAdminSess(sess, await adminList(store));
  const reqs = (await store.getItem("accessReq")) || {};
  if (request.method === "GET") {
    const who = await rosterNameFor(sess, store);
    return json({ signedIn: true, signedInAs: sess.email || sess.phone || sess.name, admin, name: who.name, how: who.how, asked: (!who.name && reqs[sess.sub] && reqs[sess.sub].want) || "" });
  }
  if (request.method === "POST") {
    let name = "";
    try { name = String((await request.json()).name || "").trim().slice(0, 80); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
    if (!name) return json({ ok: false, error: "name" }, 400);
    const links = (await store.getItem("hubLinks")) || {};
    if (links[sess.sub]) return json({ ok: false, error: "already linked", name: links[sess.sub] }, 409);
    if (admin) { moveLink(links, sess.sub, name); await store.putItem("hubLinks", links); return json({ ok: true, name }); }
    reqs[sess.sub] = { want: name, who: sess.name, email: sess.email || "", phone: sess.phone || "", at: Date.now() };
    await store.putItem("accessReq", reqs);
    return json({ ok: true, asked: name }, 202);
  }
  return new Response("Method not allowed", { status: 405 });
}

/**
 * /api/access (admins). GET: { requests: [{ id, want, who, email, phone, at }], linked: [names] }.
 * POST { id, name }: links that sign-in to name (approve). POST { id, deny: true }: drops the request.
 * POST { name, unlink: true }: frees a name from whatever sign-in holds it.
 */
export async function handleAccess(request, store, isAdmin) {
  if (!isAdmin) return new Response("Admins only", { status: 403 });
  const reqs = (await store.getItem("accessReq")) || {}, links = (await store.getItem("hubLinks")) || {};
  if (request.method === "GET") {
    return json({ requests: Object.keys(reqs).map((id) => ({ id, ...reqs[id] })).sort((a, b) => b.at - a.at), linked: [...new Set(Object.values(links))].sort() });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  const name = String((b && b.name) || "").trim().slice(0, 80), id = String((b && b.id) || "");
  if (b.unlink) {
    if (!name) return json({ ok: false, error: "name" }, 400);
    let n = 0; for (const k of Object.keys(links)) if (links[k] === name) { delete links[k]; n++; }
    await store.putItem("hubLinks", links); return json({ ok: true, removed: n });
  }
  if (!reqs[id]) return json({ ok: false, error: "no such request" }, 404);
  if (!b.deny) { if (!name) return json({ ok: false, error: "name" }, 400); moveLink(links, id, name); await store.putItem("hubLinks", links); }
  delete reqs[id]; await store.putItem("accessReq", reqs);
  return json({ ok: true });
}

/** /api/admins (admins). GET: { admins }. PUT { admins: [email or phone] }: replaces the list; it must keep you. */
export async function handleAdmins(request, store, who) {
  if (!who.lead) return new Response("Admins only", { status: 403 });
  if (request.method === "GET") return json({ admins: await adminList(store) });
  if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  const raw = Array.isArray(b && b.admins) ? b.admins.slice(0, 50) : null;
  if (!raw) return json({ ok: false, error: "admins" }, 400);
  const list = [...new Set(raw.map(adminKey).filter(Boolean))];
  if (!isAdminSess(who.sess, list)) return json({ ok: false, error: "keep yourself" }, 409);
  await store.putItem("admins", list);
  return json({ ok: true, admins: list });
}

/**
 * /__/auth/* and /__/firebase/*: Firebase's sign-in helper pages, fetched from the project's own
 * firebaseapp.com address and served from Roster's address (Firebase's advice for browsers that partition storage).
 */
export async function handleAuthProxy(request, env, fetchFn = fetch) {
  const id = env.HUB_PROJECT_ID || "";
  if (!id) return new Response("Not set up", { status: 503 });
  const url = new URL(request.url);
  const target = "https://" + id + ".firebaseapp.com" + url.pathname + url.search;
  const headers = new Headers(request.headers);
  for (const h of ["host", "cookie", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"]) headers.delete(h);
  const hasBody = !["GET", "HEAD"].includes(request.method);
  const r = await fetchFn(target, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined, redirect: "manual" });
  const out = new Headers(r.headers);
  out.delete("set-cookie");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
}
