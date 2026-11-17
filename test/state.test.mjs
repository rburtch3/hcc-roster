import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// handleState is tested with a plain in-memory store; the Durable Object import is stubbed out.
const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject {}")
  .replace('"./sevenshifts.js"', JSON.stringify(new URL("../src/sevenshifts.js", import.meta.url).href))
  .replace('"./hub.js"', JSON.stringify(new URL("../src/hub.js", import.meta.url).href))
  .replace('"./hubpeople.js"', JSON.stringify(new URL("../src/hubpeople.js", import.meta.url).href));
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

// --- volunteer PINs, availability guard, emergency contacts ---
const vreq = (path, method, body, headers) => new Request("https://x" + path, { method, body: body == null ? undefined : JSON.stringify(body), headers });
const vput = (s, rev, data, headers) => handleState(new Request("https://x/api/state", { method: "PUT", body: JSON.stringify({ rev, data }), headers }), s);

test("volunteer PIN: set once, then checked, locks after 10 wrong tries, leader can reset", async () => {
  const s = mem2(), lead = await mod.hashPin("1111");
  await put(s, 0, { slots: [], pinHash: lead });
  // a stranger can't set Ana's first PIN; a leader can
  const stranger = await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "9999" }), s, 1000);
  assert.equal(stranger.status, 403); assert.equal((await stranger.json()).reason, "ask");
  const set = await (await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "4321" }, { "x-roster-key": lead }), s, 1000)).json();
  assert.equal(set.ok, true); assert.equal(set.first, true); assert.equal(set.key, undefined);
  const first = await (await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "4321" }), s, 1000)).json();
  assert.equal(first.ok, true);
  assert.deepEqual(await (await mod.handleVolPin(vreq("/api/vpin", "GET"), s)).json(), { names: ["Ana"] });
  const again = await (await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "4321" }), s, 1000)).json();
  assert.equal(again.key, first.key); assert.equal(again.first, undefined);
  // nobody else can change Ana's PIN; Ana (with her key) or a leader can
  assert.equal((await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "8888", change: true }), s, 1000)).status, 403);
  const ben = await (await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ben", pin: "5555" }, { "x-roster-key": lead }), s, 1000)).json();
  const benKey = (await (await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ben", pin: "5555" }), s, 1000)).json()).key;
  assert.equal(ben.ok, true);
  assert.equal((await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "8888", change: true }, { "x-vol-name": "Ben", "x-vol-key": benKey }), s, 1000)).status, 403);
  const ch = await (await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "7777", change: true }, { "x-vol-name": "Ana", "x-vol-key": first.key }), s, 1000)).json();
  assert.equal(ch.ok, true); assert.notEqual(ch.key, first.key);
  assert.equal((await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "4321", change: true }, { "x-roster-key": lead }), s, 1000)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "0000" }), s, 2000)).status, 403);
  assert.equal((await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "4321" }), s, 3000)).status, 429);
  assert.equal((await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", reset: true }), s)).status, 403);
  assert.equal((await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", reset: true }, { "x-roster-key": lead }), s)).status, 200);
  assert.deepEqual(await (await mod.handleVolPin(vreq("/api/vpin", "GET"), s)).json(), { names: ["Ben"] });
  assert.equal(JSON.stringify(await (await handleState(req("GET"), s)).json()).includes(first.key), false);
});

test("only the volunteer (or a leader) can change their own availability", async () => {
  const s = mem2(), lead = await mod.hashPin("1111");
  await put(s, 0, { slots: [], pinHash: lead, blockouts: { Ana: ["2030-01-06"] }, regularBy: {} });
  await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "4321" }, { "x-roster-key": lead }), s);
  const key = (await (await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "4321" }), s)).json()).key;
  await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ben", pin: "5555" }, { "x-roster-key": lead }), s);
  const ben = { "x-vol-name": "Ben", "x-vol-key": (await (await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ben", pin: "5555" }), s)).json()).key };
  // a stranger, signed in as nobody, can't save at all
  assert.equal((await vput(s, 1, { slots: [], blockouts: {} })).status, 401);
  // someone else's device: Ana's change is put back, Ben's goes through
  let r = await (await vput(s, 1, { slots: [], blockouts: { Ana: [], Ben: ["2030-01-13"] }, regularBy: { Ana: { "Sun AM": true } } }, ben)).json();
  assert.deepEqual(r.kept, ["Ana"]);
  let got = (await (await handleState(req("GET"), s)).json()).data;
  assert.deepEqual(got.blockouts, { Ana: ["2030-01-06"], Ben: ["2030-01-13"] });
  assert.equal("Ana" in got.regularBy, false);
  // Ana signed in
  r = await (await vput(s, 2, { slots: [], blockouts: { Ana: [], Ben: ["2030-01-13"] } }, { "x-vol-name": "Ana", "x-vol-key": key })).json();
  assert.equal(r.kept, undefined);
  // a leader
  r = await (await vput(s, 3, { slots: [], blockouts: { Ana: ["2030-02-01"] } }, { "x-roster-key": lead })).json();
  assert.equal(r.kept, undefined);
  // switch off: anyone can change it
  await vput(s, 4, { slots: [], feat: { volpin: false }, blockouts: { Ana: ["2030-02-01"] } }, { "x-roster-key": lead });
  r = await (await vput(s, 5, { slots: [], feat: { volpin: false }, blockouts: {} })).json();
  assert.equal(r.kept, undefined);
});

test("emergency contact: only that volunteer changes it, leaders can read, never in public state", async () => {
  const s = mem2(), lead = await mod.hashPin("1111");
  await put(s, 0, { slots: [], pinHash: lead });
  await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "4321" }, { "x-roster-key": lead }), s);
  const key = (await (await mod.handleVolPin(vreq("/api/vpin", "POST", { name: "Ana", pin: "4321" }), s)).json()).key;
  const me = { "x-vol-name": "Ana", "x-vol-key": key };
  const body = { contact: { name: "Sam", phone: "555 0100", relation: "Brother" } };
  assert.equal((await mod.handleEmergency(vreq("/api/emergency", "PUT", body), s)).status, 403);
  assert.equal((await mod.handleEmergency(vreq("/api/emergency", "PUT", body, { "x-roster-key": lead }), s)).status, 403);
  assert.equal((await mod.handleEmergency(vreq("/api/emergency", "PUT", body, me), s)).status, 200);
  assert.deepEqual(await (await mod.handleEmergency(vreq("/api/emergency", "GET", null, me), s)).json(), body);
  assert.equal((await mod.handleEmergency(vreq("/api/emergency?name=Ana", "GET"), s)).status, 403);
  assert.deepEqual(await (await mod.handleEmergency(vreq("/api/emergency?name=Ana", "GET", null, { "x-roster-key": lead }), s)).json(), body);
  assert.equal(JSON.stringify(await (await handleState(req("GET"), s)).json()).includes("555"), false);
});

