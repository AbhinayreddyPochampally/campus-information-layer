// Shared logic for the engine function: generic spec engine + seating adapter. No AI, no tool-specific code
// except the source adapters. Same rules as live-build/engine.js, with the access model narrowed to what
// the database enforces (own / roles / everyone / none) and roles taken from the organisation's own list.
export const FIELD_TYPES = ["text", "longtext", "number", "date", "time", "enum", "ref"];
export const RULE_KINDS = ["required", "compare", "lookup", "unique", "consistent", "no_overlap"];
const INPUT_KINDS = ["form", "file"];
const ADAPTERS = ["seating"];
const OUTPUT_KINDS = ["queue", "personal_list", "notice", "schedule"];
const DEFAULT_ROLES = ["admin", "rep", "student"];
const SCOPES = ["all", "own", "none"]; // the only scopes the database can enforce

const isBlank = v => v === undefined || v === null || String(v).trim() === "";
const toMinE = t => { const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : NaN; };
const dayIdxOfE = iso => (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7;
function cmpVals(a, op, b) {
  const na = Number(a), nb = Number(b);
  const num = a !== "" && b !== "" && !isNaN(na) && !isNaN(nb) && !/:|-/.test(String(a));
  const x = num ? na : String(a), y = num ? nb : String(b);
  return op === ">" ? x > y : op === ">=" ? x >= y : op === "<" ? x < y : op === "<=" ? x <= y : op === "=" ? x == y : op === "!=" ? x != y : false;
}
function fill(tpl, rec) { return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (rec && rec[k] !== undefined ? rec[k] : "")); }
const label = (spec, entity, f) => (((spec.entities[entity] || {}).fields || {})[f] || {}).label || f;

