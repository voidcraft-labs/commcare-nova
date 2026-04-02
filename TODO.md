# Auth & Persistence Roadmap

Tracking progress for the `auth-and-persistence` branch.
Each phase leaves the app fully functional — safe to deploy after any phase boundary.

## Phase 1: Auth (Google OAuth via Better Auth)
- [x] Create branch `auth-and-persistence`
- [x] Install `better-auth`
- [x] `lib/auth.ts` — server instance (Google OAuth, stateless, @dimagi.com domain restriction)
- [x] `lib/auth-client.ts` — client instance
- [x] `app/api/auth/[...all]/route.ts` — catch-all route handler
- [x] `lib/auth-utils.ts` — shared `resolveApiKey()` for dual auth mode
- [x] Landing page — Google sign-in (primary) + BYOK input (fallback)
- [x] `app/api/chat/route.ts` — dual auth: session → server key, body → BYOK
- [x] `lib/schemas/apiSchemas.ts` — make `apiKey` optional
- [x] `app/api/models/route.ts` — support server key for authenticated users
- [x] `hooks/useAuth.ts` — thin wrapper around Better Auth's `useSession`
- [x] `components/builder/BuilderLayout.tsx` — redirect guard checks auth OR apiKey
- [x] `app/settings/page.tsx` — user info + sign-out, API key becomes optional override
- [x] `components/settings/StageCard.tsx` — `hasModelAccess` prop replaces `apiKey` guard
- [x] `.env.example` — document new env vars
- [x] `CLAUDE.md` — document auth architecture
- [ ] Test end-to-end with Google OAuth credentials
- [ ] Deploy to Cloud Run with env vars

## Phase 2: Firestore Foundation
- [ ] Install `@google-cloud/firestore`
- [ ] `lib/db/firestore.ts` — client singleton, typed collection helpers
- [ ] `lib/db/types.ts` — Firestore document types (User, Project, LogEntry, Usage)
- [ ] Test connection from Cloud Run

## Phase 3: Project Persistence
- [ ] `lib/db/projects.ts` — save/load blueprints to Firestore
- [ ] `app/builds/page.tsx` — project list page
- [ ] Auto-save blueprint on generation complete + edits
- [ ] Load project on `/build/[id]` from Firestore

## Phase 4: Log Migration
- [ ] `lib/db/logs.ts` — write log entries to Firestore
- [ ] Update `RunLogger` to write to Firestore (in addition to or instead of files)
- [ ] Replay from Firestore logs

## Phase 5: Usage Tracking & Spend Cap
- [ ] `lib/db/usage.ts` — per-user monthly token/cost tracking
- [ ] Middleware: check spend cap before each chat request
- [ ] Log actual cost after completion
- [ ] Friendly error when cap reached

## Phase 6: Polish
- [ ] Admin/usage dashboard page
- [ ] Settings UI cleanup
- [ ] Per-user usage visibility
