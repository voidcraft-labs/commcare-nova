# e2e — Playwright smoke suite

The pre-deploy UI gate: home loads, auth boundary is healthy, a user can open and
delete an app in the builder. See `e2e/README.md` for how to run; the rules below are
the non-obvious ones.

- **Hermetic, free, no real GCP.** The suite runs against the **Firestore emulator** +
  a local Postgres (`scripts/smoke.sh`), not a real project — same pattern as
  `npm run test:integration`. No new CI GCP project, no prod credentials, no LLM spend.
- **Auth is a forged cookie, not real OAuth.** `e2e/seed.ts` writes a session row into
  the emulator; `e2e/lib/session.ts` signs the cookie exactly like `better-call`. The
  forgery's validity is pinned by `lib/db/__tests__/sessionCookie.integration.test.ts`
  — if a better-auth/better-call bump breaks it, that test fails, not a Playwright
  timeout. Re-verify the signer after any better-auth/better-call bump.
- **Prod cookie name differs.** Local (`http`) is `better-auth.session_token`; a
  deployed (`https`) target is `__Secure-better-auth.session_token`. `sessionCookieName`
  switches on the scheme — only the credential-free `public` project runs against prod.
- **`seed.ts` refuses to run without `FIRESTORE_EMULATOR_HOST`** — a hard guard so it
  can never write a fake session into real `commcare-nova-dev` / `commcare-nova`.
- **No new RTL/jsdom tests.** UI logic is tested as `f(state)` in Vitest; real UI
  behavior is tested here in Playwright. Don't add `@testing-library/react` DOM tests.
- **Selectors are roles / aria-labels / text** (the app has almost no `data-testid`):
  `getByRole("button", { name: "Sign in with Google" })`, `aria-label="Undo"`,
  `aria-label="Delete app"`. If you add a `data-testid`, prefer it for the gate.
- **Specs live in `e2e/tests/**` only** — Vitest excludes that dir; everything else
  under `e2e/` (helpers, `seed.ts`) is plain TS and importable by Vitest.
- **This gate only blocks a deploy if it's a required PR check.** Deploy is Cloud Build
  on push-to-main; CI (incl. this) runs on PRs. Make the `smoke` job a required check in
  branch protection or it informs without gating.
