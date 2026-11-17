import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const hub = await import("../src/hub.js");
const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject {}")
  .replace('"./sevenshifts.js"', JSON.stringify(new URL("../src/sevenshifts.js", import.meta.url).href))
  .replace('"./hub.js"', JSON.stringify(new URL("../src/hub.js", import.meta.url).href))
  .replace('"./hubpeople.js"', JSON.stringify(new URL("../src/hubpeople.js", import.meta.url).href))
  .replace('"./auth.js"', JSON.stringify(new URL("../src/auth.js", import.meta.url).href));
const auth = await import("../src/auth.js");
const mod = await import("data:text/javascript," + encodeURIComponent(src));

const PID = "hcc-follow-up-72300";
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
const fetchKeys = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "max-age=3600" } });
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function token(claims, { kid = "k1", key = privateKey } = {}) {
  const t = Math.floor(Date.now() / 1000);
  const body = { aud: PID, iss: "https://securetoken.google.com/" + PID, sub: "uid1", iat: t, auth_time: t, exp: t + 3600, ...claims };
  const head = enc({ alg: "RS256", kid }) + "." + enc(body);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head));
  return head + "." + Buffer.from(sig).toString("base64url");
}
function mem() {
  let rev = 0, v = null; const items = {};
  return {
    get: async () => ({ rev, data: v }),
    put: async (base, text) => (base !== rev ? { ok: false, rev, data: v } : ((v = text), (rev += 1), { ok: true, rev })),
    getItem: async (k) => items[k] ?? null,
    putItem: async (k, val) => { items[k] = val; },
  };
}
const env = { HUB_PROJECT_ID: PID, SESSION_SECRET: "test-secret" };


// Roster's own sign-in (Nov 17): any verified Google or phone account on the church's Firebase project.
test("Roster's sign-in takes any verified account; no Hub role needed", async () => {
  hub.resetHubKeys();
  const r = await hub.verifyHubToken(await token({ name: "Ana", email: "Ana@X.com", email_verified: true }), PID, Date.now(), fetchKeys, { anyone: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.claims, { sub: "uid1", name: "Ana", role: "member", teams: [], email: "ana@x.com" });
});

test("bad tokens are refused", async () => {
  hub.resetHubKeys();
  const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])).privateKey;
  const v = (t) => hub.verifyHubToken(t, PID, Date.now(), fetchKeys, { anyone: true });
  assert.equal((await v(await token({}, { key: other }))).detail, "bad signature");
  assert.equal((await v(await token({ aud: "other" }))).detail, "wrong aud");
  assert.equal((await v(await token({ exp: 1 }))).detail, "expired");
  assert.equal((await v("nope")).detail, "not a JWT");
});

test("an unverified email is not used", async () => {
  hub.resetHubKeys();
  const r = await hub.verifyHubToken(await token({ email: "a@b.c", email_verified: false }), PID, Date.now(), fetchKeys, { anyone: true });
  assert.equal(r.claims.email, undefined);
});

test("sessions round-trip and reject tampering and expiry", async () => {
  const c = { sub: "u", name: "A", role: "member", teams: [] };
  const v = await hub.makeSession("s", c, 1000);
  assert.equal((await hub.readSession("s", v, 2000)).role, "member");
  assert.equal(await hub.readSession("other", v, 2000), null);
  assert.equal(await hub.readSession("s", v.replace(/^./, "x"), 2000), null);
  assert.equal(await hub.readSession("s", v, 1000 + 15 * 864e5), null);
});

async function signIn(s, claims, n) {
  hub.resetHubKeys();
  const r = await auth.handleSignIn(new Request("https://x/auth/signin", { method: "POST", body: JSON.stringify({ idToken: await token(claims), n }) }), env, s, fetchKeys);
  assert.equal(r.status, 200);
  return /roster_session=([^;]*)/.exec(r.headers.get("set-cookie"))[1];
}
const withCookie = (path, c, init = {}) => new Request("https://x" + path, { ...init, headers: { ...(init.headers || {}), cookie: "roster_session=" + c } });
const me = async (s, c) => (await auth.handleMe(withCookie("/api/me", c), env, s)).json();
const ask = (s, c, name) => auth.handleMe(withCookie("/api/me", c, { method: "POST", body: JSON.stringify({ name }) }), env, s);
const OFFICE = { sub: "u-office", email: "info@hyderabadchristiancenter.com", email_verified: true };

