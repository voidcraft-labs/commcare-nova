# Playwright smoke suite

The final gate before a prod deploy: prove the deployed app **loads, authenticates,
and lets a user click through the core builder flows**. Every prod outage we've
shipped was at the auth/dependency boundary (the Node 22.23 undici regression, the
firebase-admin node-fetch keep-alive bug) — invisible to Sentry, catchable only by a
real request. This suite is that request.

## What it covers

| Project    | Auth                    | Checks |
|------------|-------------------------|--------|
| `public`   | none                    | home page renders the Google sign-in button; `GET /api/auth/get-session` is 200 (not 500); `POST /api/auth/sign-in/social` returns a Google URL |
| `authed`   | seeded session cookie   | app list renders, opens an app in the builder; `/build/new` renders; `get-session` returns the seeded user; delete an app through the UI |

The `authed` "create → builder → delete" loop spends **no LLM money**: apps are minted
by the real `lib/db/apps.ts::createApp` (a pure Firestore write, status `complete`),
not the chat agent.

## Two layers — and what each one can't catch

This smoke is hermetic (Firestore **emulator**), which is its strength and its blind
spot: the emulator talks plain HTTP to localhost and skips the Google token fetch +
metadata server — i.e. it **stubs out the exact outbound network layer that took prod
login down** (the undici / node-fetch regressions, #143 / #145). So the smoke catches
UI / route / render / session-contract breaks, but **not** the auth-dependency outages.

Those are caught by a separate CI job, **`auth-healthz`** (the required `Auth Firestore
healthz` check), which runs two probes over the real outbound HTTP stack on the
prod-pinned Node, authenticated via keyless Workload Identity Federation to a
**dedicated, isolated `commcare-nova-ci` project** whose Firestore holds nothing but
throwaway healthz docs (the CI identity has access to that project and nothing else):

1. **`scripts/ci/auth-healthz.ts`** mints a `google-auth-library` access token — the
   login path's credential stack now that auth runs on the Cloud SQL connector (no
   database involved).
2. **`scripts/ci/firestore-healthz.ts`** does a REAL `firebase-admin` → Firestore
   round-trip — the app-data path (apps / threads / runs / credits / usage / media stay
   on Firestore).

If a dependency or Node bump regresses that stack, a probe throws and the PR goes red —
before merge, before deploy. That's the faithful gate for the breakages we keep shipping.

## How auth works (no Google account needed)

CI has no `@dimagi.com` Workspace account and sign-in is domain-gated, so the suite
does **not** drive real Google OAuth for the everyday gate. Instead `e2e/seed.ts`
writes a session row straight into the local Postgres (auth state lives in Postgres now) and `e2e/lib/session.ts`
forges the cookie Better Auth would have set — signed exactly like `better-call`'s
`signCookieValue` (HMAC-SHA256 of the token, keyed by `BETTER_AUTH_SECRET`). The
contract that this forgery stays valid is pinned by
`lib/db/__tests__/sessionCookie.integration.test.ts`, which runs the forged cookie
through the real adapter stack and fails loudly if a dependency bump breaks it.

## Run it locally

Requires **Docker** and a **JDK** (the Firestore emulator).

```bash
npx playwright install chromium   # one-time
npm run test:smoke                # full suite (public + authed)
npm run test:smoke -- --project=public   # just the credential-free checks
npm run test:smoke:headed         # watch it run
npx playwright show-report e2e/playwright-report
```

`scripts/smoke.sh` boots local Postgres (compose) + migrations, starts the Firestore
emulator, seeds, then runs Playwright (which builds + starts the production server,
`next build && next start`). It uses a throwaway `BETTER_AUTH_SECRET` and dummy OAuth
creds — never production secrets.

## Run against a live deployment (post-deploy prod probe)

The credential-free `public` checks run against any URL — the cheapest thing that
catches an auth outage on a real environment:

```bash
SMOKE_BASE_URL=https://commcare.app npm run test:smoke:url
```

No emulator, no server, no seeding — it just probes what's already running. Note the
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
(`google-auth-library` → `gaxios`, used by the Cloud SQL connector that backs auth
now, and by Firestore before the cutover). `GET /api/auth/get-session` is one of those requests — so running the `public`
probe **against real prod after deploy** (`npm run test:smoke:url`) would have caught
both outages with no account involved. A real-SSO test's token exchange uses that same
stack, so it would catch nothing the prod `get-session` probe doesn't.

## Visual regression (not enabled)

`toHaveScreenshot()` baselines are platform-specific and must be generated from the CI
container, not a dev Mac, or they false-fail constantly. Left as a follow-up: generate
baselines in CI with `npm run test:smoke -- --update-snapshots`, commit them, then add
the assertions.
