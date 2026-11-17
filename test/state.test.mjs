import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// handleState is tested with a plain in-memory store; the Durable Object import is stubbed out.
const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject {}")
  .replace('"./sevenshifts.js"', JSON.stringify(new URL("../src/sevenshifts.js", import.meta.url).href))
  .replace('"./hub.js"', JSON.stringify(new URL("../src/hub.js", import.meta.url).href))
  .replace('"./hubpeople.js"', JSON.stringify(new URL("../src/hubpeople.js", import.meta.url).href))
  .replace('"./auth.js"', JSON.stringify(new URL("../src/auth.js", import.meta.url).href))
  .replace('"./rename.js"', JSON.stringify(new URL("../src/rename.js", import.meta.url).href));
const { makeSession } = await import("../src/hub.js");
const { handleState: rawState } = await import("data:text/javascript," + encodeURIComponent(src));

// Same contract as RosterStore.
function mem() {
  let rev = 0, v = null; const kv = {};
  return {
    get: async () => ({ rev, data: v }),
    put: async (base, text) => (base !== rev ? { ok: false, rev, data: v } : ((v = text), (rev += 1), { ok: true, rev })),
    getItem: async (k) => kv[k] ?? null, putItem: async (k, val) => { kv[k] = val; },
  };
}
const mem2 = mem;
// Sessions as /auth/signin makes them. The church account is the first admin.
const env = { HUB_PROJECT_ID: "p", SESSION_SECRET: "test-secret" };
const ADMIN = await makeSession("test-secret", { sub: "u-admin", name: "Office", role: "member", email: "info@hyderabadchristiancenter.com" });
const sess = (sub, extra = {}) => makeSession("test-secret", { sub, name: sub, role: "member", ...extra });
const ck = (c) => (c ? { cookie: "roster_session=" + c } : {});
const handleState = (r, s) => rawState(r, s, env);
let asWho = ADMIN;
const req = (method, body, c = asWho) => new Request("https://x/api/state", { method, body, headers: ck(c) });
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

const mod = await import("data:text/javascript," + encodeURIComponent(src));

test("signed-out saves are refused, and an old leader PIN is dropped", async () => {
  const s = mem();
  assert.equal((await rawState(req("PUT", JSON.stringify({ rev: 0, data: { slots: [] } }), null), s, env)).status, 401);
  assert.equal((await rawState(req("PUT", JSON.stringify({ rev: 0, data: { slots: [] } }), await sess("stranger")), s, env)).status, 401);
  await put(s, 0, { slots: [], pinHash: "abc" });
  assert.equal("pinHash" in JSON.parse((await s.get()).data), false);
});