// ---------- spec validation ----------
// env: { tables: {name:{fields,rows}}, tools: {slug:{entities:[...]}}, roles: [...org roles] }
export function validateSpec(spec, env) {
  const errs = [];
  const e = (m) => errs.push(m);
  if (!spec || typeof spec !== "object") return ["The spec is not an object."];
  const ROLES = env.roles || DEFAULT_ROLES;
  const VIEWERS = [...ROLES, "everyone"];
  const AUDIENCES = ["requester", ...VIEWERS];
  if (!spec.id || !/^[a-z][a-z0-9_]{1,40}$/.test(spec.id)) e("id must be lowercase letters, digits or _ (for example room_booking).");
  if (!spec.name) e("name is missing.");
  const ents = spec.entities || {};
  if (!Object.keys(ents).length) e("At least one entity is needed.");
  const hasField = (en, f) => !!(ents[en] && ents[en].fields && ents[en].fields[f]);
  Object.entries(ents).forEach(([en, def]) => {
    if (!def.fields || !Object.keys(def.fields).length) e(`Entity ${en} has no fields.`);
    Object.entries(def.fields || {}).forEach(([f, fd]) => {
      if (!FIELD_TYPES.includes(fd.type)) e(`${en}.${f}: unknown type "${fd.type}". Use one of ${FIELD_TYPES.join(", ")}.`);
      if (fd.type === "enum" && !(Array.isArray(fd.options) && fd.options.length)) e(`${en}.${f}: enum needs options.`);
      if (fd.type === "ref" && !(env.tables[fd.table])) e(`${en}.${f}: table "${fd.table}" does not exist. Available: ${Object.keys(env.tables).join(", ")}.`);
    });
  });
  (spec.inputs || []).forEach(inp => {
    if (!INPUT_KINDS.includes(inp.kind)) e(`Input ${inp.id}: unknown kind "${inp.kind}".`);
    if (!ROLES.includes(inp.role)) e(`Input ${inp.id}: role "${inp.role}" is not one of ${ROLES.join(", ")}.`);
    if (inp.kind === "form") {
      if (!ents[inp.entity]) e(`Input ${inp.id}: entity "${inp.entity}" does not exist.`);
      (inp.fields || []).forEach(f => { if (!hasField(inp.entity, f)) e(`Input ${inp.id}: field "${f}" is not on ${inp.entity}.`); });
      if (!(inp.fields || []).length) e(`Input ${inp.id}: list the fields the form collects.`);
    }
    if (inp.kind === "file" && !ADAPTERS.includes(inp.adapter)) e(`Input ${inp.id}: adapter "${inp.adapter}" does not exist. Available: ${ADAPTERS.join(", ")}.`);
  });
  if (!(spec.inputs || []).length) e("At least one input is needed.");
  const ruleIds = new Set();
  (spec.rules || []).forEach(r => {
    if (!r.id) e("A rule has no id."); else if (ruleIds.has(r.id)) e(`Rule id "${r.id}" is used twice.`); ruleIds.add(r.id);
    if (!RULE_KINDS.includes(r.kind)) { e(`Rule ${r.id}: unknown kind "${r.kind}". Use one of ${RULE_KINDS.join(", ")}.`); return; }
    if (!ents[r.entity]) { e(`Rule ${r.id}: entity "${r.entity}" does not exist.`); return; }
    const need = f => { if (!hasField(r.entity, f)) e(`Rule ${r.id}: field "${f}" is not on ${r.entity}.`); };
    if (r.kind === "required" || r.kind === "unique") (r.fields || []).forEach(need), (!(r.fields || []).length && e(`Rule ${r.id}: list the fields.`));
    if (r.kind === "unique" && r.distinct) need(r.distinct);
    if (r.kind === "compare") { need(r.field); if (r.valueField) need(r.valueField); if (![">", ">=", "<", "<=", "=", "!="].includes(r.op)) e(`Rule ${r.id}: op "${r.op}" is not supported.`); if (r.valueField === undefined && r.value === undefined) e(`Rule ${r.id}: give value or valueField.`); }
    if (r.kind === "consistent") { need(r.key); need(r.field); }
    if (r.kind === "lookup") { need(r.field); const t = env.tables[r.table]; if (!t) e(`Rule ${r.id}: table "${r.table}" does not exist.`); else { if (!t.fields.includes(r.tableKey)) e(`Rule ${r.id}: table ${r.table} has no column "${r.tableKey}".`); if (r.check) { need(r.check.field); if (!t.fields.includes(r.check.tableField)) e(`Rule ${r.id}: table ${r.table} has no column "${r.check.tableField}".`); } } }
    if (r.kind === "no_overlap") {
      need(r.match);
      if (r.range) { need(r.range.from); need(r.range.to); if (r.against && r.against.tool) e(`Rule ${r.id}: date ranges can only be checked against the same entity.`); }
      else { ["start", "end"].forEach(need); if (!hasField(r.entity, "date") && !hasField(r.entity, "dayIdx")) e(`Rule ${r.id}: ${r.entity} needs a date field, or use "range".`); }
      const a = r.against || {};
      if (a.tool) { if (!(env.tools[a.tool] && env.tools[a.tool].entities.includes(a.entity))) e(`Rule ${r.id}: tool "${a.tool}" has no live entity "${a.entity}".`); }
      else if (!ents[a.entity]) e(`Rule ${r.id}: entity "${a.entity}" does not exist.`);
    }
  });
  const wf = spec.workflow;
  if (wf) {
    if (!ents[wf.entity]) e(`Workflow: entity "${wf.entity}" does not exist.`);
    if (!Array.isArray(wf.states) || !wf.states.includes(wf.initial)) e("Workflow: initial state must be one of its states.");
    (wf.transitions || []).forEach(t => {
      if (!(wf.states || []).includes(t.from) || !(wf.states || []).includes(t.to)) e(`Workflow action "${t.action}": from/to must be states.`);
      if (!ROLES.includes(t.role)) e(`Workflow action "${t.action}": role "${t.role}" is not one of ${ROLES.join(", ")}.`);
    });
    if (!(wf.transitions || []).length) e("Workflow: add at least one action.");
  }
  Object.entries(spec.access || {}).forEach(([en, a]) => {
    if (!ents[en]) { e(`Access: entity "${en}" does not exist.`); return; }
    Object.entries(a.view || {}).forEach(([role, sc]) => {
      if (!VIEWERS.includes(role)) e(`Access ${en}: role "${role}" is not one of ${VIEWERS.join(", ")}.`);
      if (!SCOPES.includes(sc)) e(`Access ${en}: scope "${sc}" cannot be enforced by the database. Use one of ${SCOPES.join(", ")}.`);
      if (role === "everyone" && sc === "own") e(`Access ${en}: "everyone" can only be "all" or "none".`);
    });
    Object.entries(a.hide || {}).forEach(([role, fs]) => (fs || []).forEach(f => { if (f !== "requester" && !hasField(en, f)) e(`Access ${en}: cannot hide unknown field "${f}" from ${role}.`); }));
  });
  Object.keys(ents).forEach(en => { if (!(spec.access || {})[en]) e(`Access: say who may see ${en} records. Without it only staff see them (deny by default).`); });
  if (wf) (wf.transitions || []).forEach(t => { if (accessFor(spec, wf.entity, t.role) === "none") e(`Workflow action "${t.action}": ${t.role} may act but cannot see ${wf.entity} records. Give ${t.role} view access in "access".`); });
  (spec.outputs || []).forEach(o => {
    if (!OUTPUT_KINDS.includes(o.kind)) e(`Output ${o.id}: unknown kind "${o.kind}".`);
    if (o.audience && !AUDIENCES.includes(o.audience)) e(`Output ${o.id}: audience "${o.audience}" is not one of ${AUDIENCES.join(", ")}.`);
    if (o.on && wf) o.on.forEach(st => { if (!wf.states.includes(st)) e(`Output ${o.id}: state "${st}" is not in the workflow.`); });
  });
  if ((spec.inputs || []).some(i => i.kind === "form") && !(spec.examples && spec.examples.valid)) e("Add examples.valid: one realistic record that should pass every rule (used to generate tests).");
  return errs;
}

