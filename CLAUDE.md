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
npm run dev                             # boots local case-store Postgres (compose.yaml) + applies migrations, then Turbopack
npm run db:dev / db:dev:down            # start (+migrate) / stop the local case-store Postgres on its own
npm run build / lint / format / test
npm run test:leaks                      # full suite under the async-leak detector (slow; see Testing)
npx tsx scripts/test-schema.ts          # test SA tool-input schemas are API-accepted
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

**Observability is two-channel.** Cloud Logging stays the log stream: `lib/logger.ts` writes structured JSON to stdout/stderr (severity, labels, `stack_trace` for GCP Error Reporting) and `/api/log/error` funnels browser errors into it. Sentry (org `dimagi-1l`, project `nova`) owns error grouping, tracing, and session replay; events auto-tag `environment` so dev noise filters out. **Every error reaches Sentry through exactly one funnel.** Server: `log.error`/`log.critical` mirror to Sentry (Sentry can't see stdout), and uncaught route throws ride `instrumentation.ts`'s `captureRequestError`; `log.warn` stays Cloud Logging-only by design (expected provider conditions — rate limits, overload). Client: the SDK's global handlers own `window.onerror`/`unhandledrejection` first-hand, and `reportClientError` captures the sources the SDK can't see (error boundaries, manual reports). `/api/log/error` passes `{ sentry: false }` because its payloads already reached Sentry browser-side — keep that opt-out rare and justified. Browser events tunnel through `/api/monitoring` (a Next rewrite, allowlisted on the main + docs hosts; an off-allowlist tunnel path 404s in the proxy and client reporting silently dies). Session Replay needs the proxy CSP's `worker-src 'self' blob:`. Server/edge configs keep `sendDefaultPii` off so request cookies (the session token) never reach Sentry. Source maps upload inside the Cloud Build docker build via the `nova-sentry` secret → `SENTRY_AUTH_TOKEN` build arg.

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

### Valid by construction — one rule, every surface

Every committed mutation batch is gated BEFORE persistence/dispatch by `evaluateCommit` (`lib/commcare/validator/gate.ts`) via the shared verdict `lib/doc/commitVerdicts.ts::mutationCommitVerdict`: **a commit may never INTRODUCE a validator finding** of a gating class — shape, soundness, or completeness — in any app state, on any surface. There are no phases, no draft window, and no finishing step; status never feeds the gate. The introduced-error identity diff is the grandfather clause: pre-existing findings in legacy docs never block an unrelated edit, and the birth findings (a fresh app's nameless, moduleless state) only ever shrink. One verdict, every commit surface: the shared tool layer covers chat-SA and MCP alike (`lib/agent/tools/common.ts::guardedMutate` — a rejected call returns the findings in its `{ error }` envelope and writes nothing), the builder UI gates at the dispatch hook (`useBlueprintMutations` — a rejected edit never dispatches and surfaces as an error toast), and the session store's `switchConnectMode` commits the app-level Connect flip as ONE gated batch (`setConnectType` + each participating form's block — stash restores plus the blocks the builder's enable dialog collects from the user up front; see `AppConnectSection`). Undo/redo, hydration, the agent stream, and replay bypass the gate because they replay already-committed states. Exports are zero-tolerance: `collectBoundaryViolations` runs the full validator (media manifest included) at every compile/upload entry point and ANY finding rejects with per-finding prose — an invalid app never reaches a device or CommCare HQ. Legacy pre-gate apps come inside that boundary via the one-time `scripts/scan-legacy-findings.ts` / `repair-legacy-findings.ts` pair (judgment table + strictly-decreasing repair oracle in `scripts/lib/legacyFindingRepairs.ts`), run before the expression-AST migration in the merge choreography. **Structural creation is atomic** (`createForm` requires its `fields`; `createModule` takes `forms` + `case_list_columns` + the case-type's `case_type_record` when the type is new) so growth never dead-ends: a rejection's findings are satisfiable by adjusting the same call. **Builds**: the SA plans first (`generateSchema` + `planAppDesign` — pure conversation artifacts, zero doc writes), sets the name/connect type (`updateApp`), then executes one `createModule` per planned module; the chat route finalizes at drain end (status flip + case-store materialize + `data-done`), and MCP needs no finalize at all — `create_app` births `complete` (an empty app is at rest and valid) and the cross-store saga materializes schemas on every case-type-touching commit. `status` is pure run-liveness (`generating` ↔ chat-run in flight, `error` ↔ failed build awaiting retry). There is no post-hoc fix loop; the construction fuzz (`lib/agent/tools/__tests__/constructionFuzz.test.ts` — a tool-grown doc carries ZERO findings once its first module lands) plus per-mutation-kind guard coverage (`lib/doc/__tests__/rescopingGuardCoverage.test.ts`) prove it.

**The reference index — no document searches in the write path.** Every write-path question of the shape "who references X?" / "who declares X?" (the rename cascade, `moveField`'s re-anchor pass, the case-type retirement planner, the peer-aware rename verdict) is a lookup on `BlueprintDoc.refIndex` — derived state maintained per mutation inside `applyMutation(s)`, identical on every apply surface, rebuilt from the doc alone at every hydration boundary, and never persisted (`toPersistableDoc` strips it; zero bytes of any stored or emitted artifact change). Edges key on identity — a form-local ref on the target field's stable uuid, a case-property ref on `(caseType, property)`, a type-naming ref on the case-type name — and record only (carrier uuid, reference-slot-registry slot id); a consumer that needs structure walks the named slot's AST leaves or re-locates its prose hashtags. Correctness is the incremental ≡ rebuild oracle (`buildReferenceIndex` is both the hydration builder and the fuzz oracle; pinned-seed fuzzes assert deep-equality after every applied batch). Details + the query surface: `lib/doc/CLAUDE.md`.

**Expressions are stored as typed ASTs — references are identity, text is a projection.** Every XPath-kind slot (a field's `calculate`/`relevant`/`validate`/`default_value`/`required`, the repeat `repeat_count`/`ids_query`, form-link conditions/datums, the Connect bindings) stores the expression AST from `lib/domain/xpath`: a form-local reference is a leaf holding the target field's UUID, a case-property reference a `(caseType, property)` name pair, and everything between is byte-exact text runs. Renames and moves never touch these slots — printing resolves identity to CURRENT names (`printXPath` against the doc), which is what every reader consumes through `expressionSource`/`readFieldString`. Close conditions point at their field by uuid the same way. The boundaries stay TEXT: the SA tools and the builder editors parse on commit (`lib/doc/expressionText.ts`) and print for display; prose (labels/hints/help, markdown + hashtags) stays strings permanently with the prose rewriter. The parser/printer pair obeys the fuzz-pinned round-trip law `print(parse(s)) === s` byte-identical for every input (`lib/commcare/xpath/expressionAst.ts` ↔ `lib/domain/xpath`), which is the migration-safety oracle: stored docs and event logs convert via the one-time `scripts/scan-expression-asts.ts` / `migrate-expression-asts.ts` pair with provably zero wire-byte changes. The code reads only the new shape — no dual-read paths; run the migration when deploying over pre-AST data.

### CommCare boundary

`lib/commcare/` is the single package that owns CommCare's wire vocabulary — `HqApplication` JSON, XForm XML, `.ccz` archive, the XPath dialect, identifier rules, HQ REST client, KMS encryption for stored HQ credentials. Everything else in `lib/` speaks the domain shape (`BlueprintDoc` + `Field`) and only crosses into CommCare through the `@/lib/commcare` barrel. A Biome `noRestrictedImports` rule enforces the boundary; the allowed consumers live in `biome.json`. See `lib/commcare/CLAUDE.md`.

### Multimedia

Media assets (image/audio/video) attach to field message slots, select options, module/form menu tiles, and the app logo. Bytes live in GCS keyed by content hash; one Firestore row per asset tracks status (`lib/db/mediaAssets`, `lib/storage/media`). Uploads are validated by magic-bytes sniff (`lib/media/validate`) — accepted set is image (png/jpg/gif/webp), audio **`.mp3`/`.wav` only**, video `.mp4`; `.m4a`/`.ogg` are rejected because CommCare HQ's deployed mime table can't ingest them. `lib/media/manifest` + `lib/media/boundaryValidation` are the only consumers of the `@/lib/commcare` boundary outside the emitter itself (allowlisted in `biome.json`): they resolve assets to wire paths and run the export-boundary validation.

**Media attaches verify the asset at the source.** An asset's lifecycle lives outside the doc (bytes in GCS, a Firestore status row), so the attach is the LAST commit that can see its state — and it checks it there: the five SA/MCP media tools run `lib/media/attachVerdicts.ts::mediaAttachVerdict` before their gated commit (exists, owned, `ready`, kind-matched to the slot, referenced-media aggregate inside the export ceiling), and the browser picker attaches only ready assets. Attach-time checking is sufficient because an asset can't go bad afterward: deleting a referenced asset is refused (`lib/media/assetDeletion.ts::findAppReferencesToAsset` on both delete surfaces), `ready` is terminal, owner and kind are immutable (citations in the verdict module's header). On MCP the per-asset judgment re-runs INSIDE the transactional commit (the asset rows join the transaction's read set), so a delete racing the attach serializes against it. The boundary gate's media arm is therefore defense-in-depth — legacy refs and ops disasters — like the rest of the boundary.

**Media-OFF/ON emit contract.** Media wire artifacts (itext `<value form>`, `media_suite.xml`, `multimedia_map`, the logo profile property) emit ONLY where the bytes also ship: the `.ccz` compile path (bundled in the archive), the HQ-upload path (app imported media-ON, then every referenced file shipped as ONE bulk `multimedia.zip` to HQ's api-key `upload_multimedia_api`, which path-matches each entry to the app's `jr://` references), and the JSON-export paths (`/api/compile/json`, MCP `compile_app` json) — which return a media-ON bundle (the app JSON + that same bulk `multimedia.zip`) when the app has media, and the plain media-OFF JSON (byte-identical to the pre-media output) when it doesn't. Every export entry point runs the zero-tolerance boundary gate before expand (`lib/media/boundaryValidation.ts::collectBoundaryViolations` — the full validator with the resolved asset manifest), so a stale/pending/foreign/kind-mismatched ref — or any other validator finding — surfaces as an actionable rejection rather than a broken artifact on the device or HQ. Clearing a media slot uses a dedicated mutation kind (never an `{ key: undefined }` patch, which JSON drops on the wire) — see `lib/doc/CLAUDE.md`.

**Export resource bounds.** Media-ON compile / HQ upload load every referenced ready asset into memory at once, so the same boundary gate enforces an aggregate ceiling (`MAX_MEDIA_EXPORT_ASSETS` / `MAX_MEDIA_EXPORT_BYTES` in `lib/domain/multimedia`) before any byte is fetched, and `resolveMediaManifest` downloads under bounded concurrency. Browser uploads PUT to a `pending/<owner>/...` key via a V4 signed URL that can't cap size, so the bucket relies on a lifecycle rule reaping abandoned/oversized `pending/` objects — apply it (idempotently) with `scripts/infra/apply-media-bucket-lifecycle.ts`. Compiled `.ccz` archives are returned inline from `POST /api/compile` (the binary twin of `/api/compile/json`) and never persisted server-side — the bytes go straight back to the authenticated compiler in the same request, so there is no stored artifact to access-scope or reap, and nothing that can go missing when a follow-up request lands on a different Cloud Run instance.

### Root route

`/` branches between landing / get-started / app list with no redirects. A cheap app-existence check runs before the Suspense boundary so new users skip the skeleton flash. No `/apps` route — the domain *is* the namespace.

### Fail-closed persistence

The Firestore app doc is created **before** generation — Firestore down = 503, not an orphaned build. Every blueprint mutation advances `updated_at`. Two-layer failure detection: route catch blocks fail the app fire-and-forget; the list query infers failure when `updated_at` stalls >10 min. The second layer exists because Cloud Run can kill processes before catch blocks run.

### Server-side drain — generation outlives the connection

The chat route drains the agent loop server-side (`consumeStream()`) and forwards chunks via a manual `toUIMessageStream()` loop (not `writer.merge()`), so a closed browser tab neither cancels the run nor mis-finalizes it: finalization keys off the drain's terminal state, and a fatal model error surfaces as the `{type:"error"}` chunk rather than a throw. The charge/refund finalization invariant and the stale-`generating` reaper live in `lib/db/CLAUDE.md`.

### Firestore

`ignoreUndefinedProperties: true` — sentinel-to-undefined post-processing would otherwise throw on write.

**App ownership is explicit, not path-scoped.** Apps are root-level with an `owner` field; any route serving user data must verify ownership (admin routes skip).

**Event log** at `apps/{appId}/events/` captures generation runs as a flat stream of MutationEvent + ConversationEvent; per-run cost/behavior summary at `apps/{appId}/runs/{runId}`. See `lib/log/CLAUDE.md`.

**Two-ledger credit model.** `usage/{userId}/months/{period}` is the accumulate-only ACTUAL-dollar record (resets never touch it) feeding the invisible `$50` runaway backstop; `credits/{userId}/months/{period}` is the resettable user-facing gate (`allowance + bonus − consumed`), a missing doc reading as a full balance. A build costs 100 credits, an edit 5, reserved up front in a Firestore transaction and refunded on a no-op/failed run. See `lib/db/CLAUDE.md`.

**Better Auth's user collection is the single source of truth for user identity.** The admin dashboard reads it directly via Firestore SDK because Better Auth's typed user omits `additionalFields` (present at runtime). Admin gating also reads Firestore directly to bypass the 5-min session-cookie cache.

**Chat threads** are one doc per conversation with messages embedded (not a subcollection) — threads are small and always loaded together. Thread id = run id. Fire-and-forget persistence on each ready transition; historical threads stream in via Suspense.

## Data model

**Fields are self-contained.** All metadata lives on the field. Case-type metadata is a generation-time artifact — defaults are baked into fields at add time and the case-type record is never consulted at runtime.

**Field id = case property name.** A field saves to the case type named by its `case_property_on` value — matching the module's type is a normal property; naming a different type auto-derives child case creation. The pointer is named `case_property_on` (not `case_property`) so the parameter reads as a preposition pointing at the case type, not as the property name itself.

**Form-level case wiring is derived, not stored** — expander + validator scan fields on demand.

**Four form types.** Registration (creates case), followup (updates), close (loads + closes), survey (no case). Close is a superset of followup. Centralized form-type sets exist — use them rather than ad-hoc string comparisons.

**Two identities per field.** Semantic id (mutable, used as XForm node name / CommCare property key) vs stable uuid (assigned at creation, never changed on rename). Use uuid for UI identity (React keys, DOM selectors, drag-and-drop IDs); use id / path for blueprint mutations + expander/compiler calls.

**Sibling ids must be unique** (CommCare requirement; cousins can share). Enforced at the source on every surface via the shared verdicts in `lib/doc/identifierVerdicts.ts` (UI rename guard, SA `addFields`/`editField` rejections) plus auto-suffix on cross-level moves and duplication; `DUPLICATE_FIELD_ID` stays as the validator backstop.

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

The "~8 optional fields per array item" compile ceiling is specific to **grammar-constrained decoding** — the `Output.object` / structured-output path. There, Anthropic's grammar compiler times out above ~8 optionals on opus-4-7 and earlier ("Grammar compilation timed out"); opus-4-8 raises it to at least 11. **Plain tool use (`tools[name].inputSchema`) is NOT grammar-constrained**, so it has no such ceiling — the SA's field-mutation tools (`addFields` et al.) run on tool use and carry 10+ optionals freely. The required-with-sentinel pattern that used to pad `addFields` was inherited from a structured-output test path and never bound the real tool surface; `addFields` now requires only `id`/`kind`/`label` (label kept required-with-sentinel as a kind-dependent label-validity guard, not a budget device). For any genuine structured-output (`Output.object`) schema, two patterns still fit the cap: required-with-sentinel for universal keys (post-processed via `stripEmpty`) and nested-object optionals for grouped feature configs (one slot regardless of inner field count). Field schemas come from one shared source — never inline new ones in tool defs. Verify tool-input acceptance with `scripts/test-schema.ts`.

## Model configuration

Model IDs, pricing, and SA model/reasoning settings live in one file as code constants, not user-configurable.

## CommCare Connect

- `connect_type` is an enum, not a plain string — `z.string()` only enforces "any string" in JSON Schema, so an enum is required to force a valid value from the LLM.
- A state stash preserves form-level connect configs across app-level mode switches (learn ↔ deliver) so toggling off/on doesn't lose work.
- **Connect sub-config ids** (`learn_module.id` etc.) are each an XForm element name *and* a Connect Postgres slug (`varchar(50)` is the tightest column), so each must be a legal element name, ≤50 chars, and unique app-wide. Forced correct at the **source**: autofilled valid+unique when omitted, rejected when an explicit value is invalid/duplicate (field commit guard + SA tools fail the call; validator backstops; the UI restore/seed paths re-derive on collision). The emit resolver `buildConnectSlugMap` is a typed pass-through that asserts and throws — never caps, dedups, or falls back. Don't add an emit-time fixup: an over-length slug 500ing Connect's insert is exactly the bug this prevents.
- Content-based sub-config assignment for learn apps (educational → learn module only; quiz → assessment only; combined → both) is enforced by the SA prompt.
- Sub-configs are independent; a PRESENT connect block must carry ≥1 sub-config of the app's mode (the per-form `CONNECT_MISSING_LEARN`/`CONNECT_MISSING_DELIVER` well-formedness rules).
- **A connect block marks that a form PARTICIPATES in Connect — omitting it makes the form auxiliary, a legal wire state.** Connect's ingestion is coverage-blind (`commcare_connect/opportunity/app_xml.py::extract_modules` scans per form and silently skips blockless forms; opportunity creation upserts what was found with no coverage check), so the only coverage rule is the app-level floor: `CONNECT_NO_PARTICIPATING_FORMS` fires on a Connect app whose forms include zero participants of its mode family (zero learn modules makes progress meaningless; zero deliver units pays nothing). Per-form `connect` rides the creation tools (`createModule` / `createForm`) and the `planAppDesign` plan, so a participating form lands WITH its block; an empty Connect app is clean, which is why a Connect build flips `connect_type` first (`updateApp`) and an existing app gives ≥1 form its block before the flip. Removing a block is an ordinary gated edit unless it is the app's last participating form.
- Wire-format defaults for configurable-but-rarely-customized XPath fields (`deliver_unit.entity_id` / `entity_name`, `assessment.user_score`) live at `lib/commcare/connectDefaults.ts` and run at bind-emit time only. The doc tracks what was explicitly set; the wire layer fills the rest. Same pattern for any future Connect field with this shape — don't scatter defaults across the agent layer or validate time.
- **Connect sub-toggles collect, never invent.** A sub-config's names/descriptions are content the user writes: the form-settings sub-toggles stage the block (the app-level enable dialog's collect-before-commit pattern at sub-config scale) and commit only once the user fills it; a stashed prior block restores silently. Derived identifiers autofill; wire-defaulted XPaths stay absent.
