// @ts-nocheck
// engine: the only write path. Contract: live-build/engine_contract.md
// Every call: identity -> organisation -> permission -> visibility -> rules -> one transaction (write + audit).
// A refused call rolls back and leaves one row in `refusals`, written in a separate statement.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import postgres from "npm:postgres@3.4.4";
import { validateSpec, placement, evalRules, canView, transition, runGeneratedTests, runSeating, SEATING_SPEC } from "./lib.js";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
// One connection per engine instance, released quickly: many concurrent calls must not exhaust the database.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10 });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class Refusal extends Error { detail: unknown; constructor(msg: string, detail?: unknown) { super(msg); this.detail = detail; } }
const refuse = (msg: string, detail?: unknown): never => { throw new Refusal(msg, detail); };

// Reference tables available to tool specs (example data until the Academic Office supplies real lists).
const TABLES: Record<string, { fields: string[]; rows: Record<string, unknown>[] }> = {
  Rooms: { fields: ["room", "capacity"], rows: [["201", 120], ["202", 70], ["203", 70], ["204", 90], ["206", 60], ["208", 60], ["305", 60], ["306", 60], ["401", 150]].map(([room, capacity]) => ({ room, capacity })) },
};
const ADAPTERS: Record<string, { spec: any; run: (body: any) => any }> = { seating: { spec: SEATING_SPEC, run: (b) => runSeating(b.sheets || {}, b.cfg || {}) } };

const MAX_BODY = 6_000_000;           // bytes; a full seating workbook is ~100 KB
const SLUG = /^[a-z][a-z0-9-]{1,40}$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const own = (o: any, k: unknown) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
// A field value must match its declared type; returns an error message or "".
function badField(fd: any, v: any): string {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "object") return "has the wrong type";
  const s = String(v);
  switch (fd.type) {
    case "text": return s.length > 300 ? "is longer than 300 characters" : "";
    case "longtext": return s.length > 4000 ? "is longer than 4000 characters" : "";
    case "number": return Number.isFinite(Number(v)) && s.length <= 15 ? "" : "is not a number";
    case "date": return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s ? "" : "is not a real YYYY-MM-DD date";
    case "time": return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? "" : "is not an HH:MM time";
    case "enum": return (fd.options || []).includes(s) ? "" : `must be one of ${(fd.options || []).join(", ")}`;
    case "ref": return ((TABLES[fd.table] || {}).rows || []).some(r => Object.values(r).map(String).includes(s)) ? "" : `is not in ${fd.table}`;
    default: return "has an unknown type";
  }
}
// Records shown to a group must never carry someone's member ID, however it is written
// (spaced, hyphenated, full-width digits, or run together with another number).
const hasMemberId = (text: string) => /\d{9}/.test(String(text).normalize("NFKC")
  .replace(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}:\d{2}/g, " ")   // dates and times are not IDs
  .replace(/(\d)[\s.\-\u2010-\u2015/]+(?=\d)/g, "$1"));


type Caller = { uid: string; email: string; org: any; member_id: string | null; role: string; staff: boolean; db: any };

// ---------- steps 1-2: identity and organisation, read with the caller's own token ----------
async function identify(req: Request): Promise<Caller> {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) refuse("Sign in first.");
  const db = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error } = await db.auth.getUser(auth.slice(7));
  if (error || !u?.user) refuse("Your sign-in is not valid. Sign in again.");
  const { data: prof } = await db.from("profiles").select("org_id, email, member_id").eq("id", u.user.id).maybeSingle();
  if (!prof) refuse("No organisation profile for this account.");
  const { data: org } = await db.from("organizations").select("id, slug, name, roles, staff_roles, default_role").eq("id", prof.org_id).maybeSingle();
  if (!org) refuse("Organisation not found.");
  const { data: mem } = await db.from("memberships").select("role").eq("org_id", org.id).eq("email", prof.email).maybeSingle();
  const role = mem?.role || org.default_role;
  return { uid: u.user.id, email: prof.email, org, member_id: prof.member_id, role, staff: org.staff_roles.includes(role), db };
}

const env = (c: Caller, tools: Record<string, { entities: string[] }> = {}) => ({ tables: TABLES, tools, roles: c.org.roles });
const audit = (tx: any, c: Caller, action: string, tool_id: string | null, detail: unknown) =>
  tx`insert into public.audit_log (org_id, actor, action, tool_id, detail) values (${c.org.id}, ${c.uid}, ${action}, ${tool_id}, ${tx.json(detail)})`;

