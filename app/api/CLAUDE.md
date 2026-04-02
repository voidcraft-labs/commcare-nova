# API Routes

## Error Handling

`lib/apiError.ts` — `ApiError` class with `status` and `details` fields + `handleApiError()` utility. Routes throw `ApiError` at the point of failure; a single `handleApiError` call in the catch block produces the response.

## Auth Route (`auth/[...all]/route.ts`)

Better Auth catch-all handler — serves all `/api/auth/*` paths (OAuth flows, session management, sign-in/sign-out). Uses `toNextJsHandler(auth)` from `better-auth/next-js`.

## POST /api/chat (`chat/route.ts`)

The single endpoint for all agent interaction. Creates `RunLogger`, `GenerationContext`, `MutableBlueprint`, then `createSolutionsArchitect()`.

**API key resolution**: Uses `resolveApiKey()` from `lib/auth-utils.ts` — checks for an authenticated session first (uses server-side `ANTHROPIC_API_KEY`), falls back to `apiKey` in the request body (BYOK), returns 401 if neither.

**Input validation**: `chatRequestSchema` (from `lib/schemas/apiSchemas.ts`) validates our fields (`apiKey` (optional), `pipelineConfig`, `blueprint`, etc.) via Zod `safeParse`. `messages` is typed as `UIMessage[]` from the AI SDK — not schema-validated.

**Body params** (from `useChat` body): `apiKey` (optional — omitted for authenticated users), `pipelineConfig`, `blueprint` (for edits), `runId` (for log continuation).

**Streaming**: Uses `createUIMessageStream` with a manual reader loop (not `writer.merge()`) so stream errors can be caught and emitted as `data-error` before the stream closes. Errors are classified via `errorClassifier.ts`, logged to `RunLogger`, and emitted to the client via `ctx.emitError()`. Server emits transient data parts via `ctx.emit()` which drive builder state on the client.

`maxDuration = 300` (5 min timeout for long generation runs).

## POST /api/compile (`compile/route.ts`)

Compiles blueprint → HQ import JSON → `.ccz`. Pipeline: `expandBlueprint()` → `AutoFixer.fix()` → `CczCompiler.compile()`. Stores result in `.data/` via `store.ts`.

The CczCompiler validates every XForm after case block injection (bind/ref integrity, itext references) and validates suite.xml well-formedness before packaging. Throws on any structural issue.

**Sub-routes:**
- `POST /api/compile/json` — returns HQ import JSON only, uses `ApiError` for validation failures
- `GET /api/compile/[id]/download` — downloads stored `.ccz` file

## POST /api/models (`models/route.ts`)

Proxy for Anthropic API model listing. Uses `resolveApiKey()` for dual auth — authenticated users don't need to send an API key. Returns latest version of each model family (Opus, Sonnet, Haiku). Returns proper HTTP status codes for auth failures (401) and upstream errors (502).
