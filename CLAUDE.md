# commcare nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- Next.js 16 (App Router, Turbopack) · TypeScript strict · Tailwind v4 (`@theme inline`)
- AI: Vercel AI SDK — `ToolLoopAgent`, streamed UI messages, `useChat`
- State: Zustand scoped per-buildId · doc store with zundo undo/redo
- DB: Firestore · Encryption: Cloud KMS
- Auth: Better Auth + admin plugin. Sign-in is gated by an email-domain allowlist in `lib/auth.ts`; the GCP OAuth consent screen narrows it further at the Workspace-customer level
- Use `motion/react` for animation (NOT `framer-motion`)
- Use `@base-ui/react` for floating elements (no raw `@floating-ui/react` in app code)
- Biome + Lefthook pre-commit · Vitest

## Commands

```bash
npm run dev                             # boots local case-store Postgres (compose.yaml) + applies migrations, then Turbopack
npm run db:dev / db:dev:down            # start (+migrate) / stop the local case-store Postgres on its own
npm run build / lint / format / test
npm run test:leaks                      # full suite under the async-leak detector (slow)
npx tsx scripts/test-schema.ts          # test SA tool-input schemas are API-accepted
npx tsx scripts/build-xpath-parser.ts   # rebuild Lezer parser from lib/commcare/xpath/grammar.lezer.grammar
```

`scripts/` also has read-only Firestore inspection tools and a `recover-app` writer (⚠️). Run any with `--help`. Excluded from Docker.

## Testing — async-resource leaks

A test "leaks" when it leaves a timer, open handle, or never-settling promise alive after it finishes; leaked resources keep the Vitest worker's event loop open and can hang the whole run. A `pre-push` lefthook command runs the full suite under `--detect-async-leaks` and fails the push on any leak (pre-push, not pre-commit, because the async_hooks instrumentation is slow). A blocked push is a real failure: `npm run test:leaks` gives a source-located report.

**Fix at the source — never paper over** (no `teardownTimeout` bumps, pool switches, retries):

- Timers: clear in `afterEach`/`afterAll`.
- Promises: await or cancel. For pending-UX assertions, never mock with `new Promise(() => {})` (a permanent leak) — use a controllable deferred and resolve it inside `act`.
- React trees: let RTL auto-cleanup unmount; flush pending updates with `await screen.findBy*`/`waitFor`.
- Libraries that start module-level timers get mocked at the import boundary: `mcp-handler` (session-GC interval) and `motion/react` (rAF loop under happy-dom; `vitest.setup.ts` renders passthrough elements — animation is never the contract under test).

If a test reaches for fake timers or asserts UI that merely reflects internal state, test the state or pure transformation directly and mount nothing.

## Deployment

Google Cloud Run via Docker (`output: "standalone"`). **The default `*.run.app` URL is disabled** — the service is reachable only through the custom domains (`commcare.app`, `mcp.commcare.app`, `docs.commcare.app`); `gcloud run services describe` still lists run.app URLs but they 404. Re-enable with `--default-url` if needed.

**Observability is two-channel; every error reaches Sentry through exactly one funnel.** Cloud Logging is the log stream (`lib/logger.ts` structured JSON; `/api/log/error` funnels browser errors in). Sentry (org `dimagi-1l`, project `nova`) owns grouping/tracing/replay. Server: `log.error`/`log.critical` mirror to Sentry; uncaught route throws ride `instrumentation.ts`; `log.warn` stays Cloud-Logging-only by design (expected provider conditions). Client: the SDK owns global handlers; `reportClientError` captures what the SDK can't see (error boundaries, manual reports); `/api/log/error` passes `{ sentry: false }` because its payloads already reached Sentry browser-side — keep that opt-out rare. Browser events tunnel through `/api/monitoring` (a rewrite allowlisted on main + docs hosts — an off-allowlist tunnel path 404s and client reporting silently dies). Session Replay needs the proxy CSP's `worker-src 'self' blob:`. `sendDefaultPii` stays off server/edge so session cookies never reach Sentry. Source maps upload in the Cloud Build docker build via the `nova-sentry` secret.

## Architecture

### Multi-host, single service

One Cloud Run service serves three hostnames, separated by `proxy.ts` on the `Host` header: `commcare.app` (builder, auth, chat), `mcp.commcare.app` (MCP API; external `/mcp` rewrites to `/api/mcp`), `docs.commcare.app` (public docs; wire paths rewrite to `/docs/<...>`, and `/docs` itself is internal-only). Per-host allowlists in `lib/hostnames.ts` 404 anything off-list — **new `/api/*` routes need an allowlist entry or the proxy 404s them in prod while localhost masks it.**

### Route groups