// Build DB rows for records of one entity; hidden fields go to record_private.
function rowsFor(spec: any, ent: string, items: { data: any; subject: string | null; src?: string; state?: string | null }[], c: Caller, tool_id: string, version_id: string) {
  const pl = placement(spec, ent, c.org.staff_roles);
  return items.map(it => {
    const pub: any = {}, priv: any = {};
    Object.entries(it.data).forEach(([k, v]) => ((pl.hidden.includes(k) ? priv : pub)[k] = v));
    return { rec: { id: crypto.randomUUID(), org_id: c.org.id, tool_id, version_id, entity: ent, subject_member_id: pl.own ? it.subject : null, audience: pl.audience, data: pub, state: it.state ?? null, src: it.src ?? null, created_by: c.uid }, priv: Object.keys(priv).length ? priv : null };
  });
}
async function insertRows(tx: any, rows: ReturnType<typeof rowsFor>, org_id: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await tx`insert into public.records ${tx(chunk.map(r => ({ ...r.rec, data: tx.json(r.rec.data) })), "id", "org_id", "tool_id", "version_id", "entity", "subject_member_id", "audience", "data", "state", "src", "created_by")}`;
    const priv = chunk.filter(r => r.priv).map(r => ({ record_id: r.rec.id, org_id, data: tx.json(r.priv) }));
    if (priv.length) await tx`insert into public.record_private ${tx(priv, "record_id", "org_id", "data")}`;
  }
}
async function liveVersion(tool_id: string) {
  const [v] = await sql`select id, version, spec from public.tool_versions where tool_id = ${tool_id} and status = 'published'`;
  return v;
}
// Records of other live tools a rule checks against (e.g. timetable sessions), read on the server.
async function ruleContext(c: Caller, spec: any) {
  const tools: Record<string, any> = {};
  for (const r of spec.rules || []) {
    const t = r.against?.tool; if (!t || tools[t]) continue;
    const rows = await sql`select r.id, r.entity, r.data, r.state from public.records r join public.tools t on t.id = r.tool_id join public.tool_versions v on v.id = r.version_id
      where t.org_id = ${c.org.id} and t.slug = ${t} and v.status = 'published'`;
    tools[t] = {};
    rows.forEach((x: any) => (tools[t][x.entity] = tools[t][x.entity] || []).push({ id: x.id, state: x.state, ...x.data }));
  }
  return { tables: TABLES, tools, today: new Date().toISOString().slice(0, 10) };
}

