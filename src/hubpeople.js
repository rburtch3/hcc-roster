// HCC Hub people -> Roster. The Hub's rosterPeople trigger POSTs one person per change to /hub/people,
// signed with a Google ID token for the Hub's functions account (audience hcc-roster-people). Roster keeps
// them so a Hub sign-in finds the right person, and so everyone in the Hub can be put on a team.
// - Found by Hub ID (kept in the store as hubPeople), else phone (last 10 digits; WhatsApp then phone),
//   else email, else exact name (any case). Names are never changed.
// - Their phone and email are saved to Roster's contacts (leader-only), which sign-in matches on.
// - Someone new and active is added to Roster's people (no team yet). Removed or deleted: kept, marked.
// GET /hub/teams: Roster's team names, for the Hub's leader boxes.

const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
export const HUB_PUSH_AUDIENCE = "hcc-roster-people";
export const HUB_PUSH_EMAIL = "575810669504-compute@developer.gserviceaccount.com";
const SKEW_S = 5 * 60;

let keyCache = null;
export function resetGoogleKeys() { keyCache = null; }
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
async function googleKey(kid, now, fetchFn) {
  const load = async () => {
    const res = await fetchFn(GOOGLE_JWKS);
    if (!res.ok) throw new Error("Google keys " + res.status);
    const keys = new Map();
    for (const k of (await res.json()).keys || []) {
      if (!k.kid || k.kty !== "RSA") continue;
      const { kid: id, ...jwk } = k;
      keys.set(id, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 300);
    return (keyCache = { keys, exp: now + maxAge * 1000, at: now });
  };
  let c = keyCache && keyCache.exp > now ? keyCache : await load();
  if (!c.keys.has(kid) && now - c.at > 60_000) c = await load();
  return c.keys.get(kid);
}

/** Checks the Hub's Google ID token. Returns null when good, else why not. Never throws. */
export async function verifyHubPush(token, env = {}, now = Date.now(), fetchFn = fetch) {
  try {
    const aud = env.HUB_PUSH_AUDIENCE || HUB_PUSH_AUDIENCE, email = env.HUB_PUSH_EMAIL || HUB_PUSH_EMAIL;
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return "not a JWT";
    const head = b64urlJson(parts[0]);
    if (head.alg !== "RS256" || !head.kid) return "not RS256 with a kid";
    const key = await googleKey(head.kid, now, fetchFn);
    if (!key) return "unknown kid";
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1])))) return "bad signature";
    const c = b64urlJson(parts[1]), t = Math.floor(now / 1000);
    if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") return "wrong iss";
    if (c.aud !== aud) return "wrong aud";
    if (c.email !== email || c.email_verified !== true) return "wrong caller";
    if (typeof c.exp !== "number" || c.exp <= t) return "expired";
    if (typeof c.iat !== "number" || c.iat > t + SKEW_S) return "iat in the future";
    return null;
  } catch (e) {
    console.error("Hub push token check failed", e);
    return "error";
  }
}

const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
/** The pushed person, cleaned, or a reason it is not one. */
export function parseHubPerson(o) {
  if (!o || typeof o !== "object") return "body must be an object";
  const hubId = str(o.hubId, 128), name = str(o.name, 80).replace(/\s+/g, " ");
  if (!hubId) return "hubId missing";
  if (!["active", "removed", "deleted"].includes(o.status)) return "status must be active, removed or deleted";
  if (!(o.role == null || ["member", "leader", "admin"].includes(o.role))) return "role must be member, leader, admin or null";
  if (o.status === "active" && !name) return "name missing";
  const teams = Array.isArray(o.teams) ? [...new Set(o.teams.map((t) => str(t, 60)).filter(Boolean))].slice(0, 20) : [];
  return { hubId, name, whatsapp: str(o.whatsapp, 30), phone: str(o.phone, 30), email: str(o.email, 120).toLowerCase(), role: o.role || null, teams, status: o.status };
}

const last10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);
/** Everyone Roster knows by name: its people list and every team's pool. */
function rosterNames(st) {
  const cfg = (st && st.cfg) || {}, out = new Set(Array.isArray(cfg.people) ? cfg.people : []);
  Object.values(cfg.pool || {}).forEach((l) => (Array.isArray(l) ? l : []).forEach((n) => out.add(n)));
  return [...out].filter((n) => typeof n === "string" && n);
}