test("contacts are for admins only", async () => {
  const s = mem();
  await s.putItem("hubLinks", { "u-ana": "Ana" });
  const r = async (method, c, body) => mod.handleContacts(new Request("https://x/api/contacts", { method, body, headers: ck(c) }), s, env);
  assert.equal((await r("GET")).status, 403);
  assert.equal((await r("GET", await sess("u-ana"))).status, 403);
  assert.equal((await r("PUT", ADMIN, JSON.stringify({ contacts: { Ana: { phone: "1" } } }))).status, 200);
  assert.deepEqual(await (await r("GET", ADMIN)).json(), { contacts: { Ana: { phone: "1" } } });
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

// --- availability guard, emergency contacts ---
const vput = (s, rev, data, c) => rawState(new Request("https://x/api/state", { method: "PUT", body: JSON.stringify({ rev, data }), headers: ck(c) }), s, env);
const vreq = (path, method, body, c) => new Request("https://x" + path, { method, body: body == null ? undefined : JSON.stringify(body), headers: ck(c) });

test("only the volunteer (or an admin) can change their own availability", async () => {
  const s = mem();
  await s.putItem("hubLinks", { "u-ana": "Ana", "u-ben": "Ben" });
  await put(s, 0, { slots: [], blockouts: { Ana: ["2030-01-06"] }, regularBy: {} });
  const ana = await sess("u-ana"), ben = await sess("u-ben");
  let r = await (await vput(s, 1, { slots: [], blockouts: { Ana: [], Ben: ["2030-01-13"] }, regularBy: { Ana: { "Sun AM": true } } }, ben)).json();
  assert.deepEqual(r.kept, ["Ana"]);
  let got = (await (await handleState(req("GET"), s)).json()).data;
  assert.deepEqual(got.blockouts, { Ana: ["2030-01-06"], Ben: ["2030-01-13"] });
  assert.equal("Ana" in got.regularBy, false);
  r = await (await vput(s, 2, { slots: [], blockouts: { Ana: [], Ben: ["2030-01-13"] } }, ana)).json();
  assert.equal(r.kept, undefined);
  r = await (await vput(s, 3, { slots: [], blockouts: { Ana: ["2030-02-01"] } }, ADMIN)).json();
  assert.equal(r.kept, undefined);
});

test("emergency contact: only that volunteer changes it, admins can read, never in public state", async () => {
  const s = mem();
  await s.putItem("hubLinks", { "u-ana": "Ana" });
  const ana = await sess("u-ana");
  const body = { contact: { name: "Sam", phone: "555 0100", relation: "Brother" } };
  assert.equal((await mod.handleEmergency(vreq("/api/emergency", "PUT", body), s, env)).status, 403);
  assert.equal((await mod.handleEmergency(vreq("/api/emergency", "PUT", body, ADMIN), s, env)).status, 403);
  assert.equal((await mod.handleEmergency(vreq("/api/emergency", "PUT", body, ana), s, env)).status, 200);
  assert.deepEqual(await (await mod.handleEmergency(vreq("/api/emergency", "GET", null, ana), s, env)).json(), body);
  assert.equal((await mod.handleEmergency(vreq("/api/emergency?name=Ana", "GET"), s, env)).status, 403);
  assert.deepEqual(await (await mod.handleEmergency(vreq("/api/emergency?name=Ana", "GET", null, ADMIN), s, env)).json(), body);
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
  const env = { ASSETS: { fetch: async (r) => { seen.push(new URL(r.url).pathname); return new Response("page"); } }, ROSTER: { idFromName: () => 1, get: () => mem() } };
  await mod.default.fetch(new Request("https://x/vol/sched"), env);
  await mod.default.fetch(new Request("https://x/admin/more/person:Paul"), env);
  await mod.default.fetch(new Request("https://x/icon-192.png"), env);
  assert.deepEqual(seen, ["/", "/", "/icon-192.png"]);
});

test("serves: volunteers change none, only ask for cover on their own; team leaders their team; admins anything", async () => {
  const s = mem();
  await s.putItem("hubLinks", { "u-ana": "Ana", "u-ben": "Ben", "u-cy": "Cy" });
  const sl = (id, team, person, status) => ({ id, sid: "a", team, role: "R" + id, person, status });
  const base = { services: [{ id: "a", date: "2099-01-04", svc: "Sun AM" }],
    cfg: { leaders: { Media: "Cy" }, pool: { Media: ["Ana", "Cy"], Worship: ["Ben"] } }, feat: {}, requests: [],
    slots: [sl("1", "Media", "Ana", "confirmed"), sl("2", "Worship", "Ben", "confirmed"), sl("3", "Media", null, "open"), sl("4", "Worship", "Dee", "pending")] };
  await put(s, 0, base);
  const ana = await sess("u-ana"), ben = await sess("u-ben"), cy = await sess("u-cy");
  const now = async () => (await (await handleState(req("GET"), s)).json()).data;
  const by = (o, id) => o.slots.find((x) => x.id === id);
  // Ana tries: decline her own serve, take Ben's, fill the open spot, add a serve, change switches, team leader, times
  let d = await now(); by(d, "1").status = "declined"; by(d, "2").person = "Ana"; by(d, "3").person = "Ana"; by(d, "3").status = "confirmed";
  by(d, "4").status = "confirmed"; d.slots.push(sl("5", "Worship", "Ana", "confirmed")); d.feat = { volpin: false }; d.cfg.leaders.Media = "Ana"; d.services[0].date = "2099-02-01";
  let r = await (await vput(s, 1, d, ana)).json();
  assert.equal(r.held, 4);
  let got = await now();
  assert.deepEqual(got.slots.map((x) => [x.id, x.person, x.status]), [["1", "Ana", "confirmed"], ["2", "Ben", "confirmed"], ["3", null, "open"], ["4", "Dee", "confirmed"]]);
  assert.deepEqual(got.feat, {}); assert.equal(got.cfg.leaders.Media, "Cy"); assert.equal(got.services[0].date, "2099-01-04");
  // removing someone else's serve: it comes back in place
  d = await now(); d.slots = d.slots.filter((x) => x.id !== "2");
  r = await (await vput(s, 2, d, ana)).json(); assert.equal(r.held, 1); assert.deepEqual((await now()).slots.map((x) => x.id), ["1", "2", "3", "4"]);
  // requests: Ana asks cover on her own serve and offers for the open spot (ok); asks cover on Ben's, or in Ben's name (put back)
  d = await now();
  d.requests = [{ id: "q1", kind: "cant", slot: "1", from: "Ana", state: "pending" }, { id: "q2", kind: "pickup", slot: "3", from: "Ana", state: "pending" },
    { id: "q3", kind: "cant", slot: "2", from: "Ana", state: "pending" }, { id: "q4", kind: "cant", slot: "2", from: "Ben", state: "pending" },
    { id: "q5", kind: "swap", slot: "1", from: "Ana", to: "Ben", stage: 1, state: "pending" }];
  r = await (await vput(s, 3, d, ana)).json(); assert.equal(r.held, 2);
  got = await now(); assert.deepEqual(got.requests.map((q) => q.id), ["q1", "q2", "q5"]); assert.equal(by(got, "1").status, "confirmed");
  // Ana can't approve her own request; Ben answers the swap asked of him, but can't approve it
  d = await now(); d.requests[0].state = "approved"; r = await (await vput(s, 4, d, ana)).json(); assert.equal(r.held, 1);
  d = await now(); d.requests[2].stage = 2; r = await (await vput(s, 5, d, ben)).json(); assert.equal(r.held, undefined);
  d = await now(); d.requests[2].state = "approved"; r = await (await vput(s, 6, d, ben)).json(); assert.equal(r.held, 1);
  // Cy leads Media: approves Ana's cover, fills Media's open spot, but can't move Worship
  d = await now(); d.requests[0].state = "approved"; by(d, "1").person = null; by(d, "1").status = "open"; by(d, "3").person = "Cy"; by(d, "3").status = "confirmed"; by(d, "2").person = "Cy";
  r = await (await vput(s, 7, d, cy)).json(); assert.equal(r.held, 1);
  got = await now(); assert.equal(by(got, "3").person, "Cy"); assert.equal(by(got, "1").person, null); assert.equal(by(got, "2").person, "Ben"); assert.equal(got.requests[0].state, "approved");
  // a leader changes anything
  d = await now(); by(d, "2").person = "Ana"; d.feat = { levels: false }; d.requests = [];
  r = await (await vput(s, 8, d, ADMIN)).json(); assert.equal(r.held, undefined);
  got = await now(); assert.equal(by(got, "2").person, "Ana"); assert.deepEqual(got.feat, { levels: false }); assert.deepEqual(got.requests, []);
});