// ---------- actions ----------
async function doImport(c: Caller, b: any) {
  if (!c.staff) refuse("Only staff can import files.");
  const ad = own(ADAPTERS, b.adapter) ? ADAPTERS[b.adapter] : null; if (!ad) refuse(`Unknown source adapter "${b.adapter}".`);
  const slug = String(b.tool || "").trim(); if (!SLUG.test(slug)) refuse("Give the tool a slug like exam-seating.");
  if (!b.sheets || typeof b.sheets !== "object" || Array.isArray(b.sheets)) refuse("The file has no readable sheets.");
  const sheetList = Object.entries(b.sheets);
  if (!sheetList.length || sheetList.length > 60) refuse("Upload between 1 and 60 sheets.");
  if (sheetList.some(([, rows]: any) => !Array.isArray(rows) || rows.length > 5000 || rows.some((r: any) => !Array.isArray(r) || r.length > 60 || r.some((x: any) => x !== null && typeof x === "object")))) refuse("A sheet is not a grid of rows, or is too large (5,000 rows × 60 columns at most).");
  const res = ad.run(b);
  const spec = ad.spec;
  const errs = validateSpec(spec, env(c)); if (errs.length) refuse("The tool spec is invalid.", errs);
  // Seating -> plain records. Students: their own seat. Invigilators: rosters. Everyone: the notice.
  const seats = res.seats.map((s: any) => ({ data: { exam: s.exam, date: s.date, start: s.start, end: s.end, room: s.room, row: s.row, col: s.col, courses: s.courses.join(" / "), sheet: s.sheet }, subject: s.roll, src: s.src }));
  const byRoom: Record<string, any[]> = {};
  res.seats.forEach((s: any) => (byRoom[`${s.sheet}|${s.room}`] = byRoom[`${s.sheet}|${s.room}`] || []).push(s));
  const rosters = Object.values(byRoom).map(g => ({ data: { exam: g[0].exam, date: g[0].date, start: g[0].start, end: g[0].end, room: g[0].room, courses: g[0].courses.join(" / "), students: g.length, sheet: g[0].sheet, seats: g.map(s => `R${s.row}C${s.col} ${s.roll}`).join(", ") }, subject: null, src: g[0].sheet }));
  if (b.notice && hasMemberId(`${b.notice.title || ""} ${b.notice.body || ""}`)) res.issues.push({ key: "notice|member-id", type: "privacy", message: "The notice to everyone contains what looks like a roll number (9 or more digits). Remove it: notices are shown to every student." }), res.flags.push(res.issues.at(-1));
  const notice = b.notice && String(b.notice.body || "").trim() ? [{ data: { title: String(b.notice.title || "Exam Cell notice").slice(0, 200), body: String(b.notice.body).slice(0, 4000) }, subject: null }] : [];
  const checks = { ok: res.issues.length === 0 && res.seats.length > 0, issues: res.issues.length, flags: res.flags, summary: { seats: res.seats.length, students: res.students, rooms: res.rooms, rosters: rosters.length, notices: notice.length } };
  const source = { adapter: b.adapter, files: (b.files || []).slice(0, 20), sheets: Object.keys(b.sheets || {}), cfg: b.cfg || {}, notice: b.notice || null, imported_at: new Date().toISOString() };
  const out = await sql.begin(async (tx: any) => {
    let [tool] = await tx`select id, kind from public.tools where org_id = ${c.org.id} and slug = ${slug} for update`;
    if (tool) { // a slug belongs to one kind of tool: never import a file onto a different tool
      const [last] = await tx`select spec from public.tool_versions where tool_id = ${tool.id} order by version desc limit 1`;
      const adapterOf = (sp: any) => ((sp && sp.inputs) || []).find((i: any) => i.kind === "file")?.adapter;
      if (last && adapterOf(last.spec) !== b.adapter) refuse(`"${slug}" is a different kind of tool; pick another name.`);
    }
    if (!tool) [tool] = await tx`insert into public.tools (org_id, slug, name, kind, created_by) values (${c.org.id}, ${slug}, ${spec.name}, 'information', ${c.uid}) returning id, kind`;
    await tx`delete from public.tool_versions where tool_id = ${tool.id} and status = 'draft'`; // one pending import at a time
    const [{ n }] = await tx`select coalesce(max(version), 0) + 1 as n from public.tool_versions where tool_id = ${tool.id}`;
    const [v] = await tx`insert into public.tool_versions (tool_id, version, spec, status) values (${tool.id}, ${n}, ${tx.json(spec)}, 'draft') returning id, version`;
    await tx`insert into public.tool_version_admin (version_id, org_id, checks, source) values (${v.id}, ${c.org.id}, ${tx.json(checks)}, ${tx.json(source)})`; // staff-only
    await insertRows(tx, rowsFor(spec, "Seat", seats, c, tool.id, v.id), c.org.id);
    await insertRows(tx, rowsFor(spec, "Roster", rosters, c, tool.id, v.id), c.org.id);
    await insertRows(tx, rowsFor(spec, "Notice", notice, c, tool.id, v.id), c.org.id);
    await audit(tx, c, "import", tool.id, { version: v.version, version_id: v.id, source, summary: checks.summary, issues: checks.issues });
    return { tool_id: tool.id, version_id: v.id, version: v.version };
  });
  return { ...out, ...checks };
}

