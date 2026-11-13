// HCC Roster: serves the app page and keeps one shared copy of the roster
// in a Durable Object (SQLite storage, no setup needed on Cloudflare).
import { DurableObject } from "cloudflare:workers";

const MAX = 1_000_000;

export class RosterStore extends DurableObject {
  async get() {
    return (await this.ctx.storage.get("state")) ?? null;
  }
  async put(text) {
    await this.ctx.storage.put("state", text);
  }
}

export async function handleState(request, store) {
  if (request.method === "GET") {
    const data = await store.get();
    return new Response(data ?? "null", {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX) return new Response("Too large", { status: 413 });
    let parsed;
    try { parsed = JSON.parse(text); } catch { return new Response("Bad JSON", { status: 400 }); }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.slots)) {
      return new Response("Not a roster", { status: 400 });
    }
    await store.put(text);
    return new Response(null, { status: 204 });
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