/** Saves the person; returns { ok, action, name }. Safe to repeat. */
export async function upsertHubPerson(store, p) {
  const hub = (await store.getItem("hubPeople")) || {};
  const contacts = (await store.getItem("contacts")) || {};
  const { rev, data } = await store.get();
  let st = {}; try { st = data ? JSON.parse(data) : {}; } catch { st = {}; }
  const names = rosterNames(st);
  const linked = new Set(Object.entries(hub).filter(([id]) => id !== p.hubId).map(([, v]) => v.name));
  const free = (n) => !linked.has(n);
  let name = hub[p.hubId] && hub[p.hubId].name, action = name ? "updated" : "";
  if (!name) {
    const nums = [p.whatsapp, p.phone].map(last10).filter((d) => d.length === 10);
    const byPhone = Object.keys(contacts).filter((n) => free(n) && nums.includes(last10(contacts[n] && contacts[n].phone)));
    const byEmail = p.email ? Object.keys(contacts).filter((n) => free(n) && String((contacts[n] || {}).email || "").toLowerCase() === p.email) : [];
    const byName = p.name ? names.filter((n) => free(n) && n.toLowerCase() === p.name.toLowerCase()) : [];
    name = (byPhone.length === 1 && byPhone[0]) || (byEmail.length === 1 && byEmail[0]) || (byName.length === 1 && byName[0]) || "";
    action = name ? "linked" : "";
  }
  if (!name) {
    if (p.status !== "active") return { ok: true, action: "unchanged", name: "" };
    // a new person: their Hub name, made unique if Roster already has someone by it
    name = p.name;
    for (let i = 2; names.includes(name) || linked.has(name); i++) name = p.name + " " + i;
    action = "created";
  }
  const before = JSON.stringify([hub[p.hubId], contacts[name]]);
  hub[p.hubId] = { name, role: p.role, teams: p.teams, status: p.status, hubName: p.name };
  if (p.status === "active") {
    const c = { ...(contacts[name] || {}) }, ph = p.whatsapp || p.phone;
    if (ph) c.phone = ph;
    if (p.email) c.email = p.email;
    contacts[name] = c;
  }
  const changed = before !== JSON.stringify([hub[p.hubId], contacts[name]]);
  await store.putItem("hubPeople", hub);
  if (changed) await store.putItem("contacts", contacts);
  if (action === "created") {
    // add them to Roster's people list (retry if someone saved the roster at the same moment)
    let r = { rev, data };
    for (let i = 0; i < 4; i++) {
      let s = {}; try { s = r.data ? JSON.parse(r.data) : null; } catch { s = null; }
      if (!s || !Array.isArray(s.slots)) break; // no roster yet: they still sign in by contacts
      s.cfg = s.cfg || {};
      s.cfg.people = Array.isArray(s.cfg.people) ? s.cfg.people : [];
      if (s.cfg.people.includes(name)) break;
      s.cfg.people.push(name);
      const put = await store.put(r.rev, JSON.stringify(s));
      if (put.ok) break;
      r = { rev: put.rev, data: put.data };
    }
  }
  if (p.status !== "active" && action !== "created") action = "deactivated";
  else if (action === "updated" && !changed) action = "unchanged";
  return { ok: true, action, name };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** POST /hub/people (Bearer Google ID token from the Hub). */
export async function handleHubPeople(request, env, store, fetchFn = fetch) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
  const why = m ? await verifyHubPush(m[1], env, Date.now(), fetchFn) : "no bearer token";
  if (why) { console.log("Hub people push refused:", why); return json({ ok: false, error: "unauthorized" }, 401); }
  const text = await request.text();
  if (text.length > 20_000) return json({ ok: false, error: "body too large" }, 400);
  let body; try { body = JSON.parse(text); } catch { return json({ ok: false, error: "body must be JSON" }, 400); }
  const p = parseHubPerson(body);
  if (typeof p === "string") return json({ ok: false, error: p }, 400);
  return json(await upsertHubPerson(store, p));
}

/** GET /hub/teams: { teams } A to Z, from Roster's positions and pools. */
export async function handleHubTeams(request, store) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const { data } = await store.get();
  let st = {}; try { st = data ? JSON.parse(data) : {}; } catch { st = {}; }
  const cfg = st.cfg || {};
  const teams = [...new Set([...Object.keys(cfg.roles || {}), ...Object.keys(cfg.pool || {})])].sort((a, b) => a.localeCompare(b));
  return new Response(JSON.stringify({ teams }), { headers: { "content-type": "application/json", "cache-control": "max-age=60" } });
}
