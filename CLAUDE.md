# commcare nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- Next.js 16 (App Router, Turbopack) · TypeScript strict · Tailwind v4 (`@theme inline`)
- AI: Vercel AI SDK — `ToolLoopAgent`, streamed UI messages, `useChat`
- State: Zustand scoped per-buildId · doc store with zundo undo/redo
- DB: Firestore · Encryption: Cloud KMS
- Auth: Better Auth + admin plugin. Sign-in is gated by an email-domain allowlist in `lib/auth.ts` (`databaseHooks.user.create.before`); the GCP OAuth consent screen narrows it further at the Workspace-customer level
- Use `motion/react` for animation (NOT `framer-motion`)
- Use `@base-ui/react` for floating elements (no raw `@floating-ui/react` in app code)
- Biome + Lefthook pre-commit · Vitest

## Commands

```bash
npm run dev                             # Turbopack
npm run build / lint / format / test
npm run test:leaks                      # full suite under the async-leak detector (slow; see Testing)
npx tsx scripts/test-schema.ts          # test structured output schemas
npx tsx scripts/build-xpath-parser.ts   # rebuild Lezer parser from lib/commcare/xpath/grammar.lezer.grammar
```

`scripts/` also has read-only Firestore inspection tools and a `recover-app` writer (⚠️). Run any with `--help` for flags. Excluded from Docker.

## Testing — async-resource leaks

A test "leaks" when it leaves an async resource alive after it finishes:
an uncleared `setInterval`/`setTimeout`, an open handle, or a promise that
never settles. A live timer or handle keeps Node's event loop open, so the
Vitest worker that ran the test can't exit on its own. Vitest force-kills
the worker after a timeout — and when that races, the **whole run hangs**
(the "the test suite hangs and I have to kill it by hand" problem). A
perpetual leak (an animation frame loop, an uncleared `setInterval`) never
goes idle at all, so it can hang the run outright.

**The gate.** A `pre-push` lefthook command runs `scripts/check-async-leaks.ts`,
which runs the full suite under `vitest run --detect-async-leaks` and
**fails the push** if any leak is reported. It is on `pre-push` (not
`pre-commit`) because the detector instruments every async resource via
`node:async_hooks` and is much slower than a normal run — too slow to gate
every commit, right where "don't ship a leaking test" belongs. If the gate
blocks you, it is a **real failure to fix, not a flake**: re-run
`npm run test:leaks` to see the source-located report (file, line, stack of
each leaked resource) and which file, if any, hangs.

**Fix at the source — never paper over.** Do NOT bump `teardownTimeout`,
switch pools, add retries, or suppress the report; those hide the hang
instead of fixing it. Fix it where the resource is created:

- **Timer** — clear it (`clearTimeout`/`clearInterval`) in `afterEach`/
  `afterAll`. A test that legitimately needs a timer owns clearing it.
- **Promise** — `await` it or cancel it before the test ends. For a
  pending-UX assertion (a spinner / disabled button while an action is in
  flight), do NOT mock the action with a never-resolving `new Promise(() => {})`
  — that is a permanent leak by construction. Use a controllable deferred:
  capture its `resolve`, assert the in-flight UX, then resolve it and let
  the follow-on settle inside `act`.
- **React tree** — let RTL's auto-cleanup unmount it, and await any pending
  state update with `await screen.findBy*` / `await waitFor(...)` so it
  flushes inside `act` rather than dangling past the test.
- **A library that starts a module-level timer or animation loop** — mock it
  at the import boundary so the timer never starts in tests. `mcp-handler`
  starts a session-GC `setInterval`; tests mock `createMcpHandler`.
  `motion/react`'s frame loop reschedules `requestAnimationFrame` forever
  under happy-dom; `vitest.setup.ts` mocks `motion/react` to a passthrough
  that renders the plain element and emits no frames. Animation is never the
  contract under test, so killing the engine changes no assertion.

The deeper principle: if a test reaches for fake timers or asserts on UI
state that's just a reflection of internal state, it's usually testing the
wrong thing — test the internal state or pure transformation directly and
mount nothing.

## Deployment

Google Cloud Run via Docker (`next.config.ts` → `output: "standalone"`).