// ---------- where a record lives in the database, from the spec's access block ----------
// own -> subject_member_id; roles with "all" -> audience; everyone:"all" -> 'everyone'.
// Fields hidden from any non-staff role go to record_private.
export function placement(spec, ent, staffRoles) {
  const view = (((spec.access || {})[ent]) || {}).view || {};
  const audience = [];
  let own = false;
  Object.entries(view).forEach(([role, sc]) => {
    if (staffRoles.includes(role)) return;
    if (sc === "own") own = true;
    if (sc === "all") audience.push(role);
  });
  const hide = (((spec.access || {})[ent]) || {}).hide || {};
  const hidden = [...new Set(Object.entries(hide).filter(([r]) => !staffRoles.includes(r)).flatMap(([, fs]) => fs || []).filter(f => f !== "requester"))];
  return { audience: audience.includes("everyone") ? ["everyone"] : audience, own, hidden };
}

// ---------- rules ----------
function overlaps(x, y) {
  const sameDay = x.date && y.date ? x.date === y.date : (x.date ? dayIdxOfE(x.date) : x.dayIdx) === (y.date ? dayIdxOfE(y.date) : y.dayIdx);
  return sameDay && toMinE(x.start) < toMinE(y.end) && toMinE(y.start) < toMinE(x.end);
}
export function evalRules(spec, records, ctx, opts = {}) {
  const out = [], acks = (opts.acks) || {};
  (spec.rules || []).forEach(r => {
    const recs = (records[r.entity] || []).filter(x => !opts.only || x.id === opts.only);
    const all = records[r.entity] || [];
    const push = (key, ids, message) => out.push({ rule: r.id, ruleLabel: r.label || r.id, key: `${r.id}|${key}`, ids, message, ackable: !!r.ackable, resolved: !!acks[`${r.id}|${key}`] });
    if (r.kind === "required") recs.forEach(x => { const miss = r.fields.filter(f => isBlank(x[f])); if (miss.length) push(x.id, [x.id], `Missing: ${miss.map(f => label(spec, r.entity, f)).join(", ")}.`); });
    if (r.kind === "compare") recs.forEach(x => { const a = x[r.field], b = r.valueField ? x[r.valueField] : r.value; if (isBlank(a) || isBlank(b)) return; if (!cmpVals(a, r.op, b)) push(x.id, [x.id], r.message ? fill(r.message, x) : `${label(spec, r.entity, r.field)} must be ${r.op} ${r.valueField ? label(spec, r.entity, r.valueField) : b} (is ${a}).`); });
    if (r.kind === "lookup") recs.forEach(x => {
      if (isBlank(x[r.field])) return;
      const row = ((ctx.tables[r.table] || {}).rows || []).find(t => String(t[r.tableKey]) === String(x[r.field]));
      if (!row) { if (!r.check) push(x.id, [x.id], `${label(spec, r.entity, r.field)} "${x[r.field]}" is not in ${r.table}.`); return; }
      if (r.check && !isBlank(x[r.check.field]) && !cmpVals(x[r.check.field], r.check.op, row[r.check.tableField])) push(x.id, [x.id], `${label(spec, r.entity, r.check.field)} ${x[r.check.field]} must be ${r.check.op} ${r.check.tableField} ${row[r.check.tableField]} for ${x[r.field]}.`);
    });
    if (r.kind === "unique") {
      const groups = {};
      all.forEach(x => { if (r.fields.some(f => isBlank(x[f]))) return; const k = r.fields.map(f => x[f]).join("|"); (groups[k] = groups[k] || []).push(x); });
      Object.entries(groups).forEach(([k, g]) => {
        if (g.length < 2) return;
        if (r.distinct && new Set(g.map(x => x[r.distinct])).size < 2) return;
        if (opts.only && !g.some(x => x.id === opts.only)) return;
        push(k, g.map(x => x.id), r.message ? fill(r.message, g[0]) : `${r.fields.map(f => `${label(spec, r.entity, f)} ${g[0][f]}`).join(", ")}: ${g.length} records.`);
      });
    }
    if (r.kind === "consistent") {
      const groups = {};
      all.forEach(x => { if (isBlank(x[r.key]) || isBlank(x[r.field])) return; (groups[x[r.key]] = groups[x[r.key]] || []).push(x); });
      Object.entries(groups).forEach(([k, g]) => {
        const vals = [...new Set(g.map(x => x[r.field]))];
        if (vals.length < 2 || (opts.only && !g.some(x => x.id === opts.only))) return;
        push(`${k}|${vals.slice().sort().join("|")}`, g.map(x => x.id), `${k} has different ${label(spec, r.entity, r.field)} in different records: ${vals.join("; ")}. One of them may be wrong.`);
      });
    }
    if (r.kind === "no_overlap") {
      const a = r.against || {};
      let pool = a.tool ? ((ctx.tools[a.tool] || {})[a.entity] || []) : (records[a.entity] || []);
      if (a.where) pool = pool.filter(y => Object.entries(a.where).every(([k, v]) => y[k] === v));
      const rangeHit = (x, y) => String(x[r.range.from]) <= String(y[r.range.to]) && String(y[r.range.from]) <= String(x[r.range.to]);
      recs.forEach(x => {
        if (isBlank(x[r.match]) || (r.range ? (isBlank(x[r.range.from]) || isBlank(x[r.range.to])) : (isBlank(x.start) || isBlank(x.end)))) return;
        const hits = pool.filter(y => y.id !== x.id && String(y[r.match]) === String(x[r.match]) && (r.range ? rangeHit(x, y) : overlaps(x, y)));
        // Messages name only the time taken, never another person's details.
        if (hits.length) push(x.id, [x.id, ...hits.map(h => h.id)], `${label(spec, r.entity, r.match)} ${x[r.match]} is already taken: ${hits.slice(0, 3).map(h => r.range ? `${h[r.range.from]} to ${h[r.range.to]}` : `${h.date || ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][h.dayIdx]} ${h.start}–${h.end}`).join("; ")}.`);
      });
    }
  });
  return out;
}

