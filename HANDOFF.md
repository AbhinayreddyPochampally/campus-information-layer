# Live build handoff: Campus Information Layer

Read this first. The docs in `live-build/` in this Project are the source of truth. Updated 19 Oct 2026.

## Done
- **Supabase project** `campus-information-layer`, ref `didzhikknwbfklyjwumd` (ap-south-1, free plan). Schema = `02_core_with_org_config.sql` + `03_hide_helpers.sql`, unchanged. Row-level security on every table, read-only policies, helpers in `private`.
- **Engine edge function `engine` is live (v4)**, `verify_jwt` on. Source: `engine_index.ts` + `engine_lib.js` (deploy them as `index.ts` and `lib.js`).
  - Actions: `import`, `publish`, `submit`, `transition`, `set_role`, `draft_tool`.
  - The caller's identity, org and role are read with the caller's own token. Writes go through one Postgres transaction over `SUPABASE_DB_URL` (no service key in code). Each write is audited in `audit_log`. A refused call rolls back, then one row goes to `refusals` in a separate statement.
  - `transition` takes the workflow step as **`step`**, not `action`. That name clash was found and fixed in testing.
  - Access model in `validateSpec` is narrowed to what the DB enforces: scopes `own | all | none`, plus `everyone`. Roles come from the org's own list. `enrolled` is rejected until enrolment data exists.
  - Seating spec (`SEATING_SPEC` in lib): Seat → `own` (subject = roll); Roster → audience `{invigilator}`; Notice → `{everyone}`.
  - Publish gate: validateSpec, zero open issues, generated tests pass, every record has a subject or audience. Empty file imports are refused; form tools may start empty.
- **Live tests: 51/51 pass** (`live_tests.mjs`). They use real sign-ins on the live project, covering the DB access rules through the public API plus every engine-contract case: forged subject ignored, concurrent transitions leave one result, refusal leaves no record change plus one `refusals` row, other org sees nothing, non-campus domain can't sign up.
- **Web page** `web_index.html`: a single file using supabase-js.
  - Email one-time-code sign-in.
  - Student "Today" view: notices, today's exams, upcoming exams, past exams. Invigilators also see room rosters.
  - Admin view: upload .xlsx (parsed in the browser) → confirm the date and time per sheet (remembered from the last import) → Check → Publish. Plus Roles and Activity (audit + refusals).
  - Tested in Chromium as student, invigilator and admin, including a full upload → publish.

## Not done / needs Abhinay
1. **Hosting.** The Vercel connector can deploy but cannot create a project. Create an empty project once (e.g. `campus-information-layer`, no framework). Or drag `web_index.html` (renamed to `index.html`) into vercel.com/new. After that, Claude can redeploy into it.
2. **OTP email template.** Supabase → Auth → Email Templates → "Magic Link": include `{{ .Token }}` so the email carries the 6-digit code the page asks for. The built-in mailer allows only a few emails per hour. Set up custom SMTP before a test group of more than a handful.
3. **Load real seating.** Sign in as admin on the hosted page and upload the Exam Cell workbooks. Confirm GOC = 2026-10-10 10:00–12:30 (from the Exam Cell email) and publish. The mid-term sheet dates are read from sheet names. Ask the Exam Cell before sharing beyond a test group.
4. **OPENAI_API_KEY** as an edge-function secret (only `draft_tool` uses it; until then it refuses cleanly).
5. **Test-data cleanup.** Deletes need approval in the Supabase connector. Run `cleanup.sql` (removes tools `cil-test-*`, the `cil-test-other` org, 259999xxx test accounts, and their memberships, audit and refusal rows).

## Constraints (unchanged)
- Never ask for secrets in chat.
- Real data is visible only to campus sign-ins, and each student sees only their own seat.
- Ask the Exam Cell before sharing beyond a test group.
- Free plan.
- Stack frozen: Postgres, one JS engine, one HTML page. New tools are specs, not code.

## Notes
- Supabase writes: inserts, updates and deploys go through. Statements containing deletes are held for approval (that was last session's blocker).
- `?tool=<slug>` on the page points the seating screen at another tool slug. It's used only for test runs; the engine still checks every call.