test("a bad token gets no session", async () => {
  const r = await auth.handleSignIn(new Request("https://x/auth/signin", { method: "POST", body: JSON.stringify({ idToken: "nope" }) }), env, mem(), fetchKeys);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null);
});

test("sign-in finds the person by verified phone, once, and keeps the link", async () => {
  const s = mem();
  await s.putItem("contacts", { Bharat: { phone: "098480 12345" }, Paul: { phone: "9000000000" } });
  const c = await signIn(s, { sub: "u-b", phone_number: "+919848012345" });
  const m = await me(s, c);
  assert.deepEqual([m.signedIn, m.admin, m.name, m.how], [true, false, "Bharat", "match"]);
  assert.deepEqual(await s.getItem("hubLinks"), { "u-b": "Bharat" });
});

test("someone not matched asks for their name; an admin says yes", async () => {
  const s = mem();
  await s.putItem("contacts", { Mum: { phone: "9848012345" }, Son: { phone: "+91 98480 12345" } });
  const c = await signIn(s, { sub: "u-s", phone_number: "+919848012345" });
  assert.equal((await me(s, c)).how, "shared");
  // picking a name only asks; it never links by itself, so nobody can pick a leader's name and become them
  assert.equal((await ask(s, c, "Son")).status, 202);
  let m = await me(s, c);
  assert.deepEqual([m.name, m.asked], ["", "Son"]);
  assert.equal(await s.getItem("hubLinks"), null);
  // the request is for admins only
  assert.equal((await auth.handleAccess(new Request("https://x/api/access"), s, false)).status, 403);
  const list = await (await auth.handleAccess(new Request("https://x/api/access"), s, true)).json();
  assert.deepEqual(list.requests.map((q) => [q.id, q.want, q.phone]), [["u-s", "Son", "+919848012345"]]);
  const yes = await auth.handleAccess(new Request("https://x/api/access", { method: "POST", body: JSON.stringify({ id: "u-s", name: "Son" }) }), s, true);
  assert.equal(yes.status, 200);
  m = await me(s, c);
  assert.deepEqual([m.name, m.asked], ["Son", ""]);
  assert.equal((await ask(s, c, "Mum")).status, 409);
});

test("an admin can say no, and free a name", async () => {
  const s = mem();
  await s.putItem("hubLinks", { a: "Paul", b: "Ana" });
  const c = await signIn(s, { sub: "u-x" });
  await ask(s, c, "Paul");
  await auth.handleAccess(new Request("https://x/api/access", { method: "POST", body: JSON.stringify({ id: "u-x", deny: true }) }), s, true);
  assert.deepEqual(await s.getItem("accessReq"), {});
  const r = await auth.handleAccess(new Request("https://x/api/access", { method: "POST", body: JSON.stringify({ name: "Paul", unlink: true }) }), s, true);
  assert.equal((await r.json()).removed, 1);
  assert.deepEqual(await s.getItem("hubLinks"), { b: "Ana" });
});

test("the church account is the first admin; admins link their own name at once", async () => {
  const s = mem();
  const c = await signIn(s, OFFICE);
  assert.equal((await me(s, c)).admin, true);
  assert.equal((await ask(s, c, "Pastor Ryan")).status, 200);
  assert.equal((await me(s, c)).name, "Pastor Ryan");
  const other = await signIn(s, { sub: "u-o", email: "x@y.com", email_verified: true });
  assert.equal((await me(s, other)).admin, false);
});