// ---------- access (deny by default) ----------
export function accessFor(spec, ent, role) { const v = (((spec.access || {})[ent] || {}).view || {})[role]; return v || (role === "admin" ? "all" : "none"); }
export function canView(spec, ent, rec, viewer) {
  if (viewer.staff) return true;
  const sc = accessFor(spec, ent, viewer.role);
  const everyone = (((spec.access || {})[ent] || {}).view || {}).everyone === "all";
  if (sc === "all" || everyone) return true;
  if (sc === "own") return !!viewer.id && rec.requester === viewer.id;
  return false;
}
export function visibleFields(spec, ent, role) { const h = ((((spec.access || {})[ent] || {}).hide || {})[role]) || []; return Object.keys(spec.entities[ent].fields).filter(f => !h.includes(f)); }

// ---------- workflow ----------
export function actionsFor(spec, rec, role) {
  const wf = spec.workflow; if (!wf) return [];
  return (wf.transitions || []).filter(t => t.from === rec.state && t.role === role);
}
export function transition(spec, store, rec, action, viewer, note, ctx) {
  const ent = (spec.workflow || {}).entity;
  if (!canView(spec, ent, rec, viewer)) return { ok: false, error: `Refused: ${viewer.role} cannot see this record.` };
  const t = actionsFor(spec, rec, viewer.role).find(x => x.action === action);
  if (!t) return { ok: false, error: `“${action}” is not allowed from ${rec.state} for ${viewer.role}.` };
  if (t.needsNote && isBlank(note)) return { ok: false, error: "Add a short reason first." };
  if (t.checkRules) {
    const blocking = evalRules(spec, store, ctx, { only: rec.id }).filter(f => !f.resolved);
    if (blocking.length) return { ok: false, error: `Refused: ${blocking[0].message}`, findings: blocking };
  }
  const notices = (spec.outputs || []).filter(o => o.kind === "notice" && (o.on || []).includes(t.to)).map(o => ({ output: o.id, to: o.audience, text: `${spec.name}: ${rec.purpose || rec.reason || rec.title || "your request"} is ${t.to}${note ? ` (${note})` : ""}.` }));
  return { ok: true, from: rec.state, to: t.to, notices };
}