**Default `*.run.app` URL is disabled.** The service is reachable only through the three custom-domain mappings (`commcare.app`, `mcp.commcare.app`, `docs.commcare.app`). `gcloud run services describe` still lists the `*.run.app` URLs in `run.googleapis.com/urls` — they 404 in practice. Re-enable with `gcloud run services update commcare-nova --region=us-central1 --default-url` if needed for debugging.

## Architecture

### Multi-host, single service

One Cloud Run service serves three hostnames, separated by middleware (`proxy.ts`) reading the `Host` header:

- `commcare.app` — main builder app, `/api/auth`, `/api/chat`, OAuth AS metadata.
- `mcp.commcare.app` — MCP API only. Externally exposed `/mcp` rewrites internally to `/api/mcp`.
- `docs.commcare.app` — public docs site. Every wire path rewrites internally to `/docs/<...>` so docs URLs read clean (`docs.commcare.app/claude-code/commands`); `/docs` itself is internal-only and 404s if requested directly. Per-host allowlists in `lib/hostnames.ts` 404 anything off the list.

### Route groups

Three groups under `app/`:
- `(app)/` — authenticated builder. Owns `getSession()`, `AppHeader`, toast/tooltip providers, `nova-noise`. All main-app pages live here.
- `(docs)/docs/` — public docs site. Mounts its own fumadocs `RootProvider`; never reads the session. Forced to dynamic rendering (`export const dynamic = "force-dynamic"` on the page) so the proxy's per-request CSP nonce can stamp onto Next's inline RSC chunks — SSG would bake them nonceless and the strict-dynamic CSP would block them, killing hydration. Treated as product surface, not a separate artifact — when a change alters what users see or do, the docs move with it. Drift is a bug.
- `(dev-only)/` — dev-only test pages, gated by `NODE_ENV` in their own layout.

Root `app/layout.tsx` is intentionally minimal — html/body/fonts/global CSS only. Anything that calls `getSession()` belongs in `(app)/layout.tsx`, not the root, so the docs and any future public surface aren't paying for a session lookup they never use.

### Single agent, two endpoints

`/api/chat` runs the chat-side `ToolLoopAgent` (the Solutions Architect): it converses, generates, and edits. One conversation = one prompt-cache window, so the SA keeps full memory of every design decision. No orchestration, no sub-agents. `/api/mcp` exposes the SA's shared tools to external MCP clients (Claude Code et al) without running its own agent loop — the external client drives the loop. Both endpoints consume one tool surface in `lib/agent/tools/`; see `lib/agent/CLAUDE.md` for the contract that lets both reuse the same domain logic.

**MCP accepts two bearer shapes.** OAuth-issued JWT (browser-driven sign-in, refresh-token rotation, browser-mediated user delegation) or `sk-nova-v1-`-prefixed API keys (service-account identities, no rotation, opt-in via `/settings`). Issue #9 on the plugin proved that concurrent worktrees sharing one OAuth refresh token cascade-revoke each other; API keys are the answer for that shape. The route is mounted as a Better Auth plugin endpoint at `/api/auth/mcp` (`app/api/mcp/auth-plugin.ts`) so it sits under `auth.handler`'s `onRequestRateLimit` middleware; `app/api/mcp/route.ts` is a thin shim that synthesizes the auth-router URL from the wire request. The plugin's `dispatchMcpAuthRequest` peeks the bearer prefix and forks to JWT or API-key path; both converge on `dispatchMcpTools` so tool handlers see one `ToolContext`. Floor scopes (`nova.read` + `nova.write`) enforced at the verify layer on both paths; HQ scopes checked per-tool because they're orthogonal to read/write.

**Edit vs build mode.** Two orthogonal decisions: (1) whether the app already exists picks the prompt + tool set — existing apps get editing prompt + blueprint summary + shared tools only; generation tools are never exposed in edit mode. (2) Prompt-cache window (5-min TTL) picks message strategy — within window: full history; after expiry: last-user-message only. App-exists stays false during initial generation even after modules land, so gen tools aren't stripped mid-build.

### CommCare boundary

