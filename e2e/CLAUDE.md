# e2e — Playwright smoke suite

The pre-deploy UI gate: home loads, auth boundary is healthy, a user can create the
canonical starter from scratch, open one, and delete one in the builder. See
`e2e/README.md` for how to run; the
rules below are the non-obvious ones.

The from-scratch path is the suite's only app-CREATION coverage, and it can be
because it needs no model call — it drives the real `createStarterApp` Server
Action and asserts the chat DOCKS on the returned canonical survey starter
(`docHasData`).

- **Hermetic, free, no real GCP.** The suite runs against a **local Postgres**
  (`scripts/smoke.sh`), not a real project — the same testcontainer-free local stack the
  integration tests use under `npm test`. No CI GCP project, no prod credentials, no LLM spend.
- **Runs the production build, not `next dev`.** The managed server builds the isolated
  XPath worker, runs `next build`, then Nova's `scripts/start-standalone.mjs`: it
  validates the canonical generated `server.js` and XPath worker, places public +
  static assets, overlays sharp's dlopen-only `@img`
  runtime exactly like Docker, and launches that server with signal forwarding.
  Launcher tests use real temporary assets and OS child processes, including
  signal forwarding and parent-listener cleanup.
  The gate therefore exercises the deployed artifact, and `next dev`'s
  server→browser log forwarding can't trip the error guard. `next start` is not a
  supported runner for `output: "standalone"`. Costs ~2 min of build; don't
  "speed it up" by reverting to dev.
- **Production Host hardening stays active in smoke.** The managed server receives
  `NOVA_ALLOW_LOCALHOST_HOSTS=1`; `proxy.ts` honors it only for loopback Host spellings,
  so the production artifact remains reachable at `localhost:3000` without making an
  arbitrary external Host trusted. Cloud Run must never receive this variable.
- **The `test` fixture is a strict error guard.** Every page test fails on a browser
  `console.error` / `pageerror` / same-origin 5xx or client error report
  (`e2e/lib/fixtures.ts`, no benign-error
  allowlist). To provoke an error on purpose, scope a local handler in that test.
  Await `attachErrorGuard` before navigation. The fixture closes its page before
  the final async assertion; explicit contexts assert after page close and before
  context close. Live `/api/log/error` requests provide details, and a forwarding
  beacon/fetch observer records attempts synchronously in per-page localStorage
  because Chromium can deliver teardown reports without emitting network events.
  `error-guard.spec.ts` proves native delivery and detection with a real local HTTP
  receiver across reload/close, plus origin scope and page isolation.
- **Auth is a forged cookie, not real OAuth.** `e2e/seed.ts` writes the `auth_user`
  + `auth_session` rows into the local **Postgres** (auth and app state both live
  there); `lib/auth/sessionCookie.ts` signs the cookie exactly like
  `better-call`, and `e2e/lib/session.ts` wraps it into Playwright `storageState`.
  (Local driving OUTSIDE this suite doesn't need any of that — `GET /api/dev/login`
  is the one-URL sign-in.) Its validity is pinned by
  `lib/db/__tests__/sessionCookie.postgres.test.ts` — a better-auth/better-call
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
- **React profiling is a separate development harness.** `npm run profile:react`
  uses `e2e/react-profile/`, a dedicated `nova_react_profile` database, the same
  no-LLM seed, one headed Chromium page, and an authenticated loopback-only
  React DevTools daemon. With no arguments it runs only `builder-smoke.spec.ts`;
  explicit Playwright arguments select other scenarios. Exports have unique test
  identities, every export is analyzed, and measurements remain diagnostic rather
  than CI latency budgets. CPU sessions and active React recordings are closed by
  test teardown, including when an interaction assertion fails. Native Playwright
  discovery allocates an independent large app per scenario, repeat and retry;
  a field rename in one profile cannot change another profile's starting state. It deliberately
  does NOT reuse this suite's production
  web server: React's component profiler hook must install before development
  React initializes. Never add the profiler to the smoke config, run the
  upstream package initializer, or leave its daemon alive after the browser.