test("only admins change the admins list, and can't drop themselves", async () => {
  const s = mem();
  const office = await signIn(s, OFFICE), bharat = await signIn(s, { sub: "u-b", phone_number: "+919848012345" });
  const call = async (c, method, body) => auth.handleAdmins(withCookie("/api/admins", c, { method, body: body && JSON.stringify(body) }), s, await auth.whoIs(withCookie("/", c), s, env));
  assert.equal((await call(bharat, "GET")).status, 403);
  assert.deepEqual((await (await call(office, "GET")).json()).admins, ["info@hyderabadchristiancenter.com"]);
  let r = await call(office, "PUT", { admins: ["info@hyderabadchristiancenter.com", "+91 98480 12345", "junk"] });
  assert.deepEqual((await r.json()).admins, ["info@hyderabadchristiancenter.com", "9848012345"]);
  assert.equal((await me(s, bharat)).admin, true);
  assert.equal((await call(bharat, "PUT", { admins: ["info@hyderabadchristiancenter.com"] })).status, 409);
  assert.equal((await call(office, "PUT", { admins: ["9848012345"] })).status, 409);
});

test("an old HCC Hub admin session is not an admin here", async () => {
  const s = mem();
  const c = await hub.makeSession(await hub.sessionSecret(env, s), { sub: "old", name: "Old", role: "admin" });
  assert.equal((await me(s, c)).admin, false);
  assert.equal((await mod.handleContacts(withCookie("/api/contacts", c), s, env)).status, 403);
});

test("an admin can read contacts; a volunteer can't", async () => {
  const s = mem();
  await s.putItem("contacts", { A: { phone: "1" } });
  const admin = await signIn(s, OFFICE);
  const member = await signIn(s, { sub: "m" });
  assert.equal((await mod.handleContacts(withCookie("/api/contacts", admin), s, env)).status, 200);
  assert.equal((await mod.handleContacts(withCookie("/api/contacts", member), s, env)).status, 403);
});

test("the Worker's routes: sign-in, admins only for 7shifts and access, PINs and the Hub page retired", async () => {
  const s = mem();
  const office = await signIn(s, OFFICE), vol = await signIn(s, { sub: "u-v" });
  const ENV = { ...env, ASSETS: { fetch: async () => new Response("asset") }, ROSTER: { idFromName: () => 1, get: () => s } };
  const go = (path, c, init = {}) => mod.default.fetch(c ? withCookie(path, c, init) : new Request("https://x" + path, init), ENV);
  assert.equal((await go("/api/7shifts/test", vol, { method: "POST" })).status, 403);
  assert.equal((await go("/api/7shifts/test", null, { method: "POST" })).status, 403);
  assert.equal((await go("/api/access", vol)).status, 403);
  assert.equal((await go("/api/access", office)).status, 200);
  assert.equal((await go("/api/vpin", vol)).status, 410);
  assert.equal((await go("/api/unlock", null, { method: "POST" })).status, 410);
  const hubPage = await go("/auth/hub");
  assert.equal(hubPage.status, 302); assert.equal(hubPage.headers.get("location"), "/signin");
  assert.equal((await (await go("/api/me")).json()).signedIn, false);
});

test("only the linked person (or an admin) changes their own availability", async () => {
  const s = mem();
  await s.putItem("hubLinks", { "u-ana": "Ana", "u-ben": "Ben" });
  const office = await signIn(s, OFFICE);
  await mod.handleState(withCookie("/api/state", office, { method: "PUT", body: JSON.stringify({ rev: 0, data: { slots: [], blockouts: { Ana: ["2026-12-01"] } } }) }), s, env);
  const ana = await signIn(s, { sub: "u-ana" });
  const ben = await signIn(s, { sub: "u-ben" });
  const save = async (c, rev, b) => (await mod.handleState(withCookie("/api/state", c, { method: "PUT", body: JSON.stringify({ rev, data: { slots: [], blockouts: b } }) }), s, env)).json();
  assert.deepEqual((await save(ben, 1, {})).kept, ["Ana"]);
  assert.equal(JSON.parse((await s.get()).data).blockouts.Ana[0], "2026-12-01");
  assert.equal((await save(ana, 2, {})).kept, undefined);
  assert.deepEqual(JSON.parse((await s.get()).data).blockouts, {});
});