async function doPublish(c: Caller, b: any) {
  if (c.role !== "admin") refuse("Only an admin can publish.");
  if (typeof b.version_id !== "string") refuse("Say which version to publish.");
  const { data: seen } = await c.db.from("tool_versions").select("id").eq("id", b.version_id).maybeSingle(); // visibility, with the caller's own token
  if (!seen) refuse("Version not found in your organisation.");
  const [v] = await sql`select v.id, v.tool_id, v.version, v.spec, v.status, a.checks from public.tool_versions v left join public.tool_version_admin a on a.version_id = v.id where v.id = ${seen.id}`;
  if (v.status !== "draft") refuse(`This version is ${v.status}, not a draft.`);
  const ctx = await ruleContext(c, v.spec);
  const errs = validateSpec(v.spec, env(c, Object.fromEntries(Object.entries(ctx.tools).map(([k, e]) => [k, { entities: Object.keys(e as any) }]))));
  if (errs.length) refuse("The tool spec is invalid.", errs);
  if (!v.checks || v.checks.issues !== 0) refuse(`${v.checks?.issues ?? "Unchecked"} open issue(s). Resolve them and import again.`, (v.checks?.flags || []).filter((f: any) => !f.resolved).slice(0, 20));
  const failed = runGeneratedTests(v.spec, ctx).filter((t: any) => !t.pass);
  if (failed.length) refuse("Generated tests fail.", failed);
  return await sql.begin(async (tx: any) => {
    await tx`select id from public.tools where id = ${v.tool_id} for update`; // concurrent publishes of one tool queue here
    const [still] = await tx`select status from public.tool_versions where id = ${v.id}`;
    if (still.status !== "draft") refuse(`This version is already ${still.status}.`);
    const [leak] = await tx`select count(*)::int as n from public.records where version_id = ${v.id} and ('everyone' = any(audience) or 'student' = any(audience) or 'rep' = any(audience)) and regexp_replace(normalize(data::text, NFKC), '[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}|[0-9]{1,2}:[0-9]{2}', ' ', 'g') ~ '[0-9]([[:space:]./-]*[0-9]){8}'`;
    if (leak.n) refuse(`${leak.n} record(s) shown to a whole group contain a roll number. Remove them before publishing.`);
    const [cnt] = await tx`select count(*)::int as total, count(*) filter (where subject_member_id is null and cardinality(audience) = 0)::int as unplaced from public.records where version_id = ${v.id}`;
    const fromFile = (v.spec.inputs || []).some((i: any) => i.kind === "file");
    if (fromFile && cnt.total === 0) refuse("This import has no records."); // form tools start empty and fill through submit
    if (cnt.unplaced) refuse(`${cnt.unplaced} record(s) have neither a subject nor an audience, so nobody but staff would see them.`);
    const [prev] = await tx`update public.tool_versions set status = 'retired' where tool_id = ${v.tool_id} and status = 'published' and id <> ${v.id} returning id, version`;
    const done = await tx`update public.tool_versions set status = 'published', published_at = now(), published_by = ${c.uid} where id = ${v.id} and status = 'draft' returning id`;
    if (!done.length) refuse("This version changed while publishing; nothing was changed.");
    await audit(tx, c, "publish", v.tool_id, { version: v.version, version_id: v.id, retired: prev || null, records: cnt.total });
    return { published: v.version, version_id: v.id, retired: prev?.version ?? null, records: cnt.total };
  });
}

async function doSubmit(c: Caller, b: any) {
  const { data: tool } = await c.db.from("tools").select("id, slug").eq("slug", b.tool).maybeSingle();
  if (!tool) refuse("Tool not found.");
  const v = await liveVersion(tool.id); if (!v) refuse("This tool has no live version.");
  const spec = v.spec;
  const inp = (spec.inputs || []).find((i: any) => i.id === b.input && i.kind === "form");
  if (!inp) refuse("That form does not exist.");
  if (inp.role !== c.role && !c.staff) refuse(`This form is for ${inp.role}s.`);
  if (!c.member_id && !c.staff) refuse("Your account has no member ID.");
  if (b.data !== undefined && (typeof b.data !== "object" || b.data === null || Array.isArray(b.data))) refuse("The form data is not an object.");
  const data: any = {}, fields = (spec.entities[inp.entity] || {}).fields || {};
  inp.fields.forEach((f: string) => { if (b.data && own(b.data, f)) data[f] = b.data[f]; }); // form fields only; subject is never taken from the request
  const bad = Object.entries(data).map(([f, val]) => [f, badField(fields[f] || {}, val)]).filter(([, e]) => e);
  if (bad.length) refuse(bad.map(([f, e]) => `${(fields[f] || {}).label || f} ${e}`).join("; ") + ".");

  const state = spec.workflow && spec.workflow.entity === inp.entity ? spec.workflow.initial : null;
  const ctx = await ruleContext(c, spec);
  return await sql.begin(async (tx: any) => {
    await tx`select id from public.tool_versions where id = ${v.id} for update`; // serialise submits per tool so rules see every neighbour
    const [recent] = await tx`select count(*)::int as n from public.audit_log where actor = ${c.uid} and action = 'submit' and at > now() - interval '1 hour'`;
    if (recent.n >= 20 && !c.staff) refuse("Too many submissions in the last hour. Try again later.");
    const nb = await tx`select id, data, state, subject_member_id from public.records where version_id = ${v.id} and entity = ${inp.entity}`;
    const rec = { id: "new", ...data, state, requester: c.member_id };
    const store = { [inp.entity]: [...nb.map((x: any) => ({ id: x.id, state: x.state, requester: x.subject_member_id, ...x.data })), rec] };
    const blocking = evalRules(spec, store, ctx, { only: "new", acks: b.acks || {} }).filter((f: any) => !f.resolved);
    if (blocking.length) refuse(blocking[0].message, blocking.map((f: any) => ({ key: f.key, message: f.message, ackable: f.ackable })));
    const rows = rowsFor(spec, inp.entity, [{ data, subject: c.member_id, state }], c, tool.id, v.id);
    await insertRows(tx, rows, c.org.id);
    await audit(tx, c, "submit", tool.id, { version_id: v.id, record_id: rows[0].rec.id, after: { ...data, state } });
    return { record_id: rows[0].rec.id, state };
  });
}