- **Every authenticated test declares one typed `@seed:` profile.** Native
  Playwright discovery runs before any database writes. The public reporter captures
  each selected test's exact id, repeat index and retry budget; `seed.ts` allocates
  only those attempts. `appFixtures.ts` resolves that exact identity and provides
  its storage state. Each attempt owns its accounts, sessions, Projects, apps,
  case rows, lookup tables and memberships. `seedFor(scenario, profile)` checks the
  declared profile and returns its typed data. Missing or conflicting profiles fail
  before seeding; no test relies on another test restoring shared data.
- **Local browser contexts also own their network identity.** The fixture and
  `createSmokeContext` send a unique IPv6 /64 through the existing two-hop
  forwarding contract, only for the managed loopback server. Better Auth keeps
  its production limiter enabled; without a trusted IP, the installed version
  pools all callers in one per-path bucket. Explicit collaborator contexts use
  `createSmokeContext` with their base URL. A native regression exhausts one
  client and proves another client can still read its session.
- **Profiles include their own prerequisites.** App-list and delete journeys need
  another active app or destination Project for the UI they assert. Organization,
  case changes, after-submit, search-first, localization and deep-link journeys
  each own the full authored fixture. A journey may switch its active Project or
  change a member's role without affecting another scenario. Viewer contexts use
  that attempt's separate viewer cookie.
- **Browser component tests own local peers and contexts.** `e2e/tests/browser/`
  runs in Chromium against ephemeral component peers, using production CSS and the
  emitted XPath worker. It starts no Nova server or Postgres. Only immutable build
  artifacts are reused. Raw `page.keyboard` input has no locator auto-wait:
  establish that its starting control has rendered before the first key, since
  document load can precede React's first commit. `e2e/tests/app/` runs real
  public/authenticated journeys against the production standalone server and one
  fresh database per job.
- **Chat sends are stubbed at the network layer.** The chat-scroll tests answer
  `POST /api/chat` from `page.route` with a canned UI-message SSE stream
  (`stubChatSends` in `authed.spec.ts`, chunk shapes pinned by
  `transportContract.postgres.test.ts`), so a send exercises the real
  composer → `useChat` → transport path without the request ever reaching the
  server — the smoke stays model-free even for tests that hit Send. The
  fixture app for these tests ("Smoke — Scroll") seeds a paused askQuestions
  round exactly as a finished run persists one: turn upsert (marks live) +
  response append carrying the `input-available` tool part (retires the
  marker), so opening it never attempts a stream resume.
- **Selectors are roles / aria-labels / text** (the app has almost no `data-testid`) —
  e.g. `getByRole("button", { name: "Sign in with Google" })`. If you add a
  `data-testid`, prefer it for the gate.
- **Acceptance specs live in `e2e/tests/**`; profiler specs live in
  `e2e/react-profile/**`.** Vitest excludes both Playwright-only directories;
  everything else under `e2e/` (helpers, `seed.ts`) is plain TS and importable
  by Vitest.
- **Case-workspace visual QA has one canonical fixture.** `e2e/lib/caseWorkspaceSeed.ts`
  owns a fixed-entity-id patient Search / Results / Details blueprint plus eight stable
  displayed rows. `seed.ts` installs it through `appendSyntheticBatch`, materializes
  its case schema, inserts the rows through the tenant-bound case store, and writes the
  minted app/case ids + canonical routes under `.caseWorkspace` in `seed.json`
  for manual exploration. Automated `@seed:workspace` tests resolve their own typed scenario by
  Playwright identity, repeat and retry. Each
  gets a distinct Project, app, case rows and lookup tables; restoring a gesture
  inside one test is an assertion, not an isolation mechanism.
  `npm run case:manual` is the opt-in, forged-session, open-ended browser harness; its
  Playwright project is registered only under `CASE_WORKSPACE_MANUAL=1`, so CI cannot
  enter the forever-wait.
