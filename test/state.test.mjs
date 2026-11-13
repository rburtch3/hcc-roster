import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// handleState is tested with a plain in-memory store; the Durable Object import is stubbed out.
const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject {}");
const { handleState } = await import("data:text/javascript," + encodeURIComponent(src));

function mem() { let v = null; return { get: async () => v, put: async (t) => { v = t; } }; }
const req = (method, body) => new Request("https://x/api/state", { method, body });

test("empty store returns null", async () => {
  const r = await handleState(req("GET"), mem());
  assert.equal(await r.text(), "null");
});

test("saves and returns a roster", async () => {
  const s = mem();
  const body = JSON.stringify({ slots: [{ id: "x1" }] });
  assert.equal((await handleState(req("PUT", body), s)).status, 204);
  assert.equal(await (await handleState(req("GET"), s)).text(), body);
});

test("rejects bad input", async () => {
  const s = mem();
  assert.equal((await handleState(req("PUT", "{"), s)).status, 400);
  assert.equal((await handleState(req("PUT", "{}"), s)).status, 400);
  assert.equal((await handleState(req("PUT", "x".repeat(1_000_001)), s)).status, 413);
  assert.equal((await handleState(req("DELETE"), s)).status, 405);
});

test("page says Roster, never Rota", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal(/rota/i.test(html), false);
  assert.match(html, /<title>HCC Roster<\/title>/);
});
