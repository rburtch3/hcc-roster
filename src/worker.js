// HCC Roster: serves the app page and keeps one shared copy of the roster
// in a Durable Object (SQLite storage, no setup needed on Cloudflare).
import { DurableObject } from "cloudflare:workers";
import { rowsForWeek, syncRows, publishTest, TEST_ROWS } from "./sevenshifts.js";

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
export async function handleState(request, store) {
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
    if (pin) data.pinHash = pin;
    else if ("pinHash" in data && !/^[0-9a-f]{64}$|^d[0-9a-f]+$/.test(String(data.pinHash))) data.pinHash = "";
    const r = await store.put(body.rev, JSON.stringify(data));
    if (!r.ok) return json({ rev: r.rev, data: r.data ? hide(JSON.parse(r.data)) : null }, 409);
    return json({ rev: r.rev });
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
export async function handleContacts(request, store) {
  const want = await storedPin(store), key = request.headers.get("x-roster-key") || "";
  if (!want || key !== want) return new Response("Leaders only", { status: 403 });
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
 * Roster weeks are only ever added as drafts; a leader publishes them in 7shifts.
 */
export async function handleSevenShifts(request, env, loadRoster, fetchFn) {
  const url = new URL(request.url);
  const action = url.pathname.split("/")[3];
  if (!env.SEVENSHIFTS_TOKEN) return json({ error: "The 7shifts token isn't set up yet." }, 503);
  const isTest = action === "test";
  if (!["preview", "sync", "test", "publish-test"].includes(action)) return new Response("Not found", { status: 404 });
  if (action === "publish-test") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    try {
      const r = await publishTest(env, await loadRoster(), { fetchFn });
      return json(r, r.error ? 409 : 200);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/7shifts/")) {
      const loadRoster = async () => (await env.ASSETS.fetch(new URL("/sheet-shifts.json", url))).json();
      return handleSevenShifts(request, env, loadRoster);
    }
    const routes = { "/api/state": handleState, "/api/unlock": handleUnlock, "/api/contacts": handleContacts };
    const h = routes[url.pathname];
    if (h) return h(request, env.ROSTER.get(env.ROSTER.idFromName("hcc")));
    return env.ASSETS.fetch(request);
  },
};
