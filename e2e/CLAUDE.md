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
  The gate therefore exercises the deployed artifact, and `next dev`'s
  server→browser log forwarding can't trip the error guard. `next start` is not a
  supported runner for `output: "standalone"`. Costs ~2 min of build; don't
  "speed it up" by reverting to dev.
- **Production Host hardening stays active in smoke.** The managed server receives
  `NOVA_ALLOW_LOCALHOST_HOSTS=1`; `proxy.ts` honors it only for loopback Host spellings,
  so the production artifact remains reachable at `localhost:3000` without making an
  arbitrary external Host trusted. Cloud Run must never receive this variable.
- **The `test` fixture is a strict error guard.** Every page test fails on a browser
  `console.error` / `pageerror` / same-origin 5xx (`e2e/lib/fixtures.ts`, no benign-error
  allowlist). To provoke an error on purpose, scope a local handler in that test.
- **Auth is a forged cookie, not real OAuth.** `e2e/seed.ts` writes the `auth_user`
  + `auth_session` rows into the local **Postgres** (auth and app state both live
  there); `lib/auth/sessionCookie.ts` signs the cookie exactly like
  `better-call`, and `e2e/lib/session.ts` wraps it into Playwright `storageState`.
  (Local driving OUTSIDE this suite doesn't need any of that — `GET /api/dev/login`
  is the one-URL sign-in.) Its validity is pinned by
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
- **React profiling is a separate development harness.** `npm run profile:react`
  uses `e2e/react-profile/`, a dedicated `nova_react_profile` database, the same
  no-LLM seed, one headed Chromium page, and an authenticated loopback-only
  React DevTools daemon. It deliberately does NOT reuse this suite's production
  web server: React's component profiler hook must install before development
  React initializes. Never add the profiler to the smoke config, run the
  upstream package initializer, or leave its daemon alive after the browser.
- **The cross-Project move journey needs only a destination.** `seed.ts` mints a
  second Project the seeded user OWNS (`Smoke Destination`, at a fixed slug so a
  re-run replaces it instead of piling up) — owning both ends is what satisfies
  the move's both-Projects capability + source-owner-retention rules — plus one
  throwaway "Move Me" app per Playwright attempt (`MOVE_APP_COUNT`), since a moved
  app is gone from the source Project and a retry needs its own, exactly like the
  delete test. The test proves arrival WITHOUT switching the active Project (that
  writes to the SHARED seeded session every later test reads): it reopens the
  moved app in the builder, which authorizes through the app's CURRENT Project, so
  an app stranded anywhere this user doesn't belong would 404 there. A test that
  must change the active Project has to switch back to `Personal` before finishing.
- **The case-changes journey gets one complete universe per attempt.** It
  reorders and extends the blueprint, then submits real changes into saved case
  rows, so a retry cannot reuse the prior attempt's app. `seed.ts` materializes
  one app + lookup + case row per possible attempt
  (`CASE_CHANGES_FIXTURE_COUNT`), and the spec selects
  `seed.caseChanges[testInfo.retry]`. Keep that attempt-indexed contract when
  extending the journey.
- **The organization journey also gets one app per attempt.** It authors levels
  through blueprint mutations and places through the app-scoped organization
  store; assigns a persona; authors fixed and reverse case owners; exercises
  archive, conflict recovery, viewer access, focus, and responsive layout; and
  keeps the whole run free of browser errors. `ORGANIZATION_FIXTURE_COUNT`,
  `seed.organizationAppIds[testInfo.retry]`, and the matching
  `seed.organizationCaseChangeRoutes[testInfo.retry]` keep a retry away from a
  partially authored hierarchy and route every owner edit back to that attempt's
  exact app.
- **The after-submit journey gets one app and one case row per attempt.** It
  authors a link into the blueprint and submits the form twice into its one
  patient row (`e2e/lib/formLinksSeed.ts`: the link's condition reads back the
  property the form writes, so one submission proves the otherwise path and the
  next proves the link, the post-submission read, and the carried case).
  `FORM_LINKS_FIXTURE_COUNT` + `seed.formLinks[testInfo.retry]` keep a retry off
  a row the prior attempt already wrote. The condition editor is CodeMirror:
  drive it as one `.cm-content[contenteditable="true"]` surface (select-all,
  type, `ControlOrMeta+Enter` saves), never as a textbox.
- **The search-first journey gets one app and one seeded row per attempt.**
  `e2e/lib/searchFirstSeed.ts` is a search-first Patients module (a required
  name prompt with its own message, a hidden `now()` prompt, one case-loading
  menu form) plus a no-matches registration form whose name field defaults to
  `#search/patient_name`. The journey asserts the Search canvas setting and the
  tree marker, then in Preview: Search first with no Results or register
  action, the blank-search refusal, rows for a matching name, **Search again**,
  the "No cases match" notice with the register action, the form prefilled from
  the search, Submit landing on Results showing only the new case, and the
  direct-URL refusal with **Go to Search**. It registers a case, so
  `SEARCH_FIRST_FIXTURE_COUNT` + `seed.searchFirst[testInfo.retry]`. Results
  rows are the `Cases` list's items; a running question's textbox is named
  "Question N. Label", so match it by suffix.
- **Chat sends are stubbed at the network layer.** The chat-scroll tests answer
  `POST /api/chat` from `page.route` with a canned UI-message SSE stream
  (`stubChatSends` in `authed.spec.ts`, chunk shapes pinned by
  `transportContract.integration.test.ts`), so a send exercises the real
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
    carries a POPULATED, fixed-uuid blueprint installed via
    `appendSyntheticBatch` over `createApp`'s canonical sequence-1 starter, so
    both users deep-link straight to any entity.
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

- **The deep-link journey owns an app and two cases per attempt.**
  `DEEP_LINKS_FIXTURE_COUNT` and `seed.deepLinks[testInfo.retry]` isolate authored
  entry points across retries. The dedicated fixture reuses the after-submit
  blueprint shape but has independent rows: an alphabetically first distractor
  and the selected patient. `deep-links.spec.ts` runs in the `authed` project,
  authors an entry point, changes its external ID without changing its UUID URL,
  reloads, launches the exact real case into the target form, and removes the
  point with route recovery. No endpoint, case read, or Preview launch is stubbed.
