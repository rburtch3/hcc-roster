// HCC Roster: serves the app page and keeps one shared copy of the roster
// in a Durable Object (SQLite storage, no setup needed on Cloudflare).
import { DurableObject } from "cloudflare:workers";

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/state") {
      const store = env.ROSTER.get(env.ROSTER.idFromName("hcc"));
      return handleState(request, store);
    }
    return env.ASSETS.fetch(request);
  },
};
