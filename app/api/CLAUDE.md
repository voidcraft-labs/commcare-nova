# API Routes

## Error Handling

`lib/apiError.ts` — `ApiError` class with `status` and `details` fields + `handleApiError()` utility. Routes throw `ApiError` at the point of failure; a single `handleApiError` call in the catch block produces the response. Also exports `parseApiErrorMessage()` — extracts the `error` field from JSON error response bodies (used by BuilderLayout to parse `useChat` error messages into human-readable toast text).

## Auth Route (`auth/[...all]/route.ts`)

Better Auth catch-all handler — serves all `/api/auth/*` paths (OAuth flows, session management, sign-in/sign-out). Uses `toNextJsHandler(auth)` from `better-auth/next-js`.

## POST /api/chat (`chat/route.ts`)

The single endpoint for all agent interaction. Creates `EventLogger`, `GenerationContext`, `MutableBlueprint`, then `createSolutionsArchitect()`.

**API key resolution**: Uses `resolveApiKey()` from `lib/auth-utils.ts` — requires an authenticated session and uses server-side `ANTHROPIC_API_KEY`. Returns 401 if not authenticated.

**Spend cap check**: After API key resolution, the user's monthly spend is checked via `getMonthlyUsage()`. If `cost_estimate >= MONTHLY_SPEND_CAP_USD`, returns `{ error, type: 'spend_cap_exceeded' }` with 429 status. Fails closed on Firestore errors — returns 503 rather than allowing uncapped spend.

**Input validation**: `chatRequestSchema` (from `lib/schemas/apiSchemas.ts`) validates our fields (`blueprint`, etc.) via Zod `safeParse`. `messages` is typed as `UIMessage[]` from the AI SDK — not schema-validated.

**Body params** (from `useChat` body): `blueprint` (for edits), `runId` (for log continuation), `projectId` (for updating the same Firestore project on subsequent requests).

**Streaming**: Uses `createUIMessageStream` with a manual reader loop (not `writer.merge()`) so stream errors can be caught and emitted as `data-error` before the stream closes. Both catch blocks (`route:init` and `route:stream`) delegate to a local `handleRouteError(error, source)` closure that classifies the error, emits `data-error` to the client via `ctx.emitError()`, and marks the project as failed via `failProject()` (fire-and-forget). Server emits transient data parts via `ctx.emit()` which drive builder state on the client.

**Project creation**: New builds create a Firestore project doc (`status: 'generating'`) before generation starts — fails closed (returns 503) to prevent unsaveable ghost generations.

**Usage flush**: `logger.finalize()` is awaited in the execute `finally` block (primary path), with `onFinish` and `req.signal.abort` as idempotent safety nets. The `_finalized` guard ensures exactly one `incrementUsage` Firestore write per request. Single attempt, no retries — consistent with all other Firestore writes. If the write fails, the next request's pre-flight `getMonthlyUsage()` read will also fail (same outage), returning 503.

`maxDuration = 300` (5 min timeout for long generation runs).

## POST /api/compile (`compile/route.ts`)

Compiles blueprint → HQ import JSON → `.ccz`. Pipeline: `expandBlueprint()` → `AutoFixer.fix()` → `CczCompiler.compile()`. Stores result in `.data/` via `store.ts`.

The CczCompiler validates every XForm after case block injection (bind/ref integrity, itext references) and validates suite.xml well-formedness before packaging. Throws on any structural issue.

**Sub-routes:**
- `POST /api/compile/json` — returns HQ import JSON only, uses `ApiError` for validation failures
- `GET /api/compile/[id]/download` — downloads stored `.ccz` file

## Project Routes (`projects/`)

All routes use `requireSession()` from `lib/auth-utils.ts` which throws `ApiError(401)` on failure. User's email is derived from the session and scopes all Firestore operations to `users/{email}/projects/`.