- `(app)/` — authenticated builder; owns `getSession()`, header, providers.
- `(docs)/docs/` — public docs; never reads the session; forced dynamic so the per-request CSP nonce stamps onto inline RSC chunks (SSG would bake them nonceless and strict-dynamic CSP would kill hydration). Docs are product surface: when a change alters what users see or do, the docs move with it.
- `(dev-only)/` — dev-only test pages gated by `NODE_ENV` in their own layout.

Root `app/layout.tsx` stays minimal (html/body/fonts/CSS). Anything calling `getSession()` belongs in `(app)/layout.tsx` so public surfaces don't pay for session lookups.

### Single agent, two endpoints

`/api/chat` runs the chat-side `ToolLoopAgent` (the Solutions Architect): one conversation = one prompt-cache window, no orchestration or sub-agents. `/api/mcp` exposes the same shared tools to external MCP clients without its own agent loop. Both consume one tool surface in `lib/agent/tools/` — see `lib/agent/CLAUDE.md`.

**MCP accepts two bearer shapes**: OAuth JWTs (browser-mediated delegation, refresh rotation) and `sk-nova-v1-` API keys (service accounts; exist because concurrent worktrees sharing one OAuth refresh token cascade-revoke each other). The route mounts as a Better Auth plugin endpoint so it sits under auth's rate limiting; both paths converge on one `ToolContext`. Floor scopes enforced at verify; HQ scopes per-tool.

