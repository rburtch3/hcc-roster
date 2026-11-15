// HCC Roster: serves the app page and keeps one shared copy of the roster
// in a Durable Object (SQLite storage, no setup needed on Cloudflare).
import { DurableObject } from "cloudflare:workers";
import { rowsForWeek, syncRows, publishTest, TEST_ROWS } from "./sevenshifts.js";

const MAX = 1_000_000;

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
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** GET: { rev, data }. PUT { rev, data }: 200 { rev } when rev is the latest, else 409 with the latest. */
export async function handleState(request, store) {
  if (request.method === "GET") {
    const { rev, data } = await store.get();
    return json({ rev, data: data ? JSON.parse(data) : null });
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
    const r = await store.put(body.rev, JSON.stringify(data));
    if (!r.ok) return json({ rev: r.rev, data: r.data ? JSON.parse(r.data) : null }, 409);
    return json({ rev: r.rev });
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
    if (url.pathname === "/api/state") {
      const store = env.ROSTER.get(env.ROSTER.idFromName("hcc"));
      return handleState(request, store);
    }
    return env.ASSETS.fetch(request);
  },
};
