// Renaming a person (Nov 17): an admin changes a name, and every place the roster keeps it follows.
import { whoIs } from "./auth.js";

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Side data kept by name: contacts, photos, emergency contacts, sign-in links and sign-in requests. */
export const NAMED_ITEMS = ["contacts", "photos", "emergency", "hubLinks", "accessReq"];

/** A copy of v with every object key and every string exactly equal to from changed to to. */
export function renameDeep(v, from, to) {
  if (typeof v === "string") return v === from ? to : v;
  if (Array.isArray(v)) return v.map((x) => renameDeep(x, from, to));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k === from ? to : k] = renameDeep(v[k], from, to);
    return out;
  }
  return v;
}

/** Everyone the roster knows by name. */
function namesIn(data) {
  const cfg = (data && data.cfg) || {}, s = new Set(Array.isArray(cfg.people) ? cfg.people : []);
  for (const list of Object.values(cfg.pool || {})) if (Array.isArray(list)) list.forEach((p) => s.add(p));
  for (const p of Object.values(cfg.leaders || {})) if (typeof p === "string" && p) s.add(p);
  return s;
}

/** POST /api/rename { from, to }: admins only. 409 when to is already someone else's name. */
export async function handleRename(request, store, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await whoIs(request, store, env)).lead) return json({ ok: false, error: "Admins only" }, 403);
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  const from = String((b && b.from) || "").trim(), to = String((b && b.to) || "").trim().replace(/\s+/g, " ");
  if (!from || !to || to.length > 40 || /[<>]/.test(to)) return json({ ok: false, error: "Type a name of up to 40 letters." }, 400);
  if (from === to) return json({ ok: true });
  const { rev, data: text } = await store.get();
  if (!text) return json({ ok: false, error: "No roster yet" }, 409);
  const data = JSON.parse(text), names = namesIn(data);
  if (!names.has(from)) return json({ ok: false, error: from + " isn't on the roster." }, 404);
  if (names.has(to)) return json({ ok: false, error: to + " is already on the roster." }, 409);
  const r = await store.put(rev, JSON.stringify(renameDeep(data, from, to)));
  if (!r.ok) return json({ ok: false, error: "Someone saved at the same moment. Try again." }, 409);
  for (const k of NAMED_ITEMS) { const v = await store.getItem(k); if (v) await store.putItem(k, renameDeep(v, from, to)); }
  // The rename sheet can also save the phone and email in the same step.
  const c = b.contact;
  if (c && typeof c === "object") {
    const contacts = (await store.getItem("contacts")) || {};
    contacts[to] = { ...(contacts[to] || {}), phone: String(c.phone || "").slice(0, 30), email: String(c.email || "").slice(0, 120) };
    await store.putItem("contacts", contacts);
  }
  return json({ ok: true, rev: r.rev });
}