`lib/commcare/` is the single package that owns CommCare's wire vocabulary — `HqApplication` JSON, XForm XML, `.ccz` archive, the XPath dialect, identifier rules, HQ REST client, KMS encryption for stored HQ credentials. Everything else in `lib/` speaks the domain shape (`BlueprintDoc` + `Field`) and only crosses into CommCare through the `@/lib/commcare` barrel. A Biome `noRestrictedImports` rule enforces the boundary; the allowed consumers live in `biome.json`. See `lib/commcare/CLAUDE.md`.

### Multimedia

Media assets (image/audio/video) attach to field message slots, select options, module/form menu tiles, and the app logo. Bytes live in GCS keyed by content hash; one Firestore row per asset tracks status (`lib/db/mediaAssets`, `lib/storage/media`). Uploads are validated by magic-bytes sniff (`lib/media/validate`) — accepted set is image (png/jpg/gif/webp), audio **`.mp3`/`.wav` only**, video `.mp4`; `.m4a`/`.ogg` are rejected because CommCare HQ's deployed mime table can't ingest them. `lib/media/manifest` + `lib/media/mediaValidation` are the only consumers of the `@/lib/commcare` boundary outside the emitter itself (allowlisted in `biome.json`): they resolve assets to wire paths and run the media validator.

**Media-OFF/ON emit contract.** Media wire artifacts (itext `<value form>`, `media_suite.xml`, `multimedia_map`, the logo profile property) emit ONLY where the bytes also ship: the `.ccz` compile path (bundled in the archive) and the HQ-upload path (app imported media-ON, then bytes POSTed per-file — HQ assigns the real `multimedia_id` via `create_mapping`). Raw-JSON paths (`/api/compile/json`, MCP `compile_app` json) stay media-OFF and are byte-identical to the pre-media output. Every media-ON entry point runs the media validator before expand, so a stale/pending/foreign/kind-mismatched ref surfaces as an actionable error rather than a broken reference on the device. Clearing a media slot uses a dedicated mutation kind (never an `{ key: undefined }` patch, which JSON drops on the wire) — see `lib/doc/CLAUDE.md`.

### Root route

`/` branches between landing / get-started / app list with no redirects. A cheap app-existence check runs before the Suspense boundary so new users skip the skeleton flash. No `/apps` route — the domain *is* the namespace.

### Fail-closed persistence

The Firestore app doc is created **before** generation — Firestore down = 503, not an orphaned build. Every blueprint mutation advances `updated_at`. Two-layer failure detection: route catch blocks fail the app fire-and-forget; the list query infers failure when `updated_at` stalls >10 min. The second layer exists because Cloud Run can kill processes before catch blocks run.

### Manual stream reader loop

The chat route reads the model stream manually (not `writer.merge()`) so stream errors can be caught and emitted as error data parts before the stream closes.

### Firestore

`ignoreUndefinedProperties: true` — sentinel-to-undefined post-processing would otherwise throw on write.

**App ownership is explicit, not path-scoped.** Apps are root-level with an `owner` field; any route serving user data must verify ownership (admin routes skip).

**Event log** at `apps/{appId}/events/` captures generation runs as a flat stream of MutationEvent + ConversationEvent; per-run cost/behavior summary at `apps/{appId}/runs/{runId}`. See `lib/log/CLAUDE.md`.

**Better Auth's user collection is the single source of truth for user identity.** The admin dashboard reads it directly via Firestore SDK because Better Auth's typed user omits `additionalFields` (present at runtime). Admin gating also reads Firestore directly to bypass the 5-min session-cookie cache.

**Chat threads** are one doc per conversation with messages embedded (not a subcollection) — threads are small and always loaded together. Thread id = run id. Fire-and-forget persistence on each ready transition; historical threads stream in via Suspense.

## Data model

**Fields are self-contained.** All metadata lives on the field. Case-type metadata is a generation-time artifact — defaults are baked into fields at add time and the case-type record is never consulted at runtime.

**Field id = case property name.** A field saves to the case type named by its `case_property_on` value — matching the module's type is a normal property; naming a different type auto-derives child case creation. The pointer is named `case_property_on` (not `case_property`) so the parameter reads as a preposition pointing at the case type, not as the property name itself.

**Form-level case wiring is derived, not stored** — expander + validator scan fields on demand.