// ---------- tests generated from the spec (form tools) ----------
function shiftVal(v, type, n) {
  if (n === 0) return v;
  if (type === "date" || /^\d{4}-\d{2}-\d{2}$/.test(String(v))) { const d = new Date(v + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  if (type === "time" || /^\d{1,2}:\d{2}$/.test(String(v))) { const m = Math.max(0, Math.min(1439, toMinE(v) + n * 10)); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }
  return Number(v) + n;
}
function nextDateFor(dayIdx, from) { for (let i = 0; i < 14; i++) { const d = new Date(from + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + i); const iso = d.toISOString().slice(0, 10); if (dayIdxOfE(iso) === dayIdx) return iso; } return from; }
function generateTests(spec, ctx) {
  const tests = [], v = spec.examples && spec.examples.valid;
  if (!v) return tests;
  const ent = (spec.inputs.find(i => i.kind === "form") || {}).entity;
  const base = { ...v, id: "test-valid", state: spec.workflow ? spec.workflow.initial : undefined };
  tests.push({ name: "A valid example passes every rule", record: base, expectRule: null });
  (spec.rules || []).filter(r => r.entity === ent).forEach(r => {
    const x = { ...base, id: "test-" + r.id }; let extra = [], note = "";
    if (r.kind === "required") { x[r.fields[0]] = ""; note = `${label(spec, ent, r.fields[0])} left empty`; }
    else if (r.kind === "compare") {
      const type = ((spec.entities[ent].fields || {})[r.field] || {}).type;
      const ref = r.valueField ? x[r.valueField] : r.value;
      const shift = r.op === "<=" ? 1 : r.op === ">=" ? -1 : r.op === "=" ? 1 : 0;
      x[r.field] = shiftVal(ref, type, shift);
      note = `${label(spec, ent, r.field)} set to ${x[r.field]}`;
    } else if (r.kind === "lookup") {
      const rows = (ctx.tables[r.table] || {}).rows || [];
      if (!r.check) { x[r.field] = "ZZ-999"; note = `${label(spec, ent, r.field)} set to an unknown value`; }
      else { const row = rows.find(t => String(t[r.tableKey]) === String(x[r.field])); if (!row) return; x[r.check.field] = Number(row[r.check.tableField]) + 1; note = `${label(spec, ent, r.check.field)} set above the ${r.check.tableField}`; }
    } else if (r.kind === "no_overlap") {
      const a = r.against || {};
      if (a.tool) {
        const y = ((ctx.tools[a.tool] || {})[a.entity] || []).find(p => !isBlank(p[r.match]));
        if (!y) return;
        x[r.match] = y[r.match]; x.date = y.date || nextDateFor(y.dayIdx, ctx.today); x.start = y.start; x.end = y.end;
        note = `booked on top of an existing ${a.entity}`;
      } else { extra = [{ ...base, id: "test-existing", ...(a.where || {}) }]; note = "clashes with an existing record"; }
    } else return;
    tests.push({ name: `Rule “${r.label || r.id}” catches: ${note}`, record: x, extra, expectRule: r.id });
  });
  return tests;
}
export function runGeneratedTests(spec, ctx) {
  const form = (spec.inputs || []).find(i => i.kind === "form");
  if (!form) return [];
  const ent = form.entity;
  return generateTests(spec, ctx).map(t => {
    const found = evalRules(spec, { [ent]: [t.record, ...(t.extra || [])] }, ctx, { only: t.record.id });
    const pass = t.expectRule === null ? found.length === 0 : found.some(f => f.rule === t.expectRule);
    return { name: t.name, pass, got: found.length ? found.map(f => f.rule).join(", ") : "accepted" };
  });
}

// ===================== Seating adapter (from live-build/seating.js) =====================
const MONTHS_S = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function inferSheetMeta(name, year) {
  const s = String(name).toLowerCase();
  const d = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s*([a-z]{3})/);
  const t = s.match(/(\d{1,2})[.:](\d{2})\s*to\s*(\d{1,2})[.:](\d{2})/);
  const meta = { date: "", start: "", end: "", inferred: true };
  if (d && MONTHS_S[d[2]]) meta.date = `${year}-${String(MONTHS_S[d[2]]).padStart(2, "0")}-${String(+d[1]).padStart(2, "0")}`;
  if (t) {
    let sh = +t[1], eh = +t[3];
    if (sh < 8) sh += 12; if (eh < 8 || eh < sh) eh += 12;
    meta.start = `${String(sh).padStart(2, "0")}:${t[2]}`; meta.end = `${String(eh).padStart(2, "0")}:${t[4]}`;
  }
  const g = String(name).match(/^\s*(GP\d+|[A-Z]{2,})/i);
  meta.group = g ? g[1].toUpperCase() : String(name).trim();
  return meta;
}
function splitExamCourses(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (/^1\)/.test(t)) return t.split(/\s*&\s*(?=\d\))/).map(x => x.replace(/^\d\)\s*/, "").trim()).filter(Boolean);
  return [t];
}
export function runSeating(sheets, cfg) {
  const seats = [], flags = [];
  const conf = cfg.sheets || {};
  Object.entries(sheets).forEach(([sheet, rows]) => {
    const c = conf[sheet];
    const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) && !isNaN(Date.parse(d)) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
    const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ""));
    const problem = !c ? "" : !validDate(c.date) ? "the date is not a valid YYYY-MM-DD date" : !(validTime(c.start) && validTime(c.end)) ? "start and end must be HH:MM times" : c.start >= c.end ? "the end time must be after the start" : !c.confirmed ? "it has not been confirmed for this file" : "";
    const confirmed = !!c && !problem;
    if (c && problem) flags.push({ key: `sheetbad|${sheet}`, type: "sheet", sheet, message: `Sheet "${sheet}": ${problem}.` });
    const meta = confirmed ? { ...inferSheetMeta(sheet, cfg.year || 2026), ...c, inferred: false } : { ...inferSheetMeta(sheet, cfg.year || 2026), exam: (c && c.exam) || "" };
    if (!confirmed) flags.push({ key: `sheet|${sheet}`, type: "sheet", sheet, message: `Confirm the exam, date and time for sheet "${sheet}". Read from the sheet name: ${meta.date || "no date"} ${meta.start || "?"}–${meta.end || "?"}.`, proposal: meta });
    let room = null, courses = [], header = null;
    rows.forEach((r, i) => {
      const a = String(r[0] || "").trim();
      const ROOM = /^(?:C\.?\s*R\.?|Room|Classroom)\s*[-.:#]?\s*(\d+)\b/i;
      const rm = a.match(ROOM);
      const idsIn = cells => cells.map(c => String(c || "").trim()).filter(v => /^\d{6,}$/.test(v));
      // A room label outside column A would silently put the next rows in the previous room: block it.
      if (!rm && r.slice(1).some(c => ROOM.test(String(c || "").trim()))) { flags.push({ key: `roomcol|${sheet}|${i}`, type: "layout", message: `A room label on "${sheet}" row ${i + 1} is not in column A, so the seats below it can't be placed safely.` }); return; }
      if (rm && idsIn(r.slice(2)).length) flags.push({ key: `roomids|${sheet}|${i}`, type: "layout", message: `The room header for ${rm[1]} on "${sheet}" row ${i + 1} also holds roll numbers; they were not seated.` });
      if (rm) { room = rm[1]; courses = splitExamCourses(r[1]); header = null; if (!String(r[1] || "").trim()) flags.push({ key: `room|${sheet}|${i}`, type: "layout", message: `Room ${room} on sheet "${sheet}" (row ${i + 1}) has no exam or section next to it.` }); return; }
      if (!a && r.some(c => /^COLUMN/i.test(String(c || "")))) { if (idsIn(r.slice(1)).length) flags.push({ key: `colids|${sheet}|${i}`, type: "layout", message: `The column header row on "${sheet}" row ${i + 1} also holds roll numbers; they were not seated.` }); header = r.map(c => { const m = String(c || "").match(/COLUMN\s*-?\s*(\d+)/i); return m ? +m[1] : null; }); return; }
      const rw = a.match(/^(?:Row|R)\s*[-.:#]?\s*(\d+)$/i);
      if (!rw) {
        // Never skip silently: anything in column A we don't understand, or seats with no row label, blocks publishing.
        const ids = r.slice(1).map(c => String(c || "").trim()).filter(v => /^\d{6,}$/.test(v));
        if (a && !/^COLUMN/i.test(a)) flags.push({ key: `unknown|${sheet}|${i}`, type: "layout", message: `"${a.slice(0, 40)}" in column A of "${sheet}" row ${i + 1} is not a room or row label${ids.length ? `, and that row holds ${ids.length} roll number(s)` : ""}.` });
        else if (!a && ids.length) flags.push({ key: `nolabel|${sheet}|${i}`, type: "layout", message: `Row ${i + 1} on "${sheet}" has ${ids.length} roll number(s) but no row label in column A.` });
        return;
      }
      if (rw) {
        if (!room) { flags.push({ key: `orphan|${sheet}|${i}`, type: "layout", message: `Row ${i + 1} on "${sheet}" has seats but no room above it.` }); return; }
        r.forEach((c, j) => {
          if (j === 0) return; const v = String(c || "").trim(); if (!v) return;
          if (!/^\d{9}$/.test(v)) { flags.push({ key: `roll|${sheet}|${i}|${j}`, type: "roll", message: `"${v}" at ${sheet} row ${i + 1} is not a 9-digit roll number.` }); return; }
          const col = header && header[j] ? header[j] : j;
          seats.push({ id: `${sheet}|${v}`, roll: v, sheet, group: meta.group, exam: meta.exam || "", date: meta.date, start: meta.start, end: meta.end, room, row: +rw[1], col, courses, src: `${sheet}!${String.fromCharCode(64 + j + 1)}${i + 1}` });
        });
      }
    });
  });
  const bySheet = {};
  seats.forEach(s => { const k = `${s.sheet}|${s.roll}`; (bySheet[k] = bySheet[k] || []).push(s); });
  Object.values(bySheet).filter(g => g.length > 1).forEach(g => flags.push({ key: `dup|${g[0].sheet}|${g[0].roll}`, type: "rule", rule: "one-seat-per-exam", ackable: true, message: `Roll ${g[0].roll} is seated ${g.length} times in "${g[0].sheet}": ${g.map(s => `room ${s.room} row ${s.row} col ${s.col}`).join("; ")}.`, resolved: !!(cfg.acks || {})[`dup|${g[0].sheet}|${g[0].roll}`] }));
  const seatKey = {};
  seats.forEach(s => { const k = `${s.sheet}|${s.room}|${s.row}|${s.col}`; if (seatKey[k]) flags.push({ key: `seat|${k}`, type: "rule", rule: "one-student-per-seat", message: `Two students share room ${s.room}, row ${s.row}, column ${s.col} on "${s.sheet}".` }); seatKey[k] = 1; });
  const byRoll = {};
  seats.forEach(s => (byRoll[s.roll] = byRoll[s.roll] || []).push(s));
  Object.values(byRoll).forEach(list => {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const x = list[a], y = list[b];
      if (x.sheet !== y.sheet && x.date && x.date === y.date && x.start < y.end && y.start < x.end) {
        const key = `overlap|${x.roll}|${x.sheet}|${y.sheet}`;
        flags.push({ key, type: "rule", rule: "no-double-booking", ackable: true, message: `Roll ${x.roll} has two exams at once: "${x.sheet}" and "${y.sheet}".`, resolved: !!(cfg.acks || {})[key] });
      }
    }
  });
  const issues = flags.filter(f => !f.resolved);
  return { seats, flags, issues, ok: issues.length === 0 && seats.length > 0, rooms: new Set(seats.map(s => s.sheet + "|" + s.room)).size, students: Object.keys(byRoll).length };
}

