# e2e — Playwright smoke suite

The pre-deploy UI gate: home loads, auth boundary is healthy, a user can create a blank
app, open one, and delete one in the builder. See `e2e/README.md` for how to run; the
rules below are the non-obvious ones.

The blank-app path is the suite's only app-CREATION coverage, and it can be because it
needs no model call — it drives the real `createBlankApp` Server Action and asserts the
chat DOCKS, which only happens once the new app has a module (`docHasData`).

- **Hermetic, free, no real GCP.** The suite runs against a **local Postgres**
  (`scripts/smoke.sh`), not a real project — the same testcontainer-free local stack the
  integration tests use under `npm test`. No CI GCP project, no prod credentials, no LLM spend.
- **Runs the production build, not `next dev`.** The managed server is `next build &&
  next start` — the gate exercises the deployed artifact, and `next dev`'s server→browser
  log forwarding can't trip the error guard. Costs ~2 min of build; don't "speed it up"
  by reverting to dev.
- **The `test` fixture is a strict error guard.** Every page test fails on a browser
  `console.error` / `pageerror` / same-origin 5xx (`e2e/lib/fixtures.ts`, no benign-error
  allowlist). To provoke an error on purpose, scope a local handler in that test.
- **Auth is a forged cookie, not real OAuth.** `e2e/seed.ts` writes the `auth_user`
  + `auth_session` rows into the local **Postgres** (auth and app state both live
  there); `e2e/lib/session.ts` signs the cookie exactly like
  `better-call`. Its validity is pinned by
  `lib/db/__tests__/sessionCookie.integration.test.ts` — a better-auth/better-call
  bump that breaks it fails *there*, not as a Playwright timeout, so re-verify the
  signer after such a bump.
- **Prod cookie name differs.** Local (`http`) is `better-auth.session_token`; a
  deployed (`https`) target is `__Secure-better-auth.session_token`. `sessionCookieName`
  switches on the scheme — only the credential-free `public` project runs against prod.
- **`seed.ts` refuses to run without `NOVA_DB_LOCAL_URL`** — the one hard guard that
  keeps its auth AND app-state writes on the local Postgres, never the real Cloud SQL
  instance.
- **No new RTL/jsdom tests.** UI logic is tested as `f(state)` in Vitest; real UI
  behavior is tested here in Playwright. Don't add `@testing-library/react` DOM tests.
- **Selectors are roles / aria-labels / text** (the app has almost no `data-testid`) —
  e.g. `getByRole("button", { name: "Sign in with Google" })`. If you add a
  `data-testid`, prefer it for the gate.
- **Specs live in `e2e/tests/**` only** — Vitest excludes that dir; everything else
  under `e2e/` (helpers, `seed.ts`) is plain TS and importable by Vitest.
- **Case-workspace visual QA has one canonical fixture.** `e2e/lib/caseWorkspaceSeed.ts`
  owns a fixed-entity-id patient Search / Results / Details blueprint plus eight stable
  displayed rows. `seed.ts` installs it through `appendSyntheticBatch`, materializes
  its case schema, inserts the rows through the tenant-bound case store, and writes the
  minted app/case ids + canonical routes under `.caseWorkspace` in `seed.json`.
  `npm run case:manual` is the opt-in, forged-session, open-ended browser harness; its
  Playwright project is registered only under `CASE_WORKSPACE_MANUAL=1`, so CI cannot
  enter the forever-wait.
- **The `multiplayer` project drives FOUR seeded users** in two blocks:
  the two-user matrix (the mechanism) and a four-user co-editing storm (the
  crowd-scale proof — simultaneous four-writer disjoint storm, same-slot
  contention convergence, crowd undo isolation, offline catch-up on a
  three-writer burst). `multiplayer.spec.ts` opens members of one shared
  Project (Ada `owner`; Grace, Katherine, Alan `editor` — seeded by
  `e2e/lib/multiplayerSeed.ts` into a two-module, four-field app; user ids are
  chosen so all four hash to DISTINCT palette hues, and two carry avatar
  photos), each in its OWN `browser.newContext({ storageState })`. The
  two-user block drives eight scenarios over the real SSE stream + guarded
  writer + reconciler:
  bidirectional presence + live co-edit; disjoint-edit merge (no clobber);
  presence marker + live-highlight; follow-a-peer; offline→reconnect catch-up
  (`context.setOffline`); reorder merge (Field-actions → Move Down); undo
  isolation (a local undo reverts only the actor's own edit — the peer's
  disjoint edit stays, because the remote frame folds through the undo stacks
  via `rebaseHistory`); and membership-removal revocation (a direct `auth_member`
  DELETE → the stream revokes + the roster drops the peer). Each captures a screenshot to
  `e2e/multiplayer-screenshots/` (git-ignored) so the UI/UX is eyeballable.
  Non-obvious rules:
  - The project has NO project-level `storageState` (the spec opens its own two
    contexts) and applies the strict error guard per-page via `attachErrorGuard`
    (`e2e/lib/errorGuard.ts`) — the single-`page` fixture can't cover two users. The
    revocation test does NOT guard Grace's page (a revoked stream + 404 presence
    POSTs are the expected consequence of losing access).
  - **Human-viewable modes** ride the same stack + seed: `npm run mp:watch` runs
    this suite headed with windows CDP-tiled (`MP_TILE=1` → `e2e/lib/windowTiling.ts`,
    best-effort so it can't fail a run) — halves for the two-user block, screen
    QUADRANTS for the four-user block — with `MP_SLOWMO` (default 3000 ms)
    between actions and a CSS page zoom fitting each tile; `npm run mp:manual`
    opens the open-ended FOUR-user quadrant session (`tests/mp-manual.spec.ts`,
    no error guard, waits until every window closes) — its project registers
    ONLY under `MP_MANUAL=1` so a bare/CI `playwright test` can't hit the
    forever-wait. `SMOKE_REUSE_BUILD=1` skips the production rebuild on an
    unchanged-code relaunch (never set it in CI).
  - The seed writes a shared `auth_organization` + two `auth_member` rows through
    Better Auth's own adapter (a direct create bypasses the invitation
    domain-gate, which fires only on the invitation API path), and the shared app
    carries a POPULATED, fixed-uuid blueprint installed via `appendSyntheticBatch`
    (`createApp` only mints an empty doc) so both users deep-link straight to any entity.
  - The suite shares ONE seeded app and mutates it cumulatively, so each test
    asserts the CHANGE it makes (a unique marker), never a seed starting value a
    prior test may have already edited.
  - Co-edit targets: the module/form-name `EditableTitle` (`<input>`,
    `data-testid="editable-title"` — its unfocused value tracks the entity name,
    so a peer's input reflects a rename the instant the reconciler folds the
    frame) and the field-id inspector input (`[data-field-id="id"] input`).
    Reorder rides the `Field actions` menu's `Move Up`/`Move Down` items (drag on
    a virtualized list is too fragile for E2E). Presence/follow ride the roster's
    `Follow {name}` avatar button; following waits for the peer's new location to
    propagate first (presence is eventually-consistent — the heartbeat is
    debounced + relayed, so following mid-move would land on the stale location).
- **Gating needs required checks.** Deploy is Cloud Build on push-to-main; CI (incl.
  this) runs on PRs, so the `smoke` / `auth-healthz` / `auth-contract` jobs only gate as
  required checks in the branch ruleset (they are) — otherwise they inform without blocking.
