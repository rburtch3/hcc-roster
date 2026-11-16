import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const hub = await import("../src/hub.js");
const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject {}")
  .replace('"./sevenshifts.js"', JSON.stringify(new URL("../src/sevenshifts.js", import.meta.url).href))
  .replace('"./hub.js"', JSON.stringify(new URL("../src/hub.js", import.meta.url).href))
  .replace('"./hubpeople.js"', JSON.stringify(new URL("../src/hubpeople.js", import.meta.url).href));
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

test("a good Hub token verifies and carries role, teams, verified phone and email", async () => {
  hub.resetHubKeys();
  const r = await hub.verifyHubToken(await token({ name: "Bharat", phone_number: "+919848012345", email: "B@X.com", email_verified: true, hub: { rota: "leader", rotaTeams: ["Media", " Media ", "Ushers"] } }), PID, Date.now(), fetchKeys);
  assert.equal(r.ok, true);
  assert.deepEqual(r.claims, { sub: "uid1", name: "Bharat", role: "leader", teams: ["Media", "Ushers"], phone: "+919848012345", email: "b@x.com" });
});

test("bad tokens are refused", async () => {
  hub.resetHubKeys();
  const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])).privateKey;
  const v = (t) => hub.verifyHubToken(t, PID, Date.now(), fetchKeys);
  assert.equal((await v(await token({ hub: { rota: "member" } }, { key: other }))).detail, "bad signature");
  assert.equal((await v(await token({ aud: "other", hub: { rota: "member" } }))).detail, "wrong aud");
  assert.equal((await v(await token({ exp: 1, hub: { rota: "member" } }))).detail, "expired");
  assert.equal((await v(await token({}))).why, "no-access");
  assert.equal((await v("nope")).detail, "not a JWT");
});

test("an unverified email is not used", async () => {
  hub.resetHubKeys();
  const r = await hub.verifyHubToken(await token({ email: "a@b.c", email_verified: false, hub: { rota: "member" } }), PID, Date.now(), fetchKeys);
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

async function signIn(s, claims) {
  hub.resetHubKeys();
  const body = new URLSearchParams({ idToken: await token(claims) });
  const r = await hub.handleAuthHub(new Request("https://x/auth/hub", { method: "POST", body }), env, s, fetchKeys);
  assert.equal(r.status, 303);
  return /roster_session=([^;]*)/.exec(r.headers.get("set-cookie"))[1];
}
const withCookie = (path, c, init = {}) => new Request("https://x" + path, { ...init, headers: { ...(init.headers || {}), cookie: "roster_session=" + c } });

test("sign-in finds the person by verified phone, once, and keeps the link", async () => {
  const s = mem();
  await s.putItem("contacts", { Bharat: { phone: "098480 12345" }, Paul: { phone: "9000000000" } });
  const c = await signIn(s, { sub: "u-b", phone_number: "+919848012345", hub: { rota: "member" } });
  const me = await (await hub.handleMe(withCookie("/api/me", c), env, s)).json();
  assert.deepEqual([me.signedIn, me.role, me.name, me.how], [true, "member", "Bharat", "match"]);
  assert.deepEqual(await s.getItem("hubLinks"), { "u-b": "Bharat" });
});

test("a shared number matches nobody; the person picks their name once", async () => {
  const s = mem();
  await s.putItem("contacts", { Mum: { phone: "9848012345" }, Son: { phone: "+91 98480 12345" } });
  const c = await signIn(s, { sub: "u-s", phone_number: "+919848012345", hub: { rota: "member" } });
  assert.equal((await (await hub.handleMe(withCookie("/api/me", c), env, s)).json()).how, "shared");
  const post = (name) => hub.handleMe(withCookie("/api/me", c, { method: "POST", body: JSON.stringify({ name }) }), env, s);
  assert.equal((await post("Son")).status, 200);
  assert.equal((await post("Mum")).status, 409);
  assert.equal((await (await hub.handleMe(withCookie("/api/me", c), env, s)).json()).name, "Son");
});

test("a name already linked to someone else can't be picked", async () => {
  const s = mem();
  await s.putItem("hubLinks", { other: "Paul" });
  const c = await signIn(s, { sub: "u-x", hub: { rota: "member" } });
  const r = await hub.handleMe(withCookie("/api/me", c, { method: "POST", body: JSON.stringify({ name: "Paul" }) }), env, s);
  assert.equal(r.status, 409);
});

test("no Roster access in the Hub gets a plain page, not a session", async () => {
  hub.resetHubKeys();
  const r = await hub.handleAuthHub(new Request("https://x/auth/hub", { method: "POST", body: new URLSearchParams({ idToken: await token({}) }) }), env, mem(), fetchKeys);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("set-cookie"), null);
});

test("a Hub admin session can read contacts; a member can't", async () => {
  const s = mem();
  await s.putItem("contacts", { A: { phone: "1" } });
  const admin = await signIn(s, { sub: "a", hub: { rota: "admin" } });
  const member = await signIn(s, { sub: "m", hub: { rota: "member" } });
  assert.equal((await mod.handleContacts(withCookie("/api/contacts", admin), s, env)).status, 200);
  assert.equal((await mod.handleContacts(withCookie("/api/contacts", member), s, env)).status, 403);
});

test("only the linked person (or an admin) changes their own availability", async () => {
  const s = mem();
  await s.putItem("hubLinks", { "u-ana": "Ana" });
  await mod.handleState(new Request("https://x/api/state", { method: "PUT", body: JSON.stringify({ rev: 0, data: { slots: [], blockouts: { Ana: ["2026-12-01"] } } }) }), s, env);
  const ana = await signIn(s, { sub: "u-ana", hub: { rota: "member" } });
  const ben = await signIn(s, { sub: "u-ben", hub: { rota: "member" } });
  const save = async (c, rev, b) => (await mod.handleState(withCookie("/api/state", c, { method: "PUT", body: JSON.stringify({ rev, data: { slots: [], blockouts: b } }) }), s, env)).json();
  assert.deepEqual((await save(ben, 1, {})).kept, ["Ana"]);
  assert.equal(JSON.parse((await s.get()).data).blockouts.Ana[0], "2026-12-01");
  assert.equal((await save(ana, 2, {})).kept, undefined);
  assert.deepEqual(JSON.parse((await s.get()).data).blockouts, {});
});

test("emergency contact: the linked volunteer saves their own", async () => {
  const s = mem();
  await s.putItem("hubLinks", { "u-ana": "Ana" });
  const ana = await signIn(s, { sub: "u-ana", hub: { rota: "member" } });
  const r = await mod.handleEmergency(withCookie("/api/emergency", ana, { method: "PUT", body: JSON.stringify({ contact: { name: "Mum", phone: "1" } }) }), s, env);
  assert.equal(r.status, 200);
  assert.equal((await s.getItem("emergency")).Ana.name, "Mum");
});

test("sign out clears the cookie", async () => {
  const r = hub.handleSignOut(new Request("https://x/auth/signout", { method: "POST" }));
  assert.match(r.headers.get("set-cookie"), /roster_session=;.*Max-Age=0/);
});
