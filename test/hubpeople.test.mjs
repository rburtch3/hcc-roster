import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyHubPush, resetGoogleKeys, parseHubPerson, upsertHubPerson, handleHubPeople, handleHubTeams, HUB_PUSH_EMAIL } from "../src/hubpeople.js";

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "g1" };
const keys = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "max-age=3600" } });
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function idToken(claims = {}) {
  const t = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", kid: "g1" }) + "." + enc({ iss: "https://accounts.google.com", aud: "hcc-roster-people", email: HUB_PUSH_EMAIL, email_verified: true, iat: t, exp: t + 600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(head));
  return head + "." + Buffer.from(sig).toString("base64url");
}
function mem(state) {
  let rev = state ? 1 : 0, v = state ? JSON.stringify(state) : null; const items = {};
  return {
    get: async () => ({ rev, data: v }),
    put: async (b, t) => (b !== rev ? { ok: false, rev, data: v } : ((v = t), (rev += 1), { ok: true, rev })),
    getItem: async (k) => items[k] ?? null, putItem: async (k, x) => { items[k] = x; }, items, state: () => JSON.parse(v),
  };
}
const roster = () => ({ slots: [], cfg: { people: ["Bharat", "Paul"], pool: { Media: ["Minal", "Bharat"], Kids: ["Althea"] }, roles: { Media: {}, "Song Service": {} } } });
const person = (o) => ({ hubId: "h1", name: "Bharat", whatsapp: "+919848012345", phone: null, email: "B@x.com", role: "leader", teams: ["Media"], status: "active", ...o });

test("only the Hub's service account with the right audience gets in", async () => {
  resetGoogleKeys();
  assert.equal(await verifyHubPush(await idToken(), {}, Date.now(), keys), null);
  assert.equal(await verifyHubPush(await idToken({ aud: "x" }), {}, Date.now(), keys), "wrong aud");
  assert.equal(await verifyHubPush(await idToken({ email: "evil@x.com" }), {}, Date.now(), keys), "wrong caller");
  assert.equal(await verifyHubPush(await idToken({ exp: 1 }), {}, Date.now(), keys), "expired");
});

test("bad bodies are refused", () => {
  assert.equal(parseHubPerson({ name: "A", status: "active" }), "hubId missing");
  assert.equal(parseHubPerson({ hubId: "1", name: "A", status: "gone" }), "status must be active, removed or deleted");
  assert.equal(parseHubPerson({ hubId: "1", status: "active" }), "name missing");
});

test("links by name the first time, saves phone and email, never renames", async () => {
  const s = mem(roster());
  const r = await upsertHubPerson(s, parseHubPerson(person({ name: "bharat" })));
  assert.deepEqual(r, { ok: true, action: "linked", name: "Bharat" });
  assert.deepEqual(s.items.contacts.Bharat, { phone: "+919848012345", email: "b@x.com" });
  assert.equal((await upsertHubPerson(s, parseHubPerson(person({ name: "Bharat K" })))).action, "updated");
  assert.equal((await upsertHubPerson(s, parseHubPerson(person({ name: "Bharat K" })))).action, "unchanged");
  assert.equal(s.items.hubPeople.h1.name, "Bharat");
});

test("finds by phone before name", async () => {
  const s = mem(roster());
  await s.putItem("contacts", { Paul: { phone: "098480 12345" } });
  assert.equal((await upsertHubPerson(s, parseHubPerson(person({ name: "Someone Else" })))).name, "Paul");
});

test("someone new is added to Roster's people; a clash gets a number", async () => {
  const s = mem(roster());
  await upsertHubPerson(s, parseHubPerson(person({ hubId: "h1", name: "Bharat" })));
  const r = await upsertHubPerson(s, parseHubPerson(person({ hubId: "h2", name: "Bharat", whatsapp: "+919000000000", email: "" })));
  assert.deepEqual([r.action, r.name], ["created", "Bharat 2"]);
  const r2 = await upsertHubPerson(s, parseHubPerson(person({ hubId: "h3", name: "Mona", whatsapp: "+919111111111", email: "" })));
  assert.equal(r2.action, "created");
  assert.ok(s.state().cfg.people.includes("Mona") && s.state().cfg.people.includes("Bharat 2"));
});

test("removed people are marked, not deleted; unknown removed people are ignored", async () => {
  const s = mem(roster());
  await upsertHubPerson(s, parseHubPerson(person()));
  assert.equal((await upsertHubPerson(s, parseHubPerson(person({ status: "removed", role: null })))).action, "deactivated");
  assert.equal(s.items.hubPeople.h1.status, "removed");
  assert.ok(s.state().cfg.people.includes("Bharat"));
  assert.equal((await upsertHubPerson(s, parseHubPerson(person({ hubId: "zz", name: "Ghost", whatsapp: "", email: "", status: "deleted" })))).action, "unchanged");
});

test("the endpoint needs the token and answers the action", async () => {
  resetGoogleKeys();
  const s = mem(roster());
  const post = async (auth, body) => handleHubPeople(new Request("https://x/hub/people", { method: "POST", headers: auth ? { authorization: "Bearer " + auth } : {}, body: JSON.stringify(body) }), {}, s, keys);
  assert.equal((await post(null, person())).status, 401);
  const ok = await post(await idToken(), person());
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).action, "linked");
  assert.equal((await post(await idToken(), { hubId: "x" })).status, 400);
});

test("teams A to Z from positions and pools", async () => {
  const r = await handleHubTeams(new Request("https://x/hub/teams"), mem(roster()));
  assert.deepEqual((await r.json()).teams, ["Kids", "Media", "Song Service"]);
});