async function doTransition(c: Caller, b: any) {
  if (typeof b.record_id !== "string" || typeof b.step !== "string") refuse("Say which record and which step.");
  if (b.note !== undefined && String(b.note).length > 1000) refuse("The note is longer than 1000 characters.");
  const { data: seen } = await c.db.from("records").select("id, tool_id, version_id, entity, state").eq("id", b.record_id).maybeSingle();
  if (!seen) refuse("Record not found.");
  const [v] = await sql`select spec, status from public.tool_versions where id = ${seen.version_id}`;
  if (v.status !== "published") refuse("This record's tool version is not live.");
  const spec = v.spec;
  if (!spec.workflow || spec.workflow.entity !== seen.entity) refuse("This record has no workflow.");
  const ctx = await ruleContext(c, spec);
  return await sql.begin(async (tx: any) => {
    const [row] = await tx`select id, data, state, subject_member_id from public.records where id = ${seen.id} for update`; // concurrent transitions queue here
    const nb = await tx`select id, data, state, subject_member_id from public.records where version_id = ${seen.version_id} and entity = ${seen.entity}`;
    const asRec = (x: any) => ({ id: x.id, state: x.state, requester: x.subject_member_id, ...x.data });
    const rec = asRec(row);
    const r = transition(spec, { [seen.entity]: nb.map(asRec) }, rec, b.step, { role: c.role, id: c.member_id, staff: c.staff }, b.note, ctx);
    if (!r.ok) refuse(r.error, r.findings);
    const history = [...(row.data._history || []), { at: new Date().toISOString(), by: c.role, action: b.step, from: r.from, to: r.to, note: b.note || "" }];
    await tx`update public.records set state = ${r.to}, data = ${tx.json({ ...row.data, _history: history })} where id = ${row.id} and state = ${r.from}`;
    for (const n of r.notices) {
      const to = n.to === "requester" ? { subject: row.subject_member_id, audience: [] } : { subject: null, audience: [n.to] };
      await tx`insert into public.records (org_id, tool_id, version_id, entity, subject_member_id, audience, data, created_by)
        values (${c.org.id}, ${seen.tool_id}, ${seen.version_id}, '_notice', ${to.subject}, ${to.audience}, ${tx.json({ text: n.text, record_id: row.id })}, ${c.uid})`;
    }
    await audit(tx, c, "transition", seen.tool_id, { record_id: row.id, step: b.step, before: { state: r.from }, after: { state: r.to }, note: b.note || "" });
    return { record_id: row.id, from: r.from, to: r.to, notices: r.notices.length };
  });
}

