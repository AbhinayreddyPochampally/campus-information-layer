// Browser run of the new screens: admin Build a tool -> review -> publish; student Requests -> submit; office Tools queue -> approve.
import { chromium } from "playwright";
import fs from "fs";
const PW = process.env.TEST_PW, base = "https://cil.test/index.html";
const browser = await chromium.launch({ executablePath: process.env.HS, proxy: { server: process.env.HTTPS_PROXY } });
const out = "/home/claude/build/shots/build"; fs.mkdirSync(out, { recursive: true });
const errors = []; const html = fs.readFileSync("/home/claude/campus-information-layer/index.html", "utf8");
let pass = 0, fail = 0; const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  — " + x : ""}`); };
async function as(email, vp = { width: 1100, height: 900 }) {
  const ctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true });
  await ctx.route("https://cil.test/**", r => r.fulfill({ status: 200, contentType: "text/html", body: html }));
  const p = await ctx.newPage(); p.on("pageerror", e => errors.push(String(e))); p.on("console", m => m.type() === "error" && errors.push(m.text()));
  p.on("dialog", d => d.accept());
  await p.goto(base); await p.waitForSelector("#em");
  await p.evaluate(async ([e, pw]) => { const r = await sb.auth.signInWithPassword({ email: e, password: pw }); if (r.error) throw r.error; await boot(); }, [email, PW]);
  await p.waitForTimeout(2500); return p;
}
const tab = async (p, t) => { await p.click(`nav.tabs button:has-text("${t}")`); await p.waitForTimeout(800); await p.waitForFunction(() => !/Loading…/.test(document.querySelector("#view").textContent), null, { timeout: 20000 }); };
const text = async p => (await p.textContent("#view")).replace(/\s+/g, " ");

// admin: make sure alpha is a plain student for this run
let a = await as("cil.admin.259999000@iimmumbai.ac.in");
await a.evaluate(async () => engine({ action: "set_role", email: "cil.alpha.259999001@iimmumbai.ac.in", role: "student" }));
await tab(a, "Build a tool");
await a.fill("#desc", "Cil test equipment loan six. Students borrow equipment from the media lab: item (Projector, Laptop, Camera), from date, to date and purpose. The from date cannot be in the past and the to date must be on or after the from date. The office approves or rejects with a reason. Students see only their own loans.");
await a.click("#draft");
await a.waitForSelector("#pubtool, #drafted .err", { timeout: 90000 }); await a.waitForTimeout(500);
await a.screenshot({ path: `${out}/1-draft-review.png`, fullPage: true });
let t = await text(a);
ok("Review shows the form in plain words", /Forms/.test(t) && /fill in/.test(t), t.slice(0, 300));
ok("Review explains each rule in words", /must be on or after/.test(t) || /must be filled in/.test(t), t.slice(0, 600));
ok("Review shows steps and who sees what", /Steps/.test(t) && /Who sees what/.test(t) && /only their own/.test(t));
ok("Review shows generated tests passing", /passing/.test(t) && !/failing/.test(t));
await a.click("#pubtool"); await a.waitForTimeout(4000);
t = await text(a);
await a.screenshot({ path: `${out}/2-tools-after-publish.png`, fullPage: true });
ok("After publish the Tools tab shows it live", /live/.test(t) && /No submissions yet/.test(t), t.slice(0, 300));

// student: Requests
const s = await as("cil.alpha.259999001@iimmumbai.ac.in", { width: 390, height: 900 });
await tab(s, "Requests");
await s.screenshot({ path: `${out}/3-student-form.png`, fullPage: true });
const F = '.card:has(h3:has-text("Equipment")) form[data-i]'; const form = await s.$(F); ok("Student sees the new form", !!form);
const fields = await s.$$eval(`${F} [data-f]`, els => els.map(e => ({ f: e.dataset.f, tag: e.tagName, type: e.type })));
const d1 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), d2 = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
let dates = 0;
for (const x of fields) {
  const sel = `${F} [data-f="${x.f}"]`;
  if (x.tag === "SELECT") await s.selectOption(sel, { index: 1 });
  else if (x.type === "date") await s.fill(sel, dates++ ? d2 : d1);
  else if (x.type === "number") await s.fill(sel, "1");
  else if (x.type === "time") await s.fill(sel, "10:00");
  else await s.fill(sel, "UI test loan");
}
await s.click(`${F} button`); await s.waitForTimeout(1500); console.log("  toast after submit:", await s.textContent("#toast")); await s.waitForFunction(() => /My requests/.test(document.querySelector("#view").textContent), null, { timeout: 20000 });
t = await text(s);
await s.screenshot({ path: `${out}/4-student-submitted.png`, fullPage: true });
ok("Student's request appears under My requests, waiting", /My requests/.test(t) && /(pending|submitted|requested)/i.test(t), t.slice(-300));

// office: Tools queue -> approve
const o = await as("cil.office.259999004@iimmumbai.ac.in");
await tab(o, "Tools");
await o.screenshot({ path: `${out}/5-office-queue.png`, fullPage: true });
const btn = await o.$('.card:has(h3:has-text("Equipment")) button[data-step]:not([data-note="1"])');
ok("Office sees an approve button on the waiting request", !!btn);
if (btn) { await btn.click(); await o.waitForFunction(() => /approved/i.test(document.querySelector("#view").textContent), null, { timeout: 20000 }).catch(() => {}); await o.waitForTimeout(500); }
t = await text(o);
await o.screenshot({ path: `${out}/6-office-after.png`, fullPage: true });
ok("Request moves on after approval", /approved/i.test(t), t.slice(0, 400));

// student sees decision
await tab(s, "Requests"); t = await text(s);
ok("Student sees the equipment loan approved", /Equipment[^]*?approved/i.test(t), t.slice(-400));
await tab(s, "Today"); t = await text(s);
await s.screenshot({ path: `${out}/7-student-today.png`, fullPage: true });
ok("Decision notice appears on Today", /Decision/.test(t) && /approved/i.test(t), t.slice(0, 300));
console.log("errors:", errors);
ok("No page errors", errors.length === 0);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); process.exit(fail ? 1 : 0);
