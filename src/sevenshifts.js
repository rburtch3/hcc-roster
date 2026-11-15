// Copies Roster weeks into 7shifts as draft (unpublished) shifts.
// Nothing here publishes or notifies anyone: a leader publishes the week in 7shifts.
// The access token lives only in the Worker secret SEVENSHIFTS_TOKEN.

const API = "https://api.7shifts.com/v2";
const TZ = "+05:30"; // HCC services are in India time
const AFTER_START_HOURS = 2; // a shift runs from call time to 2 hours after the service starts
export const MAX_CREATES = 40; // stay under the Worker's per-request subrequest limit

// Roster position names that are called something else in 7shifts.
const ROLE_ALIASES = { "Song Service|Worship Lead": "Song Leader" };

// The one test shift for Ps Ryan Volunteer (first set for 15 Nov, moved to 22 Nov after that date passed).
export const TEST_ROWS = [["2026-11-22", "Sun AM", "Song Service", "Song Leader", "Ps Ryan Volunteer"]];

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/** "10:00 AM" -> [10, 0] */
export function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t).trim());
  if (!m) throw new Error("Bad time: " + t);
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return [h, Number(m[2])];
}

const pad = (n) => String(n).padStart(2, "0");
const utc = (date, h, m) => new Date(`${date}T${pad(h)}:${pad(m)}:00${TZ}`).toISOString().replace(".000Z", "Z");

/** Start and end of a service shift in UTC ISO. */
export function shiftTimes(date, service) {
  const [ch, cm] = parseTime(service.call || service.time);
  const [sh, sm] = parseTime(service.time);
  const start = utc(date, ch, cm);
  const end = new Date(Date.parse(utc(date, sh, sm)) + AFTER_START_HOURS * 3600e3).toISOString().replace(".000Z", "Z");
  return { start, end };
}

/** "2026-11-15" (a Sunday) -> the dates Sunday..Saturday, or null if not a Sunday. */
export function weekDates(sunday) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sunday || "")) return null;
  const d0 = new Date(sunday + "T00:00:00Z");
  if (isNaN(d0) || d0.getUTCDay() !== 0) return null;
  return Array.from({ length: 7 }, (_, i) => new Date(d0.getTime() + i * 86400e3).toISOString().slice(0, 10));
}

/** Filled Roster rows [date, svc, team, role, person] in that week. */
export function rowsForWeek(roster, sunday) {
  const days = weekDates(sunday);
  if (!days) return null;
  return roster.schedule.filter((r) => days.includes(r[0]) && r[4]);
}

/** Works out the 7shifts shift for each row, given 7shifts lookups. */
export function plan(rows, services, look) {
  const ready = [], unmatched = [];
  for (const [date, svc, team, role, person] of rows) {
    const why = [];
    const service = services[svc];
    if (!service) why.push("no times for " + svc);
    const dept = look.departments.get(norm(team));
    if (!dept) why.push("no 7shifts team " + team);
    const roleName = ROLE_ALIASES[team + "|" + role] || role;
    const roleId = dept ? look.roles.get(dept + "|" + norm(roleName)) : undefined;
    if (dept && !roleId) why.push("no 7shifts role " + roleName + " in " + team);
    const user = look.users.get(norm(person));
    if (user === undefined) why.push("no 7shifts person " + person);
    else if (user === null) why.push("more than one 7shifts person called " + person);
    const label = `${date} ${svc} ${team} ${role}: ${person}`;
    if (why.length) { unmatched.push({ label, why: why.join("; ") }); continue; }
    const { start, end } = shiftTimes(date, service);
    ready.push({ label, body: { user_id: user, department_id: dept, role_id: roleId, start, end } });
  }
  return { ready, unmatched };
}

const shiftKey = (s) => `${s.user_id}|${s.role_id}|${Date.parse(s.start)}`;