test("calendar feed lists only that person's published serves", async () => {
  const s = mem();
  const st = { services: [{ id: "a", date: "2099-01-04", svc: "Sun AM", published: true }, { id: "b", date: "2099-01-07", svc: "Wed PM", published: false }],
    slots: [{ id: "x1", sid: "a", person: "Ann", role: "Singer", team: "Worship" }, { id: "x2", sid: "b", person: "Ann", role: "Singer", team: "Worship" }, { id: "x3", sid: "a", person: "Bo", role: "Drums", team: "Worship" }],
    cfg: { services: { "Sun AM": { name: "Sunday Morning", call: "9:30 AM", time: "10:00 AM" } } } };
  await s.put(0, JSON.stringify(st));
  const r = await mod.handleCal(new Request("https://x/api/cal?n=Ann"), s);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/calendar/);
  const t = await r.text();
  assert.equal((t.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(t, /SUMMARY:Singer · Sunday Morning/);
  assert.match(t, /DTSTART:20990104T040000Z/);
});

test("app page paths (/vol/..., /admin/...) serve the one page", async () => {
  const seen = [];
  const env = { ASSETS: { fetch: async (r) => { seen.push(new URL(r.url).pathname); return new Response("page"); } }, ROSTER: { idFromName: () => 1, get: () => mem2() } };
  await mod.default.fetch(new Request("https://x/vol/sched"), env);
  await mod.default.fetch(new Request("https://x/admin/more/person:Paul"), env);
  await mod.default.fetch(new Request("https://x/icon-192.png"), env);
  assert.deepEqual(seen, ["/", "/", "/icon-192.png"]);
});