async function doSetRole(c: Caller, b: any) {
  if (c.role !== "admin") refuse("Only an admin can change roles.");
  const email = String(b.email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) refuse("That is not a valid email address.");
  const domain = email.split("@")[1] || "";
  const [d] = await sql`select org_id from public.org_domains where domain = ${domain}`;
  if (!d || d.org_id !== c.org.id) refuse("That email is not in your organisation's domains.");
  if (typeof b.role !== "string" || !c.org.roles.includes(b.role)) refuse(`"${b.role}" is not one of this organisation's roles: ${c.org.roles.join(", ")}.`);
  if (email === c.email && b.role !== "admin") refuse("You cannot remove your own admin role.");
  return await sql.begin(async (tx: any) => {
    const [before] = await tx`select role from public.memberships where org_id = ${c.org.id} and email = ${email}`;
    await tx`insert into public.memberships (org_id, email, role, added_by) values (${c.org.id}, ${email}, ${b.role}, ${c.uid})
      on conflict (org_id, email) do update set role = excluded.role, added_by = excluded.added_by, added_at = now()`;
    await audit(tx, c, "set_role", null, { email, before: before?.role || c.org.default_role, after: b.role });
    return { email, role: b.role };
  });
}

function draftPrompt(c: Caller, desc: string) {
  return `You design tools for a university administration system. An administrator described a tool they need. Turn it into a tool spec (JSON). Only these parts exist; anything else is rejected.
{"id":"lowercase_id","name":"Short name","description":"one sentence",
 "inputs":[{"id":"...","kind":"form","entity":"<Entity>","role":"<role>","label":"...","fields":["<field>",...]}],
 "entities":{"<Entity>":{"label":"...","fields":{"<field>":{"type":"text|longtext|number|date|time|enum|ref","label":"...","options":[...] (enum only),"table":"Rooms" (ref only)}}}},
 "rules":[ each one of:
   {"id","label","kind":"required","entity","fields":[...]}
   {"id","label","kind":"compare","entity","field","op":">|>=|<|<=|=|!=","value":<v> OR "valueField":"<field>"}
   {"id","label","kind":"lookup","entity","field","table":"Rooms","tableKey":"room","check":{"field","op","tableField"} (optional)}
   {"id","label","kind":"unique","entity","fields":[...],"distinct":"<field>" (optional)}
   {"id","label","kind":"consistent","entity","key":"<field>","field":"<field>"}
   {"id","label","kind":"no_overlap","entity","match":"<field>","against":{"entity":"<same entity>","where":{"state":"<state>"}}}  (entity needs date, start, end; times HH:MM, dates YYYY-MM-DD)
   {"id","label","kind":"no_overlap","entity","match","range":{"from":"<date field>","to":"<date field>"},"against":{"entity":"<same entity>","where":{"state":"<state>"}}} ],
 "workflow":{"entity","states":[...],"initial":"...","transitions":[{"action","label","from","to","role":"<role>","checkRules":true|false,"needsNote":true|false}]},
 "outputs":[{"id","kind":"queue|personal_list|notice","entity","audience":"requester|<role>|everyone","on":["<state>"] (notice only),"label"}],
 "access":{"<Entity>":{"view":{"<role>":"own|all|none","everyone":"all|none"},"hide":{"<role>":["<field>",...]}}},
 "safety":{"approver":"admin","blockOn":"one sentence"},
 "unsupported":[{"asked":"...","why":"...","proposal":"..."}],
 "examples":{"valid":{<one realistic record that passes every rule>}}}
Roles in this organisation: ${c.org.roles.join(", ")}. Staff roles (${c.org.staff_roles.join(", ")}) see everything. "own" = records that person submitted. Every entity needs an access entry; deny by default. Every role that acts in the workflow must be able to view.
Reference tables: Rooms(room, capacity) with rooms ${TABLES.Rooms.rows.map(r => r.room).join(", ")}.
Design rules: use only the parts above. Anything the description asks for that these parts cannot do goes in "unsupported", honestly. Least access. Put every check asked for into "rules". Any approval step has "checkRules": true. A rejection needs a note. Include a notice output to the requester for decisions. Keep it small.
Reply with only the JSON object.
Administrator's description:
"""${desc}"""`;
}
async function doDraftTool(c: Caller, b: any) {
  if (!c.staff) refuse("Only staff can draft tools.");
  const key = Deno.env.get("OPENAI_API_KEY"); if (!key) refuse("Drafting is not set up yet (no AI key on the server).");
  const desc = String(b.description || "").trim(); if (desc.length < 20) refuse("Describe the tool in a sentence or two.");
  const ask = async (msgs: any[]) => {
    const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini", response_format: { type: "json_object" }, temperature: 0, messages: msgs }) });
    if (!r.ok) refuse(`The AI service returned ${r.status}.`);
    const j = await r.json(); try { return JSON.parse(j.choices[0].message.content); } catch { refuse("The AI reply was not valid JSON."); }
  };
  const msgs: any[] = [{ role: "user", content: draftPrompt(c, desc.slice(0, 4000)) }];
  let spec = await ask(msgs), errs = validateSpec(spec, env(c));
  if (errs.length) { msgs.push({ role: "assistant", content: JSON.stringify(spec) }, { role: "user", content: `Fix these problems and reply with the full corrected JSON only:\n- ${errs.join("\n- ")}` }); spec = await ask(msgs); errs = validateSpec(spec, env(c)); }
  if (errs.length) refuse("The drafted spec still has problems.", errs);
  const slug = spec.id.replace(/_/g, "-");
  if (!SLUG.test(slug)) refuse("The drafted tool id is not usable.");
  return await sql.begin(async (tx: any) => {
    let [tool] = await tx`select id from public.tools where org_id = ${c.org.id} and slug = ${slug} for update`;
    if (tool) { const [last] = await tx`select spec from public.tool_versions where tool_id = ${tool.id} order by version desc limit 1`;
      if (last && ((last.spec.inputs || []).some((i: any) => i.kind === "file") || last.spec.id !== spec.id)) refuse(`A tool called "${slug}" already exists. Describe the new tool with a different name.`); }
    if (!tool) [tool] = await tx`insert into public.tools (org_id, slug, name, kind, created_by) values (${c.org.id}, ${slug}, ${spec.name}, 'information', ${c.uid}) returning id`;
    const [{ n }] = await tx`select coalesce(max(version), 0) + 1 as n from public.tool_versions where tool_id = ${tool.id}`;
    const tests = runGeneratedTests(spec, { tables: TABLES, tools: {}, today: new Date().toISOString().slice(0, 10) });
    const checks = { ok: tests.every((t: any) => t.pass), issues: tests.filter((t: any) => !t.pass).length, tests };
    const [v] = await tx`insert into public.tool_versions (tool_id, version, spec, status) values (${tool.id}, ${n}, ${tx.json(spec)}, 'draft') returning id, version`;
    await tx`insert into public.tool_version_admin (version_id, org_id, checks, source) values (${v.id}, ${c.org.id}, ${tx.json(checks)}, ${tx.json({ drafted_from: desc })})`;
    await audit(tx, c, "draft_tool", tool.id, { version: v.version, version_id: v.id, description: desc });
    return { tool_id: tool.id, version_id: v.id, version: v.version, spec, checks };
  });
}

