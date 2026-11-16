import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// handleState is tested with a plain in-memory store; the Durable Object import is stubbed out.
const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject {}")
  .replace('"./sevenshifts.js"', JSON.stringify(new URL("../src/sevenshifts.js", import.meta.url).href));
const { handleState } = await import("data:text/javascript," + encodeURIComponent(src));

// Same contract as RosterStore.
function mem() {
  let rev = 0, v = null;
  return {
    get: async () => ({ rev, data: v }),
    put: async (base, text) => (base !== rev ? { ok: false, rev, data: v } : ((v = text), (rev += 1), { ok: true, rev })),
  };
}
const req = (method, body) => new Request("https://x/api/state", { method, body });
const put = (s, rev, data) => handleState(req("PUT", JSON.stringify({ rev, data })), s);

test("empty store returns rev 0 and no data", async () => {
  assert.deepEqual(await (await handleState(req("GET"), mem())).json(), { rev: 0, data: null });
});

test("saves and returns a roster", async () => {
  const s = mem(), data = { slots: [{ id: "x1" }] };
  const r = await put(s, 0, data);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { rev: 1 });
  assert.deepEqual(await (await handleState(req("GET"), s)).json(), { rev: 1, data });
});

test("a save from an old copy is refused with the latest", async () => {
  const s = mem();
  await put(s, 0, { slots: [{ id: "a" }] });
  const r = await put(s, 0, { slots: [{ id: "b" }] });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { rev: 1, data: { slots: [{ id: "a" }] } });
});

test("rejects bad input", async () => {
  const s = mem();
  assert.equal((await handleState(req("PUT", "{"), s)).status, 400);
  assert.equal((await handleState(req("PUT", "{}"), s)).status, 400);
  assert.equal((await put(s, 0, {})).status, 400);
  assert.equal((await handleState(req("PUT", "x".repeat(1_000_001)), s)).status, 413);
  assert.equal((await handleState(req("DELETE"), s)).status, 405);
});

test("page says Roster, never Rota", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal(/rota/i.test(html), false);
  assert.match(html, /<title>HCC Roster<\/title>/);
});

// --- leader PIN and contacts ---
const mod = await import("data:text/javascript," + encodeURIComponent(src));
function mem2() {
  const s = mem(), kv = {};
  return Object.assign(s, { getItem: async (k) => kv[k] ?? null, putItem: async (k, v) => { kv[k] = v; } });
}
const post = (path, body, headers) => new Request("https://x" + path, { method: "POST", body: JSON.stringify(body), headers });

test("the PIN hash is never sent back, and a save can't change it", async () => {
  const s = mem2(), h = await mod.hashPin("1234");
  await put(s, 0, { slots: [], pinHash: h });
  const got = await (await handleState(req("GET"), s)).json();
  assert.equal(got.data.pinHash, "set");
  await put(s, 1, { slots: [], pinHash: "set" });
  await put(s, 2, { slots: [], pinHash: await mod.hashPin("9999") });
  assert.equal((await mod.handleUnlock(post("/api/unlock", { pin: "1234" }), s)).status, 200);
});

test("unlock checks the PIN and locks after 10 wrong tries", async () => {
  const s = mem2();
  await put(s, 0, { slots: [], pinHash: await mod.hashPin("2468") });
  const ok = await (await mod.handleUnlock(post("/api/unlock", { pin: "2468" }), s, 1000)).json();
  assert.equal(ok.ok, true);
  for (let i = 0; i < 10; i++) assert.equal((await mod.handleUnlock(post("/api/unlock", { pin: "0000" }), s, 2000)).status, 403);
  assert.equal((await mod.handleUnlock(post("/api/unlock", { pin: "2468" }), s, 3000)).status, 429);
  assert.equal((await mod.handleUnlock(post("/api/unlock", { pin: "2468" }), s, 3000 + 16 * 60_000)).status, 200);
});

test("contacts are for leaders only", async () => {
  const s = mem2(), h = await mod.hashPin("1357");
  await put(s, 0, { slots: [], pinHash: h });
  const r = (method, key, body) => mod.handleContacts(new Request("https://x/api/contacts", { method, body, headers: key ? { "x-roster-key": key } : {} }), s);
  assert.equal((await r("GET")).status, 403);
  assert.equal((await r("GET", "set")).status, 403);
  assert.equal((await r("PUT", h, JSON.stringify({ contacts: { Ana: { phone: "1" } } }))).status, 200);
  assert.deepEqual(await (await r("GET", h)).json(), { contacts: { Ana: { phone: "1" } } });
  assert.equal(JSON.stringify(await (await handleState(req("GET"), s)).json()).includes("Ana"), false);
});

test("7shifts routes: need the token, a Sunday, and the right method", async () => {
  const { handleSevenShifts } = await import("data:text/javascript," + encodeURIComponent(src));
  const roster = JSON.parse(readFileSync(new URL("../public/roster-data.json", import.meta.url), "utf8"));
  const load = async () => roster;
  const env = { SEVENSHIFTS_COMPANY_ID: "1", SEVENSHIFTS_LOCATION_ID: "2" };
  const r = (m, p) => new Request("https://x" + p, { method: m });
  assert.equal((await handleSevenShifts(r("POST", "/api/7shifts/test"), env, load)).status, 503);
  const withToken = { ...env, SEVENSHIFTS_TOKEN: "t" };
  assert.equal((await handleSevenShifts(r("GET", "/api/7shifts/sync?week=2030-01-06"), withToken, load)).status, 405);
  assert.equal((await handleSevenShifts(r("GET", "/api/7shifts/preview?week=2030-01-07"), withToken, load)).status, 400);
  assert.equal((await handleSevenShifts(r("GET", "/api/7shifts/nope"), withToken, load)).status, 404);
});