**Edit vs build mode** are two orthogonal decisions: app-exists picks prompt + tool set (edit mode never exposes generation tools; app-exists stays false during initial generation so tools aren't stripped mid-build), and the 5-min prompt-cache window picks message strategy (within: full history; after: last-user-message only).

### CommCare boundary

`lib/commcare/` owns CommCare's wire vocabulary (HqApplication JSON, XForm XML, `.ccz`, the XPath dialect, identifier rules, HQ REST client, KMS-encrypted HQ credentials). Everything else speaks the domain shape and crosses only through the `@/lib/commcare` barrel — enforced by a Biome `noRestrictedImports` rule with the allowed consumers in `biome.json`. See `lib/commcare/CLAUDE.md`.

### Multimedia

Bytes live in GCS keyed by content hash; one Firestore row per asset. Accepted set (magic-bytes sniffed): png/jpg/gif/webp, mp3/wav ONLY (HQ's mime table can't ingest m4a/ogg), mp4.

**Media wire artifacts emit ONLY where the bytes also ship**: the `.ccz` path, the HQ-upload path (one bulk `multimedia.zip` to HQ's upload API), and the JSON-export paths (media-ON bundle when the app has media; otherwise byte-identical media-OFF JSON). Every media-ON entry point runs the media validator first so stale/pending/foreign/kind-mismatched refs fail actionably. Clearing a media slot uses a dedicated mutation kind — never an `{ key: undefined }` patch, which JSON drops on the wire (see `lib/doc/CLAUDE.md`).

**Export bounds**: media-ON export loads referenced assets into memory, so the validator enforces aggregate ceilings (`lib/domain/multimedia`) before any byte is fetched, and manifest resolution downloads under bounded concurrency. Browser uploads PUT to `pending/<owner>/...` via V4 signed URLs that can't cap size — a bucket lifecycle rule reaps abandoned `pending/` objects (`scripts/infra/apply-media-bucket-lifecycle.ts`, idempotent). Compiled `.ccz` archives return inline from the compile route and are never persisted server-side.

### Persistence invariants

- **Fail-closed**: the Firestore app doc is created BEFORE generation — Firestore down = 503, never an orphaned build. Every blueprint mutation advances `updated_at`. Failure detection is two-layer (route catch blocks + a stalled-`updated_at` reaper) because Cloud Run can kill processes before catch blocks run.
- **Server-side drain**: the chat route drains the agent loop server-side and forwards chunks manually, so a closed tab neither cancels nor mis-finalizes a run; a fatal model error arrives as an `{type:"error"}` CHUNK, not a throw. Charge/refund finalization invariants live in `lib/db/CLAUDE.md`.
- The root route branches landing / get-started / app list with no redirects; there is no `/apps` route.

### Firestore

`ignoreUndefinedProperties: true`. **App ownership is explicit** — apps are root-level docs with an `owner` field; every route serving user data verifies ownership (admin routes skip). Event log + per-run summaries: `lib/log/CLAUDE.md`. **Two-ledger credits**: `usage/` is the accumulate-only actual-dollar record feeding the invisible $50 backstop; `credits/` is the resettable user-facing gate (missing doc = full balance); build = 100, edit = 5, reserved in a transaction, refunded on no-op/failed runs (`lib/db/CLAUDE.md`). **Better Auth's user collection is the identity source of truth**; the admin dashboard and admin gating read Firestore directly (the typed client omits `additionalFields`; the session cookie caches 5 min). **Chat threads** are one doc per conversation with embedded messages; thread id = run id.

## Data model

- **Fields are self-contained** — all metadata on the field; case-type records are generation-time artifacts never consulted at runtime.
- **Field id = case property name.** A field saves to the case type named by `case_property_on` (named as a preposition pointing at the TYPE, never bare `case_property`); naming a different type derives child-case creation.
- **Form-level case wiring is derived, not stored.**
- **Four form types** (registration / followup / close / survey); close is a superset of followup. Use the centralized form-type sets, not ad-hoc string comparisons.
- **Two identities per field**: semantic id (mutable; XForm node name / property key) vs stable uuid (UI identity — React keys, DOM selectors, DnD). Mutations take id/path.
- **Sibling ids must be unique** (CommCare requirement; cousins may share) — enforced on cross-level moves (auto-suffix + XPath rewrite) and rename.
- **Case list columns are fully LLM-controlled** — no auto-prepend/filter anywhere.

### CommCare HQ upload

Each upload creates a NEW HQ app (no atomic update API) via the hardcoded HQ base URL with a KMS-encrypted user key. Two CSRF + WAF workarounds live on the import endpoint — details in `lib/commcare/CLAUDE.md`.

## Conventions

- **Icons**: always `@iconify/react/offline` (the default export renders empty for 1–3 frames). Missing Tabler icons go in the project's extras file, SVG from tabler.io.
- **Inputs**: every `<input>`/`<textarea>` gets `autoComplete="off"` and `data-1p-ignore`.
- **RSC + auth**: pages are Server Components; push `'use client'` down to small leaves. Server layouts are the auth gate — client code must never re-gate on session state. The Better Auth client disables refetch-on-focus (the default briefly nulls session data on tab switch).
- **No portals for fixed-position elements** — `createPortal` to body causes SSR hydration mismatches; fixed positioning doesn't need it.
- **Builder state** is three sources of truth: URL (location + selection), doc store (blueprint, undo/redo), session store (ephemeral UI/lifecycle). Intra-builder navigation uses the History API via `useNavigate`, never Next's router. Biome enforces this and the store-access boundaries — the named domain hooks in `lib/*/hooks` are the public surface; raw stores and selector-accepting hooks are lib-private.
- **DOM listeners**: React 19 ref-callback cleanup, not `useEffect`, for click-outside/Escape/observers. Time-bounded animations clear state via `onAnimationEnd` (filtered on `e.animationName`), not timers.
- **Floating elements**: one floating-tree coordinator handles dismiss/focus; glass/elevated styles go on the POSITIONER, not the popup (`will-change: transform` on the positioner breaks descendant `backdrop-filter`). Option dropdowns use the menu primitive for ARIA; searchable pickers use autocomplete in uncontrolled mode, committing on item-press only.
- **Navigation + errors**: never `router.push`/`replace` during render; route-level error boundaries use `window.location.href` (React's tree is in an error state); all boundaries report to the server.

## Theme

Dark "Violet Monochrome" — violet is the single non-semantic accent; success/warning/error hues are reserved for semantic states, never decoration. CSS custom properties in `globals.css` drive everything. Z-index is a semantic token scale — use the Tailwind classes that reference it. Floating surfaces have two tiers: frosted glass, and a near-opaque elevated tier that stacks above glass (glass-on-glass loses blur).

## Structured output constraint

The "~8 optional fields per array item" ceiling applies ONLY to grammar-constrained decoding (`Output.object`) — plain tool use has no such ceiling, and the SA's field-mutation tools carry 10+ optionals freely. For genuine structured-output schemas: required-with-sentinel for universal keys (post-processed via `stripEmpty`) and nested-object optionals for grouped configs. Field schemas come from one shared source — never inline new ones in tool defs. Verify acceptance with `scripts/test-schema.ts`.

## Model configuration

Model IDs, pricing, and SA model/reasoning settings live in one file as code constants, not user-configurable.

## CommCare Connect

- `connect_type` is an enum (a plain `z.string()` lets the LLM emit anything).
- A state stash preserves form-level connect configs across app-level mode switches so toggling doesn't lose work.
- **Connect sub-config ids** are each an XForm element name AND a Connect Postgres slug (`varchar(50)`), so each must be a legal element name, ≤50 chars, unique app-wide — forced correct at the SOURCE (autofill, commit guards, validator backstop). The emit resolver asserts and throws; never add an emit-time fixup (an over-length slug 500ing Connect's insert is the bug this prevents).
- Sub-configs are independent; learn and deliver apps each require ≥1. Per-form `connect` rides the scaffold schema; the validator's `CONNECT_FORM_MISSING_BLOCK` backstops omissions.
- Wire-format defaults for rarely-customized Connect XPath fields live at `lib/commcare/connectDefaults.ts` and apply at bind-emit time only — the doc tracks what was explicitly set. Use the same pattern for future Connect fields; don't scatter defaults across layers.