const ACTIONS: Record<string, (c: Caller, b: any) => Promise<unknown>> = { import: doImport, publish: doPublish, submit: doSubmit, transition: doTransition, set_role: doSetRole, draft_tool: doDraftTool };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, reason: "POST only." }, 405);
  let body: any = {}, caller: Caller | null = null;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY) refuse("The request is too large.");
    try { body = JSON.parse(raw); } catch { refuse("The request body is not JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) { body = {}; refuse("The request body must be a JSON object."); }
    caller = await identify(req);
    if (!own(ACTIONS, body.action)) refuse(`Unknown action "${String(body.action).slice(0, 40)}".`);
    const fn = ACTIONS[body.action];
    return json({ ok: true, result: await fn(caller, body) });
  } catch (err) {
    const known = err instanceof Refusal || (err as any)?.name === "Refusal";
    const busy = /too many clients|remaining connection slots|timeout/i.test(String((err as Error)?.message || ""));
    const reason = known ? (err as Error).message : busy ? "The system is busy. Wait a few seconds and try again." : "The change could not be saved.";
    const detail = known ? (err as Refusal).detail ?? null : { error: String((err as Error)?.message || err).slice(0, 500) };
    try { // separate statement, after the failed transaction has rolled back; never touches records
      await sql`insert into public.refusals (org_id, actor, action, reason, detail) values (${caller?.org?.id ?? null}, ${caller?.uid ?? null}, ${String(body?.action || "unknown").slice(0, 40)}, ${reason}, ${sql.json(detail)})`;
    } catch (_) { /* logging must never mask the refusal */ }
    return json({ ok: false, reason, detail: known ? detail : null }, known ? 403 : busy ? 503 : 500);
  }
});
