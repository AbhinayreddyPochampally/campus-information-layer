# Campus Information Layer

IIM Mumbai pilot. A configurable operating layer: admins publish information once, and each person sees only what's theirs.

- `index.html`: the whole web app (Supabase sign-in by email code; student, invigilator and admin views). Deployed as a static site.
- `supabase/functions/engine/`: the `engine` edge function, the only write path (import, publish, submit, transition, set_role, draft_tool).
- `tests/live_tests.mjs`: end-to-end tests against the live project with real sign-ins (51 checks). Needs `SB_URL`, `SB_ANON` and `TEST_PW` in the environment.
- `HANDOFF.md`: current state and next steps.

The Supabase key in `index.html` is the public anon key; access is enforced by row-level security and the engine.
