// Sign-in through HCC Hub (https://hub.hyderabadchristiancenter.com, Firebase project HUB_PROJECT_ID).
// The Hub signs people in with Google or SMS and puts a custom claim on their Firebase ID token:
// hub = { rota: 'admin' | 'leader' | 'member', rotaTeams: [...] } (same claim the old Rota app used).
// Its Roster tile POSTs that token (form field idToken) to /auth/hub. The token is checked here with
// WebCrypto against Google's published keys, then Roster sets its own signed session cookie.
// Who the person is in Roster: a saved link (Hub uid -> Roster name), else the one Roster person whose
// saved phone or email matches what Firebase verified, else they pick their name once.

export const HUB_URL = "https://hub.hyderabadchristiancenter.com";
export const SESSION_COOKIE = "roster_session";
export const SESSION_DAYS = 14;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const SKEW_S = 5 * 60;

let keyCache = null; // { keys: Map<kid, CryptoKey>, exp, fetchedAt }
export function resetHubKeys() { keyCache = null; }

async function fetchKeys(now, fetchFn) {
  const res = await fetchFn(JWKS_URL);
  if (!res.ok) throw new Error("Google keys " + res.status);
  const j = await res.json();
  const keys = new Map();
  for (const k of j.keys || []) {
    if (!k.kid || k.kty !== "RSA") continue;
    const { kid, ...jwk } = k;
    keys.set(kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 300);
  keyCache = { keys, exp: now + maxAge * 1000, fetchedAt: now };
  return keyCache;
}
async function googleKey(kid, now, fetchFn) {
  let c = keyCache && keyCache.exp > now ? keyCache : await fetchKeys(now, fetchFn);
  if (!c.keys.has(kid) && now - c.fetchedAt > 60_000) c = await fetchKeys(now, fetchFn);
  return c.keys.get(kid);
}

export function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Checks a Firebase ID token from HCC Hub. Never throws.
 * { ok: true, claims: { sub, name, role, teams, phone?, email? } } or { ok: false, why: 'bad' | 'no-access', detail }.
 */
/** opts.anyone: Roster's own sign-in (Nov 17): any verified account on the project, no Hub claim needed. */
export async function verifyHubToken(token, projectId, now = Date.now(), fetchFn = fetch, opts = {}) {
  const bad = (detail) => ({ ok: false, why: "bad", detail });
  try {
    if (!projectId) return bad("HUB_PROJECT_ID not set");
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return bad("not a JWT");
    const header = b64urlJson(parts[0]);
    if (header.alg !== "RS256" || !header.kid) return bad("not RS256 with a kid");
    const key = await googleKey(header.kid, now, fetchFn);
    if (!key) return bad("unknown kid");
    const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), signed))) return bad("bad signature");
    const c = b64urlJson(parts[1]);
    const t = Math.floor(now / 1000);
    if (c.aud !== projectId) return bad("wrong aud");
    if (c.iss !== "https://securetoken.google.com/" + projectId) return bad("wrong iss");
    if (typeof c.exp !== "number" || c.exp <= t) return bad("expired");
    if (typeof c.iat !== "number" || c.iat > t + SKEW_S) return bad("iat in the future");
    if (typeof c.auth_time !== "number" || c.auth_time > t + SKEW_S) return bad("auth_time in the future");
    if (typeof c.sub !== "string" || !c.sub) return bad("no sub");
    const hub = c.hub && typeof c.hub === "object" ? c.hub : {};
    const role = opts.anyone ? "member" : hub.rota;
    if (role !== "admin" && role !== "leader" && role !== "member") return { ok: false, why: "no-access", detail: "no rota claim" };
    const teams = role === "leader" && Array.isArray(hub.rotaTeams)
      ? [...new Set(hub.rotaTeams.filter((x) => typeof x === "string").map((x) => x.trim().slice(0, 40)).filter(Boolean))].slice(0, 10)
      : [];
    const s = (v) => (typeof v === "string" ? v.trim() : "");
    const phone = s(c.phone_number) || undefined;
    const email = c.email_verified === true && s(c.email) ? s(c.email).toLowerCase() : undefined;
    const name = (s(c.name) || phone || email || "HCC Hub user").slice(0, 80);
    return { ok: true, claims: { sub: c.sub, name, role, teams, ...(phone ? { phone } : {}), ...(email ? { email } : {}) } };
  } catch (e) {
    console.error("HCC Hub token check failed", e);
    return bad("error");
  }
}

/* ---------- Roster's own session cookie ---------- */

