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
export async function verifyHubToken(token, projectId, now = Date.now(), fetchFn = fetch) {
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
    const role = hub.rota;
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

/**
 * POST /auth/hub (form idToken, as the Hub's tile sends it): checks the token, sets the session
 * cookie and goes to the app. GET /auth/hub goes to the Hub to sign in.
 */
export async function handleAuthHub(request, env, store, fetchFn = fetch) {
  if (request.method === "GET") return Response.redirect(HUB_URL + "/#rota", 302);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let token = "";
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) token = String((await request.json()).idToken || "");
    else token = String((await request.formData()).get("idToken") || "");
  } catch { return page("That sign-in didn't come through. Open Roster from HCC Hub again.", 400); }
  const r = await verifyHubToken(token, env.HUB_PROJECT_ID || "", Date.now(), fetchFn);
  if (!r.ok) {
    console.log("HCC Hub sign-in refused:", r.detail);
    return r.why === "no-access"
      ? page("You're signed in to HCC Hub, but you don't have Roster access yet. Ask an HCC Hub admin to give you Roster access.", 403)
      : page("That sign-in didn't work. Open Roster from HCC Hub again.", 401);
  }
  const value = await makeSession(await sessionSecret(env, store), r.claims);
  return new Response(null, { status: 303, headers: { location: "/", "set-cookie": sessionCookie(value, SESSION_DAYS * 86400), "cache-control": "no-store" } });
}

/** POST /auth/signout: clears the session cookie. */
export function handleSignOut(request) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": sessionCookie("", 0) } });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * GET /api/me: { signedIn: false } or { signedIn, hubName, role, teams, name, how } (name "" = not linked yet).
 * POST /api/me { name }: links this Hub sign-in to a Roster name nobody else is linked to (first time only).
 */
export async function handleMe(request, env, store) {
  const sess = await sessionOf(request, env, store);
  if (!sess) return json({ signedIn: false });
  if (request.method === "GET") {
    const who = await rosterNameFor(sess, store);
    return json({ signedIn: true, hubName: sess.name, role: sess.role, teams: sess.teams, name: who.name, how: who.how });
  }
  if (request.method === "POST") {
    let name = "";
    try { name = String((await request.json()).name || "").trim().slice(0, 80); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
    if (!name) return json({ ok: false, error: "name" }, 400);
    const links = (await store.getItem("hubLinks")) || {};
    if (links[sess.sub]) return json({ ok: false, error: "already linked", name: links[sess.sub] }, 409);
    if (Object.values(links).includes(name)) return json({ ok: false, error: "taken" }, 409);
    links[sess.sub] = name;
    await store.putItem("hubLinks", links);
    return json({ ok: true, name });
  }
  return new Response("Method not allowed", { status: 405 });
}

function page(msg, status) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return new Response('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>HCC Roster</title>'
    + '<body style="font:16px/1.5 -apple-system,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;text-align:center"><h2>HCC Roster</h2><p>' + esc(msg)
    + '</p><p><a href="' + HUB_URL + '" style="color:#2B59F0">Go to HCC Hub</a></p></body>', { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
