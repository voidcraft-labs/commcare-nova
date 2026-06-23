# e2e — Playwright smoke suite

The pre-deploy UI gate: home loads, auth boundary is healthy, a user can open and
delete an app in the builder. See `e2e/README.md` for how to run; the rules below are
the non-obvious ones.

- **Hermetic, free, no real GCP.** The suite runs against the **Firestore emulator** +
  a local Postgres (`scripts/smoke.sh`), not a real project — same pattern as
  `npm run test:integration`. No new CI GCP project, no prod credentials, no LLM spend.
- **Runs the production build, not `next dev`.** The managed server is `next build &&
  next start` — the gate exercises the deployed artifact, and `next dev`'s server→browser
  log forwarding can't trip the error guard. Costs ~2 min of build; don't "speed it up"
  by reverting to dev.
- **The `test` fixture is a strict error guard.** Every page test fails on a browser
  `console.error` / `pageerror` / same-origin 5xx (`e2e/lib/fixtures.ts`, no benign-error
  allowlist). To provoke an error on purpose, scope a local handler in that test.
- **Auth is a forged cookie, not real OAuth.** `e2e/seed.ts` writes a session row;
  `e2e/lib/session.ts` signs the cookie exactly like `better-call`. Its validity is
  pinned by `lib/db/__tests__/sessionCookie.integration.test.ts` — a better-auth/
  better-call bump that breaks it fails *there*, not as a Playwright timeout, so
  re-verify the signer after such a bump.
- **Prod cookie name differs.** Local (`http`) is `better-auth.session_token`; a
  deployed (`https`) target is `__Secure-better-auth.session_token`. `sessionCookieName`
  switches on the scheme — only the credential-free `public` project runs against prod.
- **`seed.ts` refuses to run without `FIRESTORE_EMULATOR_HOST`** — a hard guard so it
  can never write a fake session into real `commcare-nova-dev` / `commcare-nova`.
- **No new RTL/jsdom tests.** UI logic is tested as `f(state)` in Vitest; real UI
  behavior is tested here in Playwright. Don't add `@testing-library/react` DOM tests.
- **Selectors are roles / aria-labels / text** (the app has almost no `data-testid`) —
  e.g. `getByRole("button", { name: "Sign in with Google" })`. If you add a
  `data-testid`, prefer it for the gate.
- **Specs live in `e2e/tests/**` only** — Vitest excludes that dir; everything else
  under `e2e/` (helpers, `seed.ts`) is plain TS and importable by Vitest.
- **Gating needs required checks.** Deploy is Cloud Build on push-to-main; CI (incl.
  this) runs on PRs, so the `smoke` / `auth-healthz` / `auth-contract` jobs only gate as
  required checks in the branch ruleset (they are) — otherwise they inform without blocking.
