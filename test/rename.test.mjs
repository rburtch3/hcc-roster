import { test } from "node:test";
import assert from "node:assert/strict";
import { renameDeep, handleRename } from "../src/rename.js";
import * as hub from "../src/hub.js";

function memStore(state, items = {}) {
  let rev = 3, text = JSON.stringify(state); const it = { ...items };
  return { async get() { return { rev, data: text }; }, async put(b, t) { if (b !== rev) return { ok: false, rev }; text = t; rev++; return { ok: true, rev }; },
    async getItem(k) { return it[k] ?? null; }, async putItem(k, v) { it[k] = v; }, state: () => JSON.parse(text), items: it };
}
const env = { HUB_PROJECT_ID: "p", SESSION_SECRET: "test-secret" };
async function cookie(store, claims) { const v = await hub.makeSession("test-secret", claims); return "roster_session=" + v; }
const req = (c, body) => new Request("https://x/api/rename", { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });

test("renameDeep changes whole keys and values only", () => {
  const out = renameDeep({ a: ["Pastor Ryan .", "Pastor Ryanx"], "Pastor Ryan .": { who: "Pastor Ryan ." }, t: "said Pastor Ryan ." }, "Pastor Ryan .", "Pastor Ryan");
  assert.deepEqual(out, { a: ["Pastor Ryan", "Pastor Ryanx"], "Pastor Ryan": { who: "Pastor Ryan" }, t: "said Pastor Ryan ." });
});

test("admins rename a person everywhere; others can't", async () => {
  const state = { cfg: { people: ["Bharat", "Suresh"], pool: { Media: ["Suresh"] }, leaders: { Media: "Suresh" } }, slots: [{ person: "Suresh" }], regularBy: { Suresh: {} } };
  const s = memStore(state, { contacts: { Suresh: { phone: "1" } }, photos: { Suresh: "data:x" }, hubLinks: { u1: "Suresh" } });
  const vol = await cookie(s, { sub: "v", name: "v", role: "member", email: "v@x.test" });
  assert.equal((await handleRename(req(vol, { from: "Suresh", to: "Suresh K" }), s, env)).status, 403);
  const adm = await cookie(s, { sub: "a", name: "Office", role: "member", email: "info@hyderabadchristiancenter.com" });
  assert.equal((await handleRename(req(adm, { from: "Suresh", to: "Bharat" }), s, env)).status, 409);
  const r = await handleRename(req(adm, { from: "Suresh", to: "Suresh K" }), s, env);
  assert.equal(r.status, 200);
  const st = s.state();
  assert.deepEqual(st.cfg.people, ["Bharat", "Suresh K"]); assert.deepEqual(st.cfg.pool.Media, ["Suresh K"]); assert.equal(st.cfg.leaders.Media, "Suresh K");
  assert.equal(st.slots[0].person, "Suresh K"); assert.ok(st.regularBy["Suresh K"]);
  assert.equal(s.items.contacts["Suresh K"].phone, "1"); assert.equal(s.items.photos["Suresh K"], "data:x"); assert.equal(s.items.hubLinks.u1, "Suresh K");
});
