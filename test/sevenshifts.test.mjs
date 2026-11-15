import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTime, shiftTimes, weekDates, rowsForWeek, syncRows, TEST_ROWS } from "../src/sevenshifts.js";

const roster = JSON.parse(readFileSync(new URL("../public/roster-data.json", import.meta.url), "utf8"));
const env = { SEVENSHIFTS_TOKEN: "t", SEVENSHIFTS_COMPANY_ID: "444506", SEVENSHIFTS_LOCATION_ID: "538073" };

// Fake 7shifts: two teams, a few roles and people, records every call.
function fake({ shifts = [], extraUsers = [] } = {}) {
  const calls = [];
  const page = (data) => ({ object: "x", data, meta: { cursor: { next: null } } });
  const fn = async (url, init) => {
    const u = new URL(url), path = u.pathname.replace("/v2/company/444506", "");
    calls.push({ method: init.method, path, query: u.search, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
    let body;
    if (init.method === "POST") body = { object: "shift", data: { id: calls.length } };
    else if (path === "/departments") body = page([{ id: 1, name: "Song Service" }, { id: 2, name: "Media" }]);
    else if (path === "/roles") body = page([{ id: 10, name: "Song Leader", department_id: 1 }, { id: 11, name: "Singer", department_id: 1 }, { id: 20, name: "Sound", department_id: 2 }]);
    else if (path === "/users") body = page([
      { id: 100, first_name: "Ps Ryan", last_name: "Volunteer" },
      { id: 101, first_name: "Bharat", last_name: "HCC" },
      { id: 102, first_name: "Gracie", last_name: "HCC" },
      { id: 103, first_name: "Paul", last_name: "HCC" }, { id: 104, first_name: "Paul", last_name: "Two" },
      ...extraUsers,
    ]);
    else if (path === "/shifts") body = page(shifts);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fn, calls };
}

test("times are India time, call time to 2 hours after start", () => {
  assert.deepEqual(parseTime("10:00 AM"), [10, 0]);
  assert.deepEqual(parseTime("12:30 PM"), [12, 30]);
  assert.deepEqual(parseTime("12:05 AM"), [0, 5]);
  assert.deepEqual(shiftTimes("2026-11-15", roster.services["Sun AM"]), { start: "2026-11-15T04:30:00Z", end: "2026-11-15T07:30:00Z" });
  assert.deepEqual(shiftTimes("2026-11-21", roster.services["Sat Cleanup"]), { start: "2026-11-21T15:30:00Z", end: "2026-11-21T17:30:00Z" });
});

test("weeks must start on a Sunday", () => {
  assert.equal(weekDates("2026-11-16"), null);
  assert.equal(weekDates("nope"), null);
  assert.deepEqual(weekDates("2026-11-15").at(-1), "2026-11-21");
  const rows = rowsForWeek(roster, "2026-11-15");
  assert.ok(rows.length > 0 && rows.every((r) => r[0] >= "2026-11-15" && r[0] <= "2026-11-21" && r[4]));
});

test("test shift: one draft for Ps Ryan Volunteer as Song Leader, Sun 22 Nov 10 AM", async () => {
  const f = fake();
  const r = await syncRows(env, roster, TEST_ROWS, "2026-11-22", { create: true, fetchFn: f.fn });
  assert.deepEqual(r.unmatched, []);
  assert.equal(r.created.length, 1);
  const post = f.calls.filter((c) => c.method === "POST");
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].body, { location_id: 538073, user_id: 100, department_id: 1, role_id: 10, start: "2026-11-22T04:30:00Z", end: "2026-11-22T07:30:00Z", draft: true, notes: "From HCC Roster" });
  assert.equal(post[0].auth, "Bearer t");
});

test("never makes a shift twice", async () => {
  const f = fake({ shifts: [{ id: 9, user_id: 100, role_id: 10, start: "2026-11-22T04:30:00+00:00" }] });
  const r = await syncRows(env, roster, TEST_ROWS, "2026-11-22", { create: true, fetchFn: f.fn });
  assert.equal(r.created.length, 0);
  assert.equal(r.already, 1);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
});

test("preview creates nothing and lists what it can't match", async () => {
  const f = fake();
  const rows = [
    ["2026-11-15", "Sun AM", "Song Service", "Worship Lead", "Bharat"],
    ["2026-11-15", "Sun AM", "Song Service", "Singer", "Gracie"],
    ["2026-11-15", "Sun AM", "Song Service", "Drums", "Gracie"],
    ["2026-11-15", "Sun AM", "Kids", "Nursery (0-3)", "Gracie"],
    ["2026-11-15", "Sun AM", "Media", "Sound", "Nobody"],
    ["2026-11-15", "Sun AM", "Media", "Sound", "Paul"],
  ];
  const r = await syncRows(env, roster, rows, "2026-11-15", { create: false, fetchFn: f.fn });
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(r.toCreate.length, 2);
  assert.deepEqual(r.unmatched.map((u) => u.why), [
    "no 7shifts role Drums in Song Service",
    "no 7shifts team Kids",
    "no 7shifts person Nobody",
    "more than one 7shifts person called Paul",
  ]);
});

test("creates at most 40 a call and says how many are left", async () => {
  const extraUsers = Array.from({ length: 45 }, (_, i) => ({ id: 1000 + i, first_name: "Singer" + i, last_name: "HCC" }));
  const rows = extraUsers.map((u) => ["2026-11-15", "Sun AM", "Song Service", "Singer", u.first_name]);
  const f = fake({ extraUsers });
  const r = await syncRows(env, roster, rows, "2026-11-15", { create: true, fetchFn: f.fn });
  assert.equal(r.created.length, 40);
  assert.equal(r.remaining, 5);
});