**Four form types.** Registration (creates case), followup (updates), close (loads + closes), survey (no case). Close is a superset of followup. Centralized form-type sets exist — use them rather than ad-hoc string comparisons.

**Two identities per field.** Semantic id (mutable, used as XForm node name / CommCare property key) vs stable uuid (assigned at creation, never changed on rename). Use uuid for UI identity (React keys, DOM selectors, drag-and-drop IDs); use id / path for blueprint mutations + expander/compiler calls.

**Sibling ids must be unique** (CommCare requirement; cousins can share). Enforced on cross-level moves (auto-suffix + XPath rewrite) and on rename.

**Case list columns are fully LLM-controlled** — no auto-prepend/filter by expander or compiler.

### CommCare HQ upload

Each upload creates a new HQ app (no atomic update API), POSTed via the hardcoded HQ base URL with a KMS-encrypted user key. Two CSRF + WAF workarounds live on the import endpoint to compensate for HQ-side decorator gaps. Details in `lib/commcare/CLAUDE.md`.

## Conventions

### Icons

Always import from `@iconify/react/offline`. The default `@iconify/react` export hydrates via effects and renders an empty span for 1–3 frames; `/offline` renders synchronously. The Tabler iconify package is stale vs upstream — missing icons go in the project's extras file with SVG sourced from tabler.io.

### Inputs

All `<input>` / `<textarea>` need `autoComplete="off"` and `data-1p-ignore`.

### RSC + auth

Pages are Server Components; interactive leaves are small colocated clients. Push `'use client'` down. Name components by what they do, not by runtime.

Server layouts are the auth gate — by the time a client component mounts, auth is guaranteed. Client code must not re-gate on session state. The Better Auth client disables refetch-on-focus because its default briefly nulls session data on tab switch.

**No portals for fixed-position elements.** `createPortal` to `document.body` causes SSR hydration mismatches. Fixed-position elements render at the viewport regardless of DOM position.

### Builder state

Three sources of truth — URL (where you are + selection), doc store (blueprint entities with zundo undo/redo), session store (ephemeral UI + generation lifecycle + replay). See `components/builder/CLAUDE.md`.