/** Thin 7shifts client. `fetchFn` is injectable for tests. */
export function client(env, fetchFn = fetch) {
  const company = env.SEVENSHIFTS_COMPANY_ID;
  const headers = { authorization: "Bearer " + env.SEVENSHIFTS_TOKEN, accept: "application/json", "content-type": "application/json" };
  async function call(method, path, body) {
    const res = await fetchFn(`${API}/company/${company}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`7shifts ${method} ${path.split("?")[0]} answered ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  async function all(path) {
    const out = [];
    let cursor = null;
    for (let i = 0; i < 10; i++) {
      const sep = path.includes("?") ? "&" : "?";
      const page = await call("GET", path + sep + "limit=500" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      out.push(...(page.data || []));
      cursor = page.meta && page.meta.cursor && page.meta.cursor.next;
      if (!cursor) break;
    }
    return out;
  }
  return { call, all };
}

/** Name lookups for the HCC location. A first name shared by two people maps to null. */
export async function lookups(api, locationId) {
  const [depts, roles, users] = await Promise.all([
    api.all(`/departments?location_id=${locationId}`),
    api.all(`/roles?location_id=${locationId}`),
    api.all(`/users?location_id=${locationId}&status=active`),
  ]);
  const departments = new Map(depts.filter((d) => !d.deleted).map((d) => [norm(d.name), d.id]));
  const roleMap = new Map(roles.map((r) => [r.department_id + "|" + norm(r.name), r.id]));
  const userMap = new Map(), firsts = new Map();
  for (const u of users) {
    userMap.set(norm(`${u.first_name} ${u.last_name}`), u.id);
    const f = norm(u.first_name);
    firsts.set(f, firsts.has(f) ? null : u.id);
  }
  for (const [f, id] of firsts) if (!userMap.has(f)) userMap.set(f, id);
  return { departments, roles: roleMap, users: userMap };
}

/**
 * Creates the missing draft shifts for `rows`. With create=false it only reports.
 * Returns { created, already, toCreate, remaining, unmatched }.
 */
export async function syncRows(env, roster, rows, sunday, { create, fetchFn } = {}) {
  const api = client(env, fetchFn);
  const loc = env.SEVENSHIFTS_LOCATION_ID;
  const look = await lookups(api, loc);
  const { ready, unmatched } = plan(rows, roster.services, look);
  const days = weekDates(sunday);
  const from = utc(days[0], 0, 0), to = utc(days[6], 23, 59);
  const existing = await api.all(`/shifts?location_id=${loc}&start[gte]=${from}&start[lte]=${to}&include_draft=true`);
  const have = new Set(existing.filter((s) => !s.deleted).map(shiftKey));
  const missing = ready.filter((r) => !have.has(shiftKey(r.body)));
  const created = [];
  if (create) {
    for (const r of missing.slice(0, MAX_CREATES)) {
      await api.call("POST", "/shifts", { location_id: Number(loc), ...r.body, draft: true, notes: "From HCC Roster" });
      created.push(r.label);
    }
  }
  return {
    week: sunday,
    created,
    already: ready.length - missing.length,
    toCreate: create ? [] : missing.map((r) => r.label),
    remaining: create ? Math.max(0, missing.length - created.length) : missing.length,
    unmatched,
  };
}

/** Publishes only the test shift (sets draft false on it). Returns what 7shifts reports. */
export async function publishTest(env, roster, { fetchFn } = {}) {
  const api = client(env, fetchFn);
  const loc = env.SEVENSHIFTS_LOCATION_ID;
  const look = await lookups(api, loc);
  const { ready, unmatched } = plan(TEST_ROWS, roster.services, look);
  if (!ready.length) return { error: "Test shift not matched: " + unmatched.map((u) => u.why).join("; ") };
  const want = shiftKey(ready[0].body);
  const days = weekDates(TEST_ROWS[0][0]);
  const shifts = await api.all(`/shifts?location_id=${loc}&start[gte]=${utc(days[0], 0, 0)}&start[lte]=${utc(days[6], 23, 59)}&include_draft=true`);
  const s = shifts.find((x) => !x.deleted && shiftKey(x) === want);
  if (!s) return { error: "Test shift isn't in 7shifts yet. Add it first." };
  const r = await api.call("PUT", `/shifts/${s.id}`, { draft: false });
  const d = r.data || {};
  return { published: ready[0].label, publish_status: d.publish_status ?? null, notified: d.notified ?? null, draft: d.draft ?? null };
}