test("a sign-in that's still waiting for an admin can't save", async () => {
  const s = mem();
  const c = await signIn(s, { sub: "u-new" });
  const r = await mod.handleState(withCookie("/api/state", c, { method: "PUT", body: JSON.stringify({ rev: 0, data: { slots: [] } }) }), s, env);
  assert.equal(r.status, 401);
});

test("only an admin changes who leads a team or a person's level", async () => {
  const s = mem();
  await s.putItem("hubLinks", { "u-cy": "Cy" });
  const office = await signIn(s, OFFICE), cy = await signIn(s, { sub: "u-cy" });
  const save = async (c, rev, data) => (await mod.handleState(withCookie("/api/state", c, { method: "PUT", body: JSON.stringify({ rev, data }) }), s, env)).json();
  await save(office, 0, { slots: [], cfg: { leaders: { Media: "Cy" }, pool: { Media: ["Cy", "Ana"] } }, levels: {} });
  await save(cy, 1, { slots: [], cfg: { leaders: { Media: "Ana", Worship: "Cy" }, pool: { Media: ["Cy", "Ana"] } }, levels: { Ana: "leader" } });
  let d = JSON.parse((await s.get()).data);
  assert.deepEqual(d.cfg.leaders, { Media: "Cy" }); assert.deepEqual(d.levels, {});
  await save(office, 2, { slots: [], cfg: { leaders: { Media: "Ana" }, pool: { Media: ["Cy", "Ana"] } }, levels: { Cy: "assistant" } });
  d = JSON.parse((await s.get()).data);
  assert.deepEqual(d.cfg.leaders, { Media: "Ana" }); assert.deepEqual(d.levels, { Cy: "assistant" });
  assert.deepEqual(auth.leadTeamsOf(d, "Cy"), ["Media"]);
  assert.deepEqual(auth.leadTeamsOf(d, "Ana"), ["Media"]);
});

test("emergency contact: the linked volunteer saves their own", async () => {
  const s = mem();
  await s.putItem("hubLinks", { "u-ana": "Ana" });
  const ana = await signIn(s, { sub: "u-ana" });
  const r = await mod.handleEmergency(withCookie("/api/emergency", ana, { method: "PUT", body: JSON.stringify({ contact: { name: "Mum", phone: "1" } }) }), s, env);
  assert.equal(r.status, 200);
  assert.equal((await s.getItem("emergency")).Ana.name, "Mum");
});

test("sign out clears the cookie", async () => {
  const r = hub.handleSignOut(new Request("https://x/auth/signout", { method: "POST" }));
  assert.match(r.headers.get("set-cookie"), /roster_session=;.*Max-Age=0/);
});

test("installed app: the browser's sign-in is handed to the app once, by its random code", async () => {
  const s = mem(), n = "a".repeat(32);
  await signIn(s, { sub: "u-app" }, n);
  const h = await hub.handleHandoff(new Request("https://x/api/handoff?n=" + n), s);
  const c = /roster_session=([^;]*)/.exec(h.headers.get("set-cookie"))[1];
  assert.equal((await hub.readSession("test-secret", c)).sub, "u-app");
  assert.equal((await (await hub.handleHandoff(new Request("https://x/api/handoff?n=" + n), s)).json()).waiting, true);
  assert.equal((await hub.handleHandoff(new Request("https://x/api/handoff?n=zz"), s)).status, 400);
});

test("sign-in page settings come from the project's Hosting, with the Hub's address as a fallback", async () => {
  const seen = [];
  const f = async (u) => { seen.push(u); return u.includes("web.app") ? new Response("no", { status: 404 }) : new Response(JSON.stringify({ apiKey: "k", projectId: PID, appId: "a" })); };
  const r = await (await auth.handleConfig(new Request("https://x/auth/config"), env, f)).json();
  assert.deepEqual(r, { apiKey: "k", authDomain: PID + ".firebaseapp.com", projectId: PID, appId: "a" });
  assert.equal(seen.length, 2);
});