Navigation is URL-owned and uses the browser History API (not Next's router) to avoid server-side RSC re-renders. All entity UUIDs are globally unique, so a single path segment identifies the entity.

**Undo tracking is paused during hydration and agent writes** — the empty→populated transition must not enter history, and the entire agent write becomes one undoable unit. Do not remove the pause/resume calls.

**Store boundary rules enforced by Biome.** `noRestrictedImports` enforces three independent boundaries:
- Raw Zustand store modules (`@/lib/doc/store`, `@/lib/session/store`) cannot be imported outside their owning package — use the named hooks in `lib/doc/hooks/`, `lib/session/hooks`, or `lib/routing/hooks.tsx`.
- Raw selector-accepting hooks (`useBlueprintDoc`, `useBlueprintDocShallow`, `useBlueprintDocEq`, `useBlueprintDocTemporal`, `useBuilderSession`, `useBuilderSessionShallow`) are lib-private — components/app code uses named domain hooks. The imperative `*Api` hooks (`useBlueprintDocApi`, `useBuilderSessionApi`) stay allowed everywhere because they don't subscribe.
- Next.js `useRouter` is banned outside `lib/routing/**` — `useNavigate` handles intra-builder navigation via the History API, `useExternalNavigate` wraps router.push/replace/refresh for cross-route moves.

All hooks colocate with their domain: `lib/doc/hooks/`, `lib/session/hooks.tsx`, `lib/routing/hooks.tsx`, `lib/ui/hooks/`, `lib/auth/hooks/`, `lib/preview/hooks/`. The top-level `/hooks/` directory no longer exists.

**BuilderProvider** lives at `components/builder/BuilderProvider.tsx` — mounts the full provider stack (doc store → session store → scroll registry → edit guard → form engine) and the lifecycle hydrators (SyncBridge, ReplayHydrator, LoadAppHydrator).

**Field editor surface.** Each `lib/domain/fields/<kind>.ts` exports the Zod schema + `FieldKindMetadata` for its kind. The declarative editor schemas live in `components/builder/editor/fieldEditorSchemas.ts`, keyed by `FieldKind`. `FieldEditorPanel` (in `components/builder/editor/`) reads those schemas — no per-kind switching in the panel. Add a field property by adding an entry to a kind's schema. Add a field kind by creating a new file in `lib/domain/fields/`, adding it to the `fieldKinds` tuple + `fieldSchema` union + `fieldRegistry`, and wiring a schema entry in `fieldEditorSchemas.ts`.

### DOM listeners

Use React 19 ref-callback cleanup (not `useEffect`) for click-outside, Escape, and observer wire-up.

Time-bounded UI animations clear state via `onAnimationEnd` (filtered on `e.animationName` to ignore bubbled descendant animations), not JS timers. Keeps cleanup automatic and aligns the JS state with the CSS lifecycle.

### Floating elements (Base UI)

A single floating-tree coordinator handles dismiss/focus across all surfaces; the root layout provides shared tooltip delay grouping.

**Glass/elevated styles live on the positioner, not the popup** — `will-change: transform` on the positioner breaks `backdrop-filter` on descendants. Selectable-option dropdowns use the menu primitive (not popover) for ARIA + keyboard nav. Searchable pickers use the autocomplete primitive's collection in uncontrolled mode and commit on item-press only.

### Navigation + errors

Never call `router.push` / `router.replace` during render. Route-level error boundaries use `window.location.href` because React's tree is in an error state. All boundaries report to the server.

## Theme

Dark "Violet Monochrome" — violet is the single non-semantic accent; success/warning/error hues are reserved for semantic states, never decoration. CSS custom properties in `globals.css` drive everything.

Z-index is a semantic scale of named tokens (not hardcoded numbers) — use the Tailwind classes that reference them. Floating surfaces have two layers: frosted-glass primary, and a near-opaque elevated tier that stacks above glass (glass-on-glass loses blur).

## Structured output constraint

The Anthropic schema compiler times out above 8 optional fields per array item — verified hard ceiling on opus-4-7 (9 reproducibly fails via `scripts/test-schema.ts`). Two patterns to fit at 8: required-with-sentinel for universal keys (post-processed via `stripEmpty`), and nested-object optionals for grouped feature configs (one slot regardless of inner field count). Field schemas come from one shared source — never inline new ones in tool defs. Test with the schema script.

## Model configuration

Model IDs, pricing, and SA model/reasoning settings live in one file as code constants, not user-configurable.

## CommCare Connect

- `connect_type` is an enum, not a plain string — `z.string()` only enforces "any string" in JSON Schema, so an enum is required to force a valid value from the LLM.
- A state stash preserves form-level connect configs across app-level mode switches (learn ↔ deliver) so toggling off/on doesn't lose work.
- **Connect sub-config ids** (`learn_module.id` etc.) are each an XForm element name *and* a Connect Postgres slug (`varchar(50)` is the tightest column), so each must be a legal element name, ≤50 chars, and unique app-wide. Forced correct at the **source**: autofilled valid+unique when omitted, rejected when an explicit value is invalid/duplicate (field commit guard + SA tools fail the call; validator backstops; the UI restore/seed paths re-derive on collision). The emit resolver `buildConnectSlugMap` is a typed pass-through that asserts and throws — never caps, dedups, or falls back. Don't add an emit-time fixup: an over-length slug 500ing Connect's insert is exactly the bug this prevents.
- Content-based sub-config assignment for learn apps (educational → learn module only; quiz → assessment only; combined → both) is enforced by the SA prompt.
- Sub-configs are independent; learn and deliver apps each require ≥1 sub-config.
- Per-form `connect` is on the `generateScaffold` schema so the SA fills it in one tool call. Validator's `CONNECT_FORM_MISSING_BLOCK` error fires on Connect-typed apps where a form has no connect block — the fallback that catches the omission across every surface.
- Wire-format defaults for configurable-but-rarely-customized XPath fields (`deliver_unit.entity_id` / `entity_name`) live at `lib/commcare/connectDefaults.ts` and run at bind-emit time only. The doc tracks what was explicitly set; the wire layer fills the rest. Same pattern for any future Connect field with this shape — don't scatter defaults across the agent layer or validate time.