- **The `multiplayer` project drives FOUR seeded users per scenario** in two blocks:
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
    revocation test guards both pages through teardown. Expected revocation and
    404 presence responses do not emit application errors. Teardown settles every
    page's guard and closes every context even when one reports a failure.
  - **Human-viewable modes** ride the same stack + seed: `npm run mp:watch` runs
    this suite headed with windows CDP-tiled (`MP_TILE=1` → `e2e/lib/windowTiling.ts`,
    best-effort so it can't fail a run) — halves for the two-user block, screen
    QUADRANTS for the four-user block — with `MP_SLOWMO` (default 3000 ms)
    between actions and a CSS page zoom fitting each tile; `npm run mp:manual`
    opens the open-ended FOUR-user quadrant session (`tests/manual/mp-manual.spec.ts`,
    no error guard, waits until every window closes) — its project registers
    ONLY under `MP_MANUAL=1` so a bare/CI `playwright test` can't hit the
    forever-wait. `SMOKE_REUSE_BUILD=1` skips the production rebuild on an
    unchanged-code relaunch (never set it in CI).
  - The seed writes a shared `auth_organization` + two `auth_member` rows through
    Better Auth's own adapter (a direct create bypasses the invitation
    domain-gate, which fires only on the invitation API path), and the shared app
    carries a POPULATED, fixed-uuid blueprint installed via
    `appendSyntheticBatch` over `createApp`'s canonical sequence-1 starter, so
    both users deep-link straight to any entity.
  - Every discovered scenario, repeat and retry owns a distinct app and Project.
    Its four peers share only that scenario's state. Native assertions may rely
    on the authored fixture values because no earlier test can edit them.
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

CI runs separate browser and app lanes, with their job and worker counts in
`config/smoke-execution.json`. Workers control machine load; isolation does not
rely on a one-worker limit. `scripts/ci/smoke-matrix.mjs` allocates four or six jobs
proportionally to measured lane costs, with at least one job per lane. Each lane
uses `SMOKE_PARTITION` to select a balanced native test list, then verifies that
Playwright selected exactly those logical identities before seeding. Native
repeat expansion remains authoritative. `e2e/smoke-timings.json` affects placement
only; new tests receive a conservative estimate and are included automatically.
Each artifact includes first-attempt timings and runner resource observations.
CI fails on flaky results even when a diagnostic retry passes. Manual workflow
inputs support the four/six-job, one/two-worker benchmark without editing tests.
Read `docs/testing.md` for boundary selection and asynchronous ownership.

Clear TipTap content with native Select All and Backspace, then observe the empty
draft before saving. `fill("")` selects only the DOM range; ProseMirror's delayed
focus selection can replace it before Playwright sends Delete. Native input
elements can still use `fill`.

CI installs only Chromium headless shell (`playwright install --with-deps
--only-shell chromium`), the browser its headless public/authed projects use.
A future channel override or headed CI project must update that installation
contract. Local headed and profiling workflows still need full Chromium.

For whole-pixel layout contracts, round browser geometry before comparing it
with an integer pixel boundary: a 44px target can be reported as 43.999969px
after transforms. Keep exact fractional comparisons only when the fraction
itself is the behavior being tested.

`reconciler-lifetime.spec.ts` changes its own scenario viewer's role while
away from the Builder, returns with native Back navigation, and verifies the
visible title is read-only. It restores the exact prior membership role in
`finally`. This proves permission refresh on return; it does not claim the
current no-store Builder document was retained in BFCache.

Automated multiplayer scenarios use native Playwright discovery identities to
allocate separate Projects, apps, users and sessions for every repeat and retry.
Manual multiplayer retains its single shared fixture. Contexts are owned as soon
as they are created, partial parallel openings are joined, and membership
restoration errors fail teardown.

For animation-interruption checks, control the browser animation clock and observe
the rendered result. Require settlement before the uninterrupted animation would
finish; a fixed number of real animation frames is not a React/Motion commit barrier.

Replace CodeMirror drafts with native Select All, Backspace, and keyboard input,
observing the empty editor between deletion and typing. For syntax-refusal cases,
use an incomplete expression such as `1 +`: inserting `(` can legitimately wrap
the selected expression or insert its closing partner through auto-bracketing.
