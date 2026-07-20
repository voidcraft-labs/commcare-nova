# Playwright smoke suite

The final gate before a prod deploy: prove the deployed app **loads, authenticates,
and lets a user click through the core builder flows**. Every prod outage we've
shipped was at the auth/dependency boundary (e.g. the Node 22.23 undici regression) —
invisible to Sentry, catchable only by a real request. This suite is that request.

## What it covers

| Project    | Auth                    | Checks |
|------------|-------------------------|--------|
| `public`   | none                    | home page renders the Google sign-in button; `GET /api/auth/get-session` is 200 (not 500); `POST /api/auth/sign-in/social` returns a Google URL |
| `authed`   | seeded session cookie   | app list renders, opens an app in the builder; `/build/new` renders; `get-session` returns the seeded user; delete an app through the UI |

The `authed` "create → builder → delete" loop spends **no LLM money**: apps are minted
by the real `lib/db/apps.ts::createApp` (a pure Postgres write, status `complete`),
not the chat agent.

## Two layers — and what each one can't catch

This smoke is hermetic (local **Postgres**), which is its strength and its blind
spot: the local stack talks to localhost and never does the Google token fetch +
metadata server — i.e. it **doesn't exercise the outbound network layer that took prod
login down** (the undici / node-fetch regressions, #143 / #145). So the smoke catches
UI / route / render / session-contract breaks, but **not** the auth-dependency outages.

Those are caught by a separate CI job, **`auth-healthz`** (the required `Auth Firestore
healthz` check — the name is pinned by the branch ruleset even though the job no longer
touches Firestore), which runs one probe over the real outbound HTTP stack on the
prod-pinned Node, authenticated via keyless Workload Identity Federation to a
**dedicated, isolated `commcare-nova-ci` project** (the CI identity has access to that
project and nothing else): **`scripts/ci/auth-healthz.ts`** mints a `google-auth-library`
access token — the login path's credential stack now that auth runs on the Cloud SQL
connector (no database involved).

If a dependency or Node bump regresses that stack, the probe throws and the PR goes red —
before merge, before deploy. That's the faithful gate for the breakages we keep shipping.

## How auth works (no Google account needed)

CI has no `@dimagi.com` Workspace account and sign-in is domain-gated, so the suite
does **not** drive real Google OAuth for the everyday gate. Instead `e2e/seed.ts`
writes a session row straight into the local Postgres (auth and app state both live
there) and `e2e/lib/session.ts`
wraps it in the cookie Better Auth would have set — signed by
`lib/auth/sessionCookie.ts` exactly like `better-call`'s `signCookieValue`
(HMAC-SHA256 of the token, keyed by `BETTER_AUTH_SECRET`). The
contract that this forgery stays valid is pinned by
`lib/db/__tests__/sessionCookie.integration.test.ts`, which runs the forged cookie
through the real adapter stack and fails loudly if a dependency bump breaks it.

Everyday local sessions (agents, curl, manual browsing) don't need the suite or the
seed at all: visit `GET http://localhost:3000/api/dev/login` and you're signed in —
same signer, dev-only route.

## Run it locally

Requires **Docker** (the local Postgres).

```bash
npx playwright install chromium   # one-time
npm run test:smoke                # full suite (public + authed)
npm run test:smoke -- --project=public   # just the credential-free checks
npm run test:smoke:headed         # watch it run
npx playwright show-report e2e/playwright-report
```

`scripts/smoke.sh` boots local Postgres (compose) + migrations, seeds, then runs
Playwright (which builds + starts the production server, `next build && next start`).
It uses a throwaway `BETTER_AUTH_SECRET` and dummy OAuth creds — never production
secrets.

## Review the case workspace by hand

`seed.ts` also installs a stable patient workspace specifically for Search / Results /
Details visual QA: five Results fields, two Details-only fields, four search inputs,
and eight realistic patient rows written through the real schema materializer and
case store. It authors only Nova's canonical standard names (`case_name` and
`external_id`), never the legacy CCHQ aliases.

