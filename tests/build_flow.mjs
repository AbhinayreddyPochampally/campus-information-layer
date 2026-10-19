// Live: AI drafts a tool from plain words -> review -> publish -> student form -> submit -> staff decides -> student sees it.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const URL_ = process.env.SB_URL, ANON = process.env.SB_ANON, PW = process.env.TEST_PW;
const E = { admin: "cil.admin.259999000@iimmumbai.ac.in", A: "cil.alpha.259999001@iimmumbai.ac.in", B: "cil.beta.259999002@iimmumbai.ac.in", office: "cil.office.259999004@iimmumbai.ac.in", inv: "cil.invig.259999003@iimmumbai.ac.in" };
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  — " + x : ""}`); };
const client = () => createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const U = {}; for (const [k, e] of Object.entries(E)) { const c = client(); const { error } = await c.auth.signInWithPassword({ email: e, password: PW }); if (error) throw error; U[k] = c; }
const call = async (c, body) => { const { data: s } = await c.auth.getSession(); const t0 = Date.now(); const r = await fetch(`${URL_}/functions/v1/engine?forceFunctionRegion=ap-south-1`, { method: "POST", headers: { Authorization: `Bearer ${s.session.access_token}`, apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); j._ms = Date.now() - t0; return j; };

const DESC = process.env.DESC || "Cil test library book requests. Students request a book from the library: book title, author, and the date they need it by. The date must not be in the past. The office approves or rejects the request with a reason, and the student sees the decision. Students see only their own requests.";
let r = await call(U.A, { action: "draft_tool", description: DESC });
ok("Student cannot draft a tool", !r.ok, JSON.stringify(r).slice(0, 200));
r = await call(U.admin, { action: "draft_tool", description: DESC });
console.log(`  draft took ${r._ms} ms`);
ok("Admin drafts a tool with AI (spec validates)", r.ok, JSON.stringify(r).slice(0, 600));
if (!r.ok) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
const d = r.result; fs.writeFileSync("/tmp/claude-0/-home-claude/a489340a-c6d2-5c56-a516-dd963be33580/scratchpad/drafted.json", JSON.stringify(d, null, 2));
console.log(`  tool ${d.spec.id} v${d.version}; generated tests ${d.checks.tests.length}, failing ${d.checks.issues}`);
const form = (d.spec.inputs || []).find(i => i.kind === "form");
ok("Draft has a form for a non-staff role", !!form && ["student","rep"].includes(form.role), JSON.stringify(d.spec.inputs));
ok("Draft has an approve/reject workflow", !!d.spec.workflow && (d.spec.workflow.transitions || []).length >= 2, JSON.stringify(d.spec.workflow));
const { data: vs } = await U.A.from("tool_versions").select("id").eq("id", d.version_id);
ok("Student cannot read the draft spec", (vs || []).length === 0);
{ const sr = await call(U.admin, { action: "set_role", email: E.A, role: form.role }); ok(`Admin makes alpha a ${form.role}`, sr.ok, JSON.stringify(sr)); }
let f = await call(U.A, { action: "forms" });
if (d.version === 1) ok("Draft is not offered to students before publish", f.ok && !f.result.some(x => x.tool === d.spec.id.replace(/_/g, "-")), JSON.stringify(f).slice(0, 300));
r = await call(U.office, { action: "publish", version_id: d.version_id });
ok("Office (staff, not admin) cannot publish", !r.ok, JSON.stringify(r).slice(0, 200));
r = await call(U.admin, { action: "publish", version_id: d.version_id });
ok("Admin publishes the drafted tool", r.ok, JSON.stringify(r).slice(0, 400));
f = await call(U.A, { action: "forms" });
const mine = f.ok && f.result.find(x => x.tool === d.spec.id.replace(/_/g, "-"));
ok("Student now sees the form, fields only", !!mine && Array.isArray(mine.fields) && !("rules" in mine) && !("workflow" in mine), JSON.stringify(f).slice(0, 400));
if (!mine) process.exit(1);
// fill each field sensibly
const fill = (fl, bad) => { const data = {}; let ti = 0; for (const x of fl.fields) data[x.name] = x.options ? x.options[0] : x.type === "number" ? 5 : x.type === "date" ? (bad ? "2020-01-01" : new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)) : x.type === "time" ? ["10:00", "11:00"][Math.min(ti++, 1)] : x.type === "boolean" ? true : "Test value"; return data; };
r = await call(U.A, { action: "submit", tool: mine.tool, input: mine.input, data: fill(mine, true) });
const hasDate = mine.fields.some(x => x.type === "date");
if (hasDate) ok("Past date is refused by the drafted rule", !r.ok, JSON.stringify(r).slice(0, 300)); else console.log("  (no date field drafted; skipped past-date check)");
r = await call(U.A, { action: "submit", tool: mine.tool, input: mine.input, data: { ...fill(mine), _subject: "259999002" } });
ok("Student submits a valid request", r.ok, JSON.stringify(r).slice(0, 400));
const rec = r.result?.record_id || r.result?.id;
const { data: own } = await U.A.from("records").select("id, subject_member_id, state, tools(slug,name)").eq("tool_id", d.tool_id);
ok("Requester sees own request, subject is them (forged subject ignored)", own?.length === 1 && own[0].subject_member_id === "259999001" && !!own[0].tools?.name, JSON.stringify(own));
const { data: other } = await U.B.from("records").select("id").eq("tool_id", d.tool_id);
ok("Another student sees nothing of it", (other || []).length === 0);
const { data: invs } = await U.inv.from("records").select("id").eq("tool_id", d.tool_id);
ok("Invigilator (unrelated role) sees nothing of it", (invs || []).length === 0);
const wf = d.spec.workflow, from = own[0].state;
const steps = wf.transitions.filter(t => t.from === from);
const approve = steps.find(t => /approv/i.test(t.action + t.to)), reject = steps.find(t => /reject/i.test(t.action + t.to));
console.log(`  state "${from}"; steps: ${steps.map(t => `${t.role}:${t.action}`).join(", ")}`);
r = await call(U.A, { action: "transition", record_id: own[0].id, step: (approve || steps[0]).action });
ok("Requester cannot approve their own request", !r.ok, JSON.stringify(r).slice(0, 200));
const decider = (approve || steps[0]).role === "admin" ? U.admin : U.office;
if (reject?.needsNote) { r = await call(decider, { action: "transition", record_id: own[0].id, step: reject.action }); ok("Reject without a reason is refused", !r.ok, JSON.stringify(r).slice(0, 200)); }
r = await call(decider, { action: "transition", record_id: own[0].id, step: (approve || steps[0]).action, note: "Collect from the desk." });
ok(`Staff (${(approve || steps[0]).role}) approves`, r.ok, JSON.stringify(r).slice(0, 300));
const { data: after } = await U.A.from("records").select("state, data").eq("id", own[0].id);
ok("Student sees the decision and note", after?.[0]?.state === (approve || steps[0]).to && JSON.stringify(after[0].data._history || []).includes("Collect from the desk"), JSON.stringify(after));
ok("History records a role, not a staff email", !JSON.stringify(after?.[0]?.data || {}).includes("@"));
r = await call(decider, { action: "transition", record_id: own[0].id, step: (approve || steps[0]).action });
ok("Same step twice is refused", !r.ok);
if ((d.spec.rules || []).some(x => x.kind === "no_overlap")) {
  await call(U.admin, { action: "set_role", email: E.B, role: form.role });
  r = await call(U.B, { action: "submit", tool: mine.tool, input: mine.input, data: fill(mine) });
  ok("Another requester cannot take the same approved slot", !r.ok, JSON.stringify(r).slice(0, 300));
  if (!r.ok) console.log("  refusal shown:", r.reason);
  ok("Clash message names only the time, not who holds it", !r.ok && !/2599990|@/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 300));
}
console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync("/tmp/claude-0/-home-claude/a489340a-c6d2-5c56-a516-dd963be33580/scratchpad/flow_tool.txt", d.spec.id.replace(/_/g, "-"));
process.exit(fail ? 1 : 0);
