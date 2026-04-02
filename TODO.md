# Auth & Persistence Roadmap

## Vision

Nova is a POC deployed on Cloud Run for Dimagi employees. Right now it's BYOK (bring your own
Anthropic API key), which is a barrier for non-technical users — the exact people Nova is built for.

**The goal:** Any Dimagi employee can sign in with their Google account and start building apps
immediately, no API key needed. A single server-side Anthropic key is shared across all
authenticated users. Usage is logged, capped per user per month, and projects are persisted so
users can return to their work.

**Design principles:**
- Google OAuth is the primary entry. BYOK stays as a fallback for power users or external collaborators.
- Authenticated users share a server-side API key. The server resolves which key to use — session
  means server key, no session means BYOK from the request body.
- Firestore for all persistence (projects, logs, usage). No SQL database — Firestore is serverless,
  zero-management, and has a generous free tier. Perfect for a POC at Dimagi scale.
- Projects are the current state (fast loading). Logs are the immutable event stream (debugging,
  replay, audit). The "duplication" is a feature — projects let you skip replay.
- Spend cap is a safety net. Generous enough to not impede real work, tight enough to prevent
  runaway costs on a shared API key.

---

## Phase 1: Auth (Google OAuth via Better Auth) — DONE

All Dimagi employees have Google accounts, so Google OAuth is the natural choice. Better Auth
provides stateless JWT sessions (no database needed for auth itself) with a simple Next.js
integration. Sign-in is restricted to `@dimagi.com` emails via a server-side hook.

The landing page now has two entry paths: Google sign-in (primary, prominent) and API key input
(secondary, for BYOK). All API routes use a shared `resolveApiKey()` function that checks for an
authenticated session first (uses the server's `ANTHROPIC_API_KEY`), then falls back to a BYOK key
in the request body, and returns 401 if neither is present.

- [x] Better Auth with Google OAuth, stateless sessions, @dimagi.com domain restriction
- [x] Auth route handler, client instance, useAuth hook
- [x] Landing page with Google sign-in + BYOK fallback
- [x] All API routes (chat, models) support dual auth via resolveApiKey()
- [x] BuilderLayout redirect guard checks auth OR apiKey
- [x] Settings page shows account info + sign-out for authenticated users
- [x] Docs and env vars updated
- [x] End-to-end tested with Google OAuth
- [ ] Deploy to Cloud Run with auth env vars

## Phase 2: Firestore Foundation

Set up the Firestore connection and define the data model. This is the foundation that Phases 3-6
build on. No user-facing changes yet — just the plumbing.

**Data model:**
- `users/{email}/usage/{yyyy-mm}` — monthly spend tracking (input tokens, output tokens, cost, request count)
- `users/{email}/projects/{projectId}` — current blueprint state (name, blueprint JSON, timestamps, status)
- `users/{email}/projects/{projectId}/logs/{logId}` — immutable event stream (timestamp, type, data, model, tokens, cost)

Projects are small (one document with the serialized blueprint — fast to load). Logs are append-only
and potentially large, but as a subcollection they're only fetched when needed (replay, debug, audit).

- [x] Install Firestore client, create singleton with typed collection helpers
- [x] Define Zod schemas + derived types for User, Project, Usage documents
- [x] IAM: grant `roles/datastore.user` to Cloud Run service account
- [ ] Test connection from Cloud Run (next deploy)

Note: LogEntryDoc schema deferred to Phase 4 — will be a single consistent format, not polymorphic.

## Phase 3: Project Persistence

Users should be able to close the browser and come back to their app later. Right now, closing the
tab means starting over (unless you saved a log file and replayed it). This phase makes projects
first-class — auto-saved on generation and edits, loadable from a project list.

**What "open a project" looks like:** Read one Firestore document, hydrate the blueprint, done. No
replaying hundreds of data parts. The builder loads instantly with the current state.

- [ ] Save/load blueprints to Firestore (auto-save on generation complete + edits)
- [ ] Project list page — all your projects, sorted by last modified
- [ ] Load project on `/build/[id]` from Firestore instead of starting empty

## Phase 4: Log Migration

Currently, RunLogger writes to local `.log/` files on disk. That works for local dev but not for
Cloud Run (ephemeral filesystem). Move log storage to Firestore so logs survive deployments and
are queryable.

Each `logData()` call becomes a Firestore document write. Real-time writes are better than batching
at the end — if a generation fails midway, the partial log is still available for debugging.

- [ ] RunLogger writes to Firestore (each emission = one document in the logs subcollection)
- [ ] Replay from Firestore logs (replace file-based replay)
- [ ] Per-request cost logging (model, input/output tokens, cost) for usage tracking

## Phase 5: Usage Tracking & Spend Cap

The benefit of BYOK is that users are "on the hook" for their own costs. With a shared server key,
we need a safety net so no one accidentally runs up hundreds of dollars. Track per-user monthly
spend and enforce a cap.

**Flow:** Before each chat request, check the user's cumulative monthly spend. If over cap, return a
friendly error. After each request completes, log the actual cost. The AI SDK provides token counts,
and model pricing is already in `lib/models.ts`.

- [ ] Per-user monthly token and cost tracking in Firestore
- [ ] Pre-request spend cap check (middleware in the chat route)
- [ ] Post-request cost logging
- [ ] Friendly error message when cap reached (not a raw 429 — explain what happened and when it resets)

## Phase 6: Polish

Admin visibility and user-facing usage info. Even for a POC, it's valuable to see where spend is
going and who's using the tool.

- [ ] Admin/usage dashboard — per-user monthly spend across the org
- [ ] Per-user usage visibility in settings (how much of your cap you've used)
- [ ] Settings UI cleanup