```bash
npm run case:manual
```

That command opens Results in a headed Chromium session using the same forged local
session cookie as the smoke suite—no Google account or OAuth flow. Search, Results,
Details, and the first live case-record URL are printed in the terminal; close the
window (or Ctrl-C) to finish. It serves on `localhost:3100`, so the normal dev server
can keep running on `localhost:3000`. The exact app, module, column, search-input, and
case ids plus all four routes are also emitted after every run:

```bash
jq '.caseWorkspace' e2e/.auth/seed.json
```

As with the multiplayer manual harness, an unchanged production build can be reused
with `SMOKE_REUSE_BUILD=1 npm run case:manual`.

## See multiplayer in action (tiled windows, live)

Both modes ride the same hermetic stack and seed as the smoke suite — no real GCP,
no Google accounts (Ada, Grace, Katherine, and Alan are forged-cookie sessions in
one shared Project):

```bash
npm run mp:watch     # WATCH the acceptance suite run itself, 3 s between actions:
                     # the two-user matrix runs in side-by-side halves, then the
                     # FOUR-user co-editing storm runs in screen QUADRANTS — a
                     # four-writer disjoint storm, same-slot convergence, crowd
                     # undo isolation, and an offline member catching up on a
                     # three-writer burst. MP_SLOWMO=1000 npm run mp:watch → snappier.
                     # Each page zooms (CSS) to fit its tile, so the whole desktop
                     # layout stays visible even on a 13" screen.

npm run mp:manual    # DRIVE all four members yourself: Ada (owner, top-left),
                     # Grace (top-right), Katherine (bottom-left), Alan
                     # (bottom-right) logged into the same shared app, one screen
                     # quadrant each, alive until you close every window (or
                     # Ctrl-C). Edits, presence, follow, undo — all live over the
                     # real SSE stream.
```

Each launch pays the production build (~2 min). Relaunching with **unchanged code**
can skip it: `SMOKE_REUSE_BUILD=1 npm run mp:manual` serves the existing `.next`
(`next start` fails loudly if there's no production build to reuse). Window tiling
is Chromium-on-a-real-display niceness — headless or non-Chromium runs just skip it.

## Run against a live deployment (post-deploy prod probe)

The credential-free `public` checks run against any URL — the cheapest thing that
catches an auth outage on a real environment:

```bash
SMOKE_BASE_URL=https://commcare.app npm run test:smoke:url
```

No local stack, no server, no seeding — it just probes what's already running. Note the
session cookie name differs in prod (`__Secure-better-auth.session_token`); the public
checks don't use cookies, so this isn't a concern for them.

## Why there's no real-Google-login test (and why you don't need one)

The suite covers the whole login flow except authenticating *on Google's own page*:
the home page renders the sign-in button, clicking it correctly hands off to
`accounts.google.com` (`public.spec.ts`), and an authenticated session drives the
builder (`authed.spec.ts`). The one untested step — Google's consent screen + the
OAuth callback — would need a Google Workspace test account, which we deliberately do
**not** require.

That's a sound trade because every auth outage we've shipped was a **dependency-boundary
500**, not a Google-side problem: the undici / node-fetch regressions made *every*
`/api/auth/*` request 500 — they share the same outbound credential stack
(`google-auth-library` → `gaxios`, used by the Cloud SQL connector that backs auth).
`GET /api/auth/get-session` is one of those requests — so running the `public`
probe **against real prod after deploy** (`npm run test:smoke:url`) would have caught
both outages with no account involved. A real-SSO test's token exchange uses that same
stack, so it would catch nothing the prod `get-session` probe doesn't.

## Visual regression (not enabled)

`toHaveScreenshot()` baselines are platform-specific and must be generated from the CI
container, not a dev Mac, or they false-fail constantly. Left as a follow-up: generate
baselines in CI with `npm run test:smoke -- --update-snapshots`, commit them, then add
the assertions.