// Seating spec: what the tool is, stored with every version. A spec, not code.
export const SEATING_SPEC = {
  id: "exam_seating", name: "Exam seating", version: 1,
  description: "Read the Exam Cell's seating workbook and show every student their own seat. Invigilators see the rosters for rooms; everyone sees the Exam Cell notice.",
  inputs: [{ id: "workbook", kind: "file", adapter: "seating", role: "admin", label: "Seating workbook (.xlsx)" }],
  entities: {
    Seat: { label: "Exam seat", fields: { exam: { type: "text", label: "Exam" }, date: { type: "date", label: "Date" }, start: { type: "time", label: "Start" }, end: { type: "time", label: "End" }, room: { type: "text", label: "Room" }, row: { type: "number", label: "Row" }, col: { type: "number", label: "Column" }, courses: { type: "text", label: "Course(s)" } } },
    Roster: { label: "Room roster", fields: { exam: { type: "text", label: "Exam" }, date: { type: "date", label: "Date" }, start: { type: "time", label: "Start" }, end: { type: "time", label: "End" }, room: { type: "text", label: "Room" }, courses: { type: "text", label: "Course(s)" }, students: { type: "number", label: "Students" }, seats: { type: "longtext", label: "Seat map" } } },
    Notice: { label: "Exam Cell notice", fields: { title: { type: "text", label: "Title" }, body: { type: "longtext", label: "Notice" } } }
  },
  rules: [],
  outputs: [
    { id: "my-seats", kind: "personal_list", entity: "Seat", audience: "requester", label: "My exam seats" },
    { id: "rosters", kind: "personal_list", entity: "Roster", audience: "invigilator", label: "Room rosters" },
    { id: "notice", kind: "notice", entity: "Notice", audience: "everyone", label: "Exam Cell notice" }
  ],
  access: { Seat: { view: { student: "own", rep: "own", invigilator: "own" } }, Roster: { view: { invigilator: "all" } }, Notice: { view: { everyone: "all" } } },
  safety: { approver: "admin", blockOn: "Every unconfirmed sheet, layout problem, bad roll number or seating clash blocks publishing" }
};