- **GET /api/projects** — list user's projects sorted by `updated_at` desc. Returns denormalized summaries (no full blueprints) via Firestore `select()` — the blueprint is never read, data is validated on write. Includes timeout inference: projects stuck in `generating` longer than `MAX_GENERATION_MINUTES` (10 min) are returned as `status: 'error'` and lazily persisted via `failProject()`.
- **GET /api/projects/[id]** — load a single project. Returns `{ blueprint, app_name, status, error_type }` for builder hydration. BuilderLayout checks `status` and redirects to `/builds` if not `'complete'`.
- **PUT /api/projects/[id]** — update a project after client-side edits (auto-save). Validates blueprint via `appBlueprintSchema` before writing. Uses `set({ merge: true })` to survive race conditions with the initial fire-and-forget save.

CRUD helpers in `lib/db/projects.ts`: `createProject`, `completeProject`, `failProject`, `updateProject`, `loadProject`, `listProjects`.

### Log Routes (`projects/[id]/logs/`)

- **GET /api/projects/[id]/logs** — load `StoredEvent[]` for the latest run. Returns `{ events, runId }`. **Admin-only** — uses `requireAdmin()` because logs contain full conversation transcripts. Used by the builds page Replay button (hidden for non-admins).
- **GET /api/projects/[id]/logs?runId={id}** — load events for a specific run, ordered by `sequence`. Returns `{ events, runId }`.

Both return `{ events: [], runId: null }` when no logs exist. Events are the same `StoredEvent` format written by both sinks — consumed directly by `extractReplayStages()` on the client.

CRUD helpers in `lib/db/logs.ts`: `writeLogEvent`, `loadRunEvents`, `loadLatestRunId`.

## Admin Routes (`admin/`)

Admin-only routes for the admin dashboard. All use `requireAdmin()` from `lib/auth-utils.ts` (401 if unauthenticated, 403 if not admin). Types in `lib/types/admin.ts`.

- **GET /api/admin/users** — list all users with current month usage. Fetches all `UserDoc`s via `listAllUsers()`, then enriches each with usage (`docs.usage`) and project count (`collections.projects.count()`) in parallel. Returns `{ users: AdminUserRow[], stats: AdminStats }`. Stats (total users, generations, spend) computed from the same data.
- **GET /api/admin/users/[email]** — user detail with all-time usage history and project list. Three parallel Firestore reads: `getUser()`, `collections.usage().orderBy()`, `listProjects()`. Email is URL-encoded and decoded before use.
- **GET /api/admin/users/[email]/projects/[projectId]/logs** — admin log replay endpoint. Mirrors the user-facing logs route but scopes to the target user's email (from URL) instead of the session user. Reuses `loadRunEvents` and `loadLatestRunId`.

## POST /api/log/error (`log/error/route.ts`)

Client error logging endpoint — receives browser-side errors and logs them as structured JSON for GCP Cloud Logging. No auth required — errors can happen before, during, or after authentication. Zod-validated payload with size limits (2KB message, 8KB stack, 2KB URL). Returns 204 on success, 400 on invalid payload. Logs via the structured logger (`lib/log.ts`) with `origin: 'client'` label so client errors are filterable alongside server errors in Cloud Logging Explorer.

Payload: `{ message: string, stack?: string, source: 'window.onerror' | 'unhandledrejection' | 'error-boundary' | 'manual', url: string, componentStack?: string }`. Component stacks (from React error boundaries) are appended to the JS stack for a combined trace in GCP Error Reporting.

Called by `reportClientError()` from `lib/clientErrorReporter.ts` via `navigator.sendBeacon` (survives page unloads). Client-side dedup + rate limiting (max 10 unique errors per page load) prevents crash loop floods.

## GET /api/user/usage (`user/usage/route.ts`)

Returns the authenticated user's current month usage and spend cap. Authenticated-only — BYOK users have no usage tracking. Uses `requireSession()` from `lib/auth-utils.ts` which throws `ApiError(401)` on failure.

Response: `{ cost_estimate: number, request_count: number, cap: number, period: string }`. `cost_estimate` and `request_count` default to 0 if no usage document exists yet (first request of the month). `cap` is `MONTHLY_SPEND_CAP_USD` from `lib/db/usage.ts`. `period` is the current `yyyy-mm` string. Consumed by `AccountMenu` to render the usage progress bar.