/** The HMAC key for sessions: SESSION_SECRET if set, else one made once and kept in the store. */
export async function sessionSecret(env, store) {
  if (env && env.SESSION_SECRET) return env.SESSION_SECRET;
  let s = await store.getItem("sessionSecret");
  if (!s) {
    s = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await store.putItem("sessionSecret", s);
  }
  return s;
}
async function sign(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("roster-session-v1|" + payload));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}
export async function makeSession(secret, claims, now = Date.now()) {
  const payload = b64url(JSON.stringify({ sub: claims.sub, name: claims.name, role: claims.role, teams: claims.teams || [], phone: claims.phone || "", email: claims.email || "", exp: now + SESSION_DAYS * 864e5 }));
  return payload + "." + (await sign(secret, payload));
}
export async function readSession(secret, value, now = Date.now()) {
  if (!value || !secret) return null;
  const [payload, sig, extra] = String(value).split(".");
  if (!payload || !sig || extra !== undefined) return null;
  if (sig !== (await sign(secret, payload))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlBytes(payload)));
    if (typeof p.exp !== "number" || p.exp <= now) return null;
    if (!["admin", "leader", "member"].includes(p.role) || typeof p.sub !== "string") return null;
    return { sub: p.sub, name: String(p.name || ""), role: p.role, teams: Array.isArray(p.teams) ? p.teams.filter((t) => typeof t === "string") : [], phone: String(p.phone || ""), email: String(p.email || "") };
  } catch { return null; }
}
export function cookieOf(request, name) {
  const m = new RegExp("(?:^|;\\s*)" + name + "=([^;]*)").exec(request.headers.get("cookie") || "");
  return m ? m[1] : "";
}
export function sessionCookie(value, maxAgeS) {
  return SESSION_COOKIE + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAgeS;
}
/** The signed-in Hub session on this request, or null. */
export async function sessionOf(request, env, store) {
  const v = cookieOf(request, SESSION_COOKIE);
  return v ? readSession(await sessionSecret(env, store), v) : null;
}

/* ---------- who the session is in Roster ---------- */

const digits = (s) => String(s || "").replace(/\D/g, "");
/** Last 10 digits, so +91 98480 12345, 098480 12345 and 9848012345 are the same number. */
const last10 = (s) => digits(s).slice(-10);

/**
 * The Roster name for this session: a saved link, else the one person whose saved phone (last 10
 * digits) or email matches the verified one. Two or more matches (a shared family number) is none.
 */
export async function rosterNameFor(sess, store) {
  const links = (await store.getItem("hubLinks")) || {};
  if (links[sess.sub]) return { name: links[sess.sub], how: "link" };
  const contacts = (await store.getItem("contacts")) || {};
  const taken = new Set(Object.values(links));
  const ph = sess.phone ? last10(sess.phone) : "", em = (sess.email || "").toLowerCase();
  const found = Object.keys(contacts).filter((n) => {
    if (taken.has(n)) return false;
    const c = contacts[n] || {};
    return (ph.length === 10 && last10(c.phone) === ph) || (!!em && String(c.email || "").trim().toLowerCase() === em);
  });
  if (found.length === 1) {
    links[sess.sub] = found[0];
    await store.putItem("hubLinks", links);
    return { name: found[0], how: "match" };
  }
  return { name: "", how: found.length > 1 ? "shared" : "none" };
}

export const NONCE_RE_EXPORT = /^[0-9a-f]{32,64}$/;
export const NONCE_COOKIE = "roster_nonce";
const NONCE_RE = /^[0-9a-f]{32,64}$/;
const HANDOFF_MS = 10 * 60_000;
/**
 * The installed app (Home Screen) has its own cookies, apart from the phone's browser where the Hub signs
 * people in. So the app opens /auth/hub?n=<random> in the browser; that browser keeps n in a cookie through
 * the Hub round trip; the POST back saves the new session under n for 10 minutes; the app then collects it
 * once from /api/handoff?n=<same>. Only the app that made n knows it.
 */
export async function saveHandoff(store, nonce, value, now = Date.now()) {
  const all = (await store.getItem("handoffs")) || {};
  for (const k of Object.keys(all)) if (all[k].exp <= now) delete all[k];
  all[nonce] = { v: value, exp: now + HANDOFF_MS };
  await store.putItem("handoffs", all);
}
/** GET /api/handoff?n=: sets the session saved for n on this app, once. */
export async function handleHandoff(request, store, now = Date.now()) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const n = new URL(request.url).searchParams.get("n") || "";
  if (!NONCE_RE.test(n)) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const all = (await store.getItem("handoffs")) || {}, h = all[n];
  if (!h || h.exp <= now) return new Response(JSON.stringify({ ok: false, waiting: true }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  delete all[n];
  await store.putItem("handoffs", all);
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": sessionCookie(h.v, SESSION_DAYS * 86400) } });
}

/** POST /auth/signout: clears the session cookie. */
export function handleSignOut(request) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": sessionCookie("", 0) } });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Links this Hub account to name, dropping any older link to the same name. */
export function moveLink(links, sub, name) { for (const k of Object.keys(links)) if (links[k] === name && k !== sub) delete links[k]; links[sub] = name; }

