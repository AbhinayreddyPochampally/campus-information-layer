// Live tests: real sign-ins against the live project. Database access rules (read through the public API as each user)
// and engine contract cases (calls to the deployed function). Test data: cil-test-* tools, 259999xxx rolls.
import { createClient } from "@supabase/supabase-js";
const URL_ = process.env.SB_URL, ANON = process.env.SB_ANON, PW = process.env.TEST_PW;
const RUN = process.env.RUN || "1", SEAT = `cil-test-seating-${RUN}`, BOOK = process.env.BOOK || "cil-test-room-booking";
const E = { admin: "cil.admin.259999000@iimmumbai.ac.in", A: "cil.alpha.259999001@iimmumbai.ac.in", B: "cil.beta.259999002@iimmumbai.ac.in", inv: "cil.invig.259999003@iimmumbai.ac.in", X: "x@cil-test.invalid" };
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra && !cond ? "  — " + extra : ""}`); };
const client = () => createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
async function login(email) { const c = client(); const { error } = await c.auth.signInWithPassword({ email, password: PW }); if (error) throw new Error(`${email}: ${error.message}`); return c; }
const U = {}; for (const [k, e] of Object.entries(E)) U[k] = await login(e);
const anon = client();
const call = async (c, body) => { const { data: s } = await c.auth.getSession(); const r = await fetch(`${URL_}/functions/v1/engine`, { method: "POST", headers: { Authorization: `Bearer ${s.session.access_token}`, apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify(body) }); return r.json(); };
const rows = async (c, q) => { const { data, error } = await q(c.from("records")); if (error) throw error; return data; };
const refusalCount = async () => { const { count } = await U.admin.from("refusals").select("*", { count: "exact", head: true }); return count; };
const recordCount = async () => { const { count } = await U.admin.from("records").select("*", { count: "exact", head: true }); return count; };

// ---------------- sign-up / identity ----------------
const su = await client().auth.signUp({ email: "someone.cil.test@gmail.com", password: PW });
ok("Unconfigured email domain cannot sign up", !!su.error, JSON.stringify(su.data?.user?.id));
const { data: profA } = await U.A.from("profiles").select("member_id, email");
ok("Member ID read from email by the org pattern; a student sees only their own profile", profA.length === 1 && profA[0].member_id === "259999001", JSON.stringify(profA));
ok("Signed-out visitor reads nothing", (await anon.from("records").select("id")).data?.length === 0 && (await anon.from("organizations").select("id")).data?.length === 0);

// ---------------- seating: import -> checks -> publish ----------------
const sheets = {
  "GP9_20th oct_9.30 to 10.30": [["CR-305", "Test Course One"], ["", "COLUMN - 1", "COLUMN - 2"], ["Row-1", "259999001", "259999002"]],
  "GP8_20th Oct _2.30 to 3.30": [["CR- 402", "1) Test Course Two & 2) Test Course Three"], ["", "COLUMN - 1"], ["Row-1", "259999002"]],
};
let r = await call(U.A, { action: "import", tool: SEAT, adapter: "seating", sheets, cfg: { year: 2026 } });
ok("Engine: a student cannot import", !r.ok && /staff/.test(r.reason), r.reason);
r = await call(U.admin, { action: "import", tool: SEAT, adapter: "seating", sheets, cfg: { year: 2026 } });
ok("Engine: import with unconfirmed sheets reports open issues", r.ok && r.result.issues === 2 && r.result.summary.seats === 3, JSON.stringify(r).slice(0, 300));
const v0 = r.result?.version_id;
r = await call(U.admin, { action: "publish", version_id: v0 });
ok("Engine: publish gate fails closed while issues are open", !r.ok && /open issue/.test(r.reason), r.reason);
const cfg = { year: 2026, sheets: { "GP9_20th oct_9.30 to 10.30": { exam: "Mid-term (test)", date: "2026-10-20", start: "09:30", end: "10:30" }, "GP8_20th Oct _2.30 to 3.30": { exam: "Mid-term (test)", date: "2026-10-20", start: "14:30", end: "15:30" } } };
r = await call(U.admin, { action: "import", tool: SEAT, adapter: "seating", sheets, cfg, notice: { title: "Test notice", body: "Report to your allotted room only." } });
ok("Engine: import with confirmed sheets has zero issues", r.ok && r.result.issues === 0 && r.result.summary.rosters === 2 && r.result.summary.notices === 1, JSON.stringify(r).slice(0, 300));
const v1 = r.result?.version_id, seatTool = r.result?.tool_id;
const { data: oldDraft } = await U.admin.from("tool_versions").select("id").eq("id", v0);
ok("Engine: re-import replaces the previous draft", oldDraft.length === 0);
ok("Student sees nothing from a draft version", (await rows(U.A, q => q.select("id").eq("tool_id", r.result.tool_id))).length === 0);
const before = { rec: await recordCount(), ref: await refusalCount() };
r = await call(U.A, { action: "publish", version_id: v1 });
ok("Engine: a non-admin's publish is refused", !r.ok && /admin/.test(r.reason), r.reason);
ok("Engine: refused call leaves records unchanged and one row in refusals", (await recordCount()) === before.rec && (await refusalCount()) === before.ref + 1);
r = await call(U.X, { action: "publish", version_id: v1 });
ok("Engine: another organisation's caller cannot name this version", !r.ok, r.reason);
r = await call(U.admin, { action: "publish", version_id: v1 });
ok("Engine: admin publishes a clean version", r.ok && r.result.records === 6, JSON.stringify(r));
r = await call(U.admin, { action: "publish", version_id: v1 });
ok("Engine: a published version cannot be published again", !r.ok, r.reason);

// ---------------- what each person sees ----------------
const seenA = await rows(U.A, q => q.select("entity, subject_member_id, data").eq("tool_id", seatTool));
ok("Student A sees own seat + the everyone notice only", seenA.length === 2 && seenA.filter(x => x.entity === "Seat").every(x => x.subject_member_id === "259999001") && seenA.some(x => x.entity === "Notice"), JSON.stringify(seenA));
ok("Student A cannot see B's seat even by asking for it directly", (await rows(U.A, q => q.select("id").eq("subject_member_id", "259999002"))).length === 0 && (await rows(U.A, q => q.select("id").neq("subject_member_id", "259999001").eq("entity","Seat"))).length === 0);
const seenB = await rows(U.B, q => q.select("entity, data").eq("tool_id", seatTool));
ok("Student B sees both own seats (two exams) + notice", seenB.filter(x => x.entity === "Seat").length === 2 && seenB.length === 3);
const seenI = await rows(U.inv, q => q.select("entity, data").eq("tool_id", seatTool));
ok("Invigilator sees room rosters + notice, no student seats", seenI.filter(x => x.entity === "Roster").length === 2 && !seenI.some(x => x.entity === "Seat"), JSON.stringify(seenI.map(x => x.entity)));
ok("Other organisation sees nothing", (await rows(U.X, q => q.select("id"))).length === 0 && (await U.X.from("tools").select("id")).data.length === 0 && (await U.X.from("organizations").select("slug")).data.every(o => o.slug === "cil-test-other"));
ok("Student cannot read hidden fields, audit or refusals", (await U.A.from("record_private").select("*")).data.length === 0 && (await U.A.from("audit_log").select("id")).data.length === 0 && (await U.A.from("refusals").select("id")).data.length === 0);
ok("Admin sees everything in the org, including audit", (await rows(U.admin, q => q.select("id"))).length >= 6 && (await U.admin.from("audit_log").select("id")).data.length >= 3);
const { data: tvA } = await U.A.from("tool_versions").select("status, checks");
ok("Student sees only published versions", tvA.every(v => v.status === "published"));

// ---------------- direct writes from a signed-in browser ----------------
const anyRec = seenA.length ? (await rows(U.A, q => q.select("id, org_id, tool_id, version_id").limit(1)))[0] : {};
const attempts = [
  ["insert a record", c => c.from("records").insert({ org_id: anyRec.org_id, tool_id: anyRec.tool_id, version_id: anyRec.version_id, entity: "Seat", subject_member_id: "259999001", data: {} }).select()],
  ["take over B's seat", c => c.from("records").update({ subject_member_id: "259999001" }).eq("subject_member_id", "259999002").select()],
  ["edit own seat", c => c.from("records").update({ data: { room: "999" } }).eq("subject_member_id", "259999001").select()],
  ["delete records", c => c.from("records").delete().neq("entity", "x").select()],
  ["make self admin", c => c.from("memberships").insert({ org_id: anyRec.org_id, email: E.A, role: "admin" }).select()],
  ["publish a version", c => c.from("tool_versions").update({ status: "published" }).neq("status", "x").select()],
  ["erase a refusal", c => c.from("refusals").delete().neq("id", 0).select()],
];
for (const [label, fn] of attempts) { const { data, error } = await fn(U.A); ok(`Browser cannot ${label}`, !!error || !data || data.length === 0, JSON.stringify(data)); }
ok("Seats unchanged after the write attempts", (await rows(U.admin, q => q.select("data").eq("subject_member_id", "259999001").eq("entity", "Seat").eq("tool_id", seatTool)))[0]?.data?.room === "305");
for (const fn of ["is_staff", "my_role", "check_org_email"]) { const { error } = await U.A.rpc(fn); ok(`Internal helper ${fn} not callable from the browser`, !!error); }

// ---------------- roles ----------------
r = await call(U.A, { action: "set_role", email: E.A, role: "admin" });
ok("Engine: a student cannot assign roles", !r.ok, r.reason);
r = await call(U.admin, { action: "set_role", email: E.B, role: "superuser" });
ok("Engine: a role outside the org's list cannot be assigned", !r.ok && /not one of/.test(r.reason), r.reason);
r = await call(U.admin, { action: "set_role", email: E.admin, role: "student" });
ok("Engine: an admin cannot remove their own admin role", !r.ok, r.reason);
r = await call(U.admin, { action: "set_role", email: "someone@gmail.com", role: "rep" });
ok("Engine: cannot assign a role to an email outside the org's domains", !r.ok, r.reason);
r = await call(U.admin, { action: "set_role", email: E.B, role: "rep" });
ok("Engine: admin makes B a class rep", r.ok, r.reason);

// ---------------- form tool: submit -> workflow ----------------
const { data: bv } = await U.admin.from("tool_versions").select("id, tools!inner(slug)").eq("tools.slug", BOOK).eq("status", "draft");
r = await call(U.admin, { action: "publish", version_id: bv[0].id });
ok("Engine: room-booking tool publishes (generated tests pass)", r.ok, JSON.stringify(r));
const good = { purpose: "Finance club session", room: "305", date: "2026-10-22", start: "18:00", end: "19:30", attendees: 40 };
r = await call(U.A, { action: "submit", tool: BOOK, input: "request", data: { ...good, subject_member_id: "259999002", requester: "259999002" }, subject_member_id: "259999002" });
ok("Engine: student submits a request", r.ok && r.result.state === "submitted", JSON.stringify(r));
const reqId = r.result?.record_id;
const { data: mine } = await U.A.from("records").select("subject_member_id, data").eq("id", reqId);
ok("Engine: a forged subject_member_id is ignored; the caller's own ID is used", mine[0]?.subject_member_id === "259999001" && !("subject_member_id" in mine[0].data) && !("requester" in mine[0].data), JSON.stringify(mine));
r = await call(U.A, { action: "submit", tool: BOOK, input: "request", data: { ...good, attendees: 500 } });
ok("Engine: rules re-run on the server (room too small) refuse the submit", !r.ok && /capacity/.test(r.reason), r.reason);
ok("Student B (now a rep) cannot see A's request", (await rows(U.B, q => q.select("id").eq("id", reqId))).length === 0);
r = await call(U.B, { action: "transition", record_id: reqId, step: "approve" });
ok("Engine: a rep cannot approve someone else's request", !r.ok && /not found/.test(r.reason), r.reason);
r = await call(U.A, { action: "transition", record_id: reqId, step: "approve" });
ok("Engine: a student cannot approve their own request", !r.ok && /not allowed/.test(r.reason), r.reason);
r = await call(U.admin, { action: "transition", record_id: reqId, step: "reject" });
ok("Engine: rejecting needs a note", !r.ok && /reason/.test(r.reason), r.reason);
const [t1, t2] = await Promise.all([call(U.admin, { action: "transition", record_id: reqId, step: "approve" }), call(U.admin, { action: "transition", record_id: reqId, step: "reject", note: "Room needed for exams" })]);
const { data: fin } = await U.admin.from("records").select("state, data").eq("id", reqId);
ok("Engine: two transitions at once leave exactly one result", [t1, t2].filter(x => x.ok).length === 1 && fin[0].data._history.length === 1 && fin[0].state === (t1.ok ? "approved" : "rejected"), JSON.stringify([t1, t2, fin[0].state]));
const notices = await rows(U.A, q => q.select("data").eq("entity", "_notice").eq("data->>record_id", reqId));
ok("Engine: the decision notice reaches the requester only", notices.length === 1 && (await rows(U.B, q => q.select("id").eq("entity", "_notice").eq("data->>record_id", reqId))).length === 0, JSON.stringify(notices));
if (fin[0].state === "approved") {
  const b2 = { rec: await recordCount(), ref: await refusalCount() };
  r = await call(U.A, { action: "submit", tool: BOOK, input: "request", data: { ...good, start: "19:00", end: "20:00" } });
  ok("Engine: a clash with an approved booking is refused", !r.ok && /already taken/.test(r.reason) && !/Finance/.test(r.reason), r.reason);
  ok("Engine: that refusal changed no records and logged one refusal", (await recordCount()) === b2.rec && (await refusalCount()) === b2.ref + 1);
} else {
  r = await call(U.admin, { action: "transition", record_id: reqId, step: "approve" });
  ok("Engine: a rejected request cannot then be approved", !r.ok, r.reason);
}
r = await call(U.admin, { action: "draft_tool", description: "Students request a locker for the term; the office approves." });
ok("Engine: draft_tool refuses cleanly until the AI key is set", !r.ok && /AI key/.test(r.reason), r.reason);
r = await call(U.admin, { action: "set_role", email: E.B, role: "student" });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
