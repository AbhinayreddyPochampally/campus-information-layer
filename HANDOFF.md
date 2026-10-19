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

## Hosting (done 19 Oct)
- Live at **https://campus-information-layer.vercel.app**. GitHub repo `AbhinayreddyPochampally/campus-information-layer` is linked to Vercel, so every push to `main` deploys. The Claude GitHub App has push access; the Vercel connector is read-only.
- Supabase Site URL = the Vercel URL.
- Sign-in uses the **emailed link** (Supabase's default template). Email templates can't be edited without custom SMTP. The code box stays as a fallback for when SMTP + `{{ .Token }}` templates are set up.

## Still needs Abhinay
1. **Custom SMTP** (e.g. Resend) before a test group. The built-in mailer sends only a few emails per hour.
2. **Load real seating.** Sign in as admin on the live site, upload the Exam Cell workbooks, confirm GOC = 2026-10-10 10:00–12:30, publish. Ask the Exam Cell before sharing beyond a test group.
3. **OPENAI_API_KEY** as an edge-function secret (for `draft_tool` only).
4. **Test-data cleanup.** Run `tests/cleanup.sql` (deletes need approval in the Supabase connector).


## Security and sanity layer (19 Oct, after the independent audit)
- **Leak fixed:** tool versions are staff-only (RLS). Check results and import source live in the staff-only `tool_version_admin` table.
- **Monitor:** `private.run_sanity()` runs hourly via pg_cron (`cil-sanity-hourly`) and writes `health_checks`, shown in Activity → System checks. It checks RLS on every table, browser read-only, every live record placed, no roll numbers in group-visible records, valid member IDs, one live version per tool, valid role emails, and refusal spikes.
- **Engine v5:**
  - own-property dispatch; JSON-object body; 6 MB cap; sheet shape limits;
  - typed form fields; 20 submits/hour per student; strict emails;
  - slug lock; race-safe publish; publish blocked if a group-visible record has a roll number.
- **Seating reader:** reads C.R./Room/Classroom and R-N/Row.N; flags every unrecognised column-A cell and unlabeled roll rows; each sheet needs explicit confirmation per file.
- **Region:** the page calls the engine with `?forceFunctionRegion=ap-south-1` (Mumbai, next to the DB): ~1 s instead of 5–10 s.
- **Verification:** 14/14 fix probes pass, and the live suite passes 50/50.
- **Pending owner approval** (Supabase prompts are being cancelled before they reach Abhinay):
  1. Revoke browser INSERT/UPDATE/DELETE/TRUNCATE grants and the column SELECT on `tool_versions.checks/source`. RLS already blocks these; this is the backstop. SQL is in `supabase/migrations/04_guards_and_sanity.sql`.
  2. Test-data cleanup (`tests/cleanup.sql`, plus `cil-audit-%` tools).
  3. `OPENAI_API_KEY`: add it in Supabase → Edge Functions → Secrets. The key pasted in chat should be rotated.
- **Known gap:** every invigilator sees every room's roster; limiting this needs room-assignment data.
- **Vision vs path:** the free tiers and the frozen stack are economics and sequencing, not vision. See the project document.

## Constraints (unchanged)
- Never ask for secrets in chat.
- Real data is visible only to campus sign-ins, and each student sees only their own seat.
- Ask the Exam Cell before sharing beyond a test group.
- Free plan.
- Stack frozen: Postgres, one JS engine, one HTML page. New tools are specs, not code.

## Notes
- Supabase writes: inserts, updates and deploys go through. Statements containing deletes are held for approval (that was last session's blocker).
- `?tool=<slug>` on the page points the seating screen at another tool slug. It's used only for test runs; the engine still checks every call.
