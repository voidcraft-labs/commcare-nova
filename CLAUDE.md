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

- `(app)/` — authenticated app shell (providers, toasts, noise). Chrome splits one level down: `(app)/(site)/` renders the global AppHeader for the app list / admin / settings; `(app)/build/` renders its own BuilderHeader (logo, centered Preview toggle, doc tools) — the builder never carries the site nav, and the split is structural, not a pathname check.
- `(docs)/docs/` — public docs; never reads the session; forced dynamic so the per-request CSP nonce stamps onto inline RSC chunks (SSG would bake them nonceless and strict-dynamic CSP would kill hydration). Docs are product surface: when a change alters what users see or do, the docs move with it.
- `(dev-only)/` — dev-only test pages gated by `NODE_ENV` in their own layout.

Root `app/layout.tsx` stays minimal (html/body/fonts/CSS). Anything calling `getSession()` belongs under `(app)/` so public surfaces don't pay for session lookups.

### Single agent, two endpoints

`/api/chat` runs the chat-side `ToolLoopAgent` (the Solutions Architect): one conversation = one prompt-cache window, no orchestration or sub-agents. `/api/mcp` exposes the same shared tools to external MCP clients without its own agent loop. Both consume one tool surface in `lib/agent/tools/` — see `lib/agent/CLAUDE.md`.

**MCP accepts two bearer shapes**: OAuth JWTs (browser-mediated delegation, refresh rotation) and `sk-nova-v1-` API keys (service accounts; exist because concurrent worktrees sharing one OAuth refresh token cascade-revoke each other). The route mounts as a Better Auth plugin endpoint so it sits under auth's rate limiting; both paths converge on one `ToolContext`. Floor scopes enforced at verify; HQ scopes per-tool.

**Edit vs build mode** are two orthogonal decisions: app-exists picks prompt + tool set (edit mode never exposes generation tools; app-exists stays false during initial generation so tools aren't stripped mid-build), and the 5-min prompt-cache window picks message strategy (within: full history; after: last-user-message only).

### Valid by construction — one rule, every surface

Every committed mutation batch is gated BEFORE persistence/dispatch by `evaluateCommit` (`lib/commcare/validator/gate.ts`) via the shared verdict `lib/doc/commitVerdicts.ts::mutationCommitVerdict`: **a commit may never INTRODUCE a validator finding** of a gating class — shape, soundness, or completeness — in any app state, on any surface. There are no phases, no draft window, and no finishing step; status never feeds the gate. The introduced-error identity diff is the grandfather clause: pre-existing findings in legacy docs never block an unrelated edit, and the birth findings (a fresh app's nameless, moduleless state) only ever shrink. One verdict, every commit surface: the shared tool layer covers chat-SA and MCP alike (`lib/agent/tools/common.ts::guardedMutate` — a rejected call returns the findings in its `{ error }` envelope and writes nothing), the builder UI gates at the dispatch hook (`useBlueprintMutations` — a rejected edit never dispatches; surfaces that render the returned findings beside the control dispatch through its `inline` flavor, everything else announces via the error toast so a rejection can never vanish silently), and the session store's `switchConnectMode` commits the app-level Connect state as ONE gated batch (`setConnectType` + the AUTHORITATIVE participating-form set handed to it; the Connect manager — `ConnectManagerDialog`, opened from `AppConnectSection`'s Manage button — seeds each form's draft from the live doc (current mode) and the mode stash (the other mode) and hands over the whole set, so the store never restores from the stash itself). Undo/redo, hydration, the agent stream, and replay bypass the gate because they replay already-committed states. Exports are zero-tolerance: `collectBoundaryViolations` runs the full validator (media manifest included) at every compile/upload entry point and ANY finding rejects with per-finding prose — an invalid app never reaches a device or CommCare HQ. Legacy pre-gate apps come inside that boundary via the one-time `scripts/scan-legacy-findings.ts` / `repair-legacy-findings.ts` pair (judgment table + strictly-decreasing repair oracle in `scripts/lib/legacyFindingRepairs.ts`; the opt-in `--media` arm in `scripts/lib/legacyMediaRefs.ts` resolves referenced assets and clears provably-dead refs), run before the expression-AST migration in the merge choreography. **Structural creation is atomic** (`createForm` requires its `fields`; `createModule` takes `forms` + `case_list_columns` + the case-type's `case_type_record` when the type is new) so growth never dead-ends: a rejection's findings are satisfiable by adjusting the same call. **Builds**: the SA plans first (`generateSchema` + `planAppDesign` — pure conversation artifacts, zero doc writes), sets the name/connect type (`updateApp`), then executes one `createModule` per planned module; the chat route finalizes at drain end (status flip + case-store materialize + `data-done`), and MCP needs no finalize at all — `create_app` births `complete` (an empty app is at rest and valid) and the cross-store saga materializes schemas on every case-type-touching commit. `status` is pure run-liveness (`generating` ↔ chat-run in flight, `error` ↔ failed build awaiting retry). There is no post-hoc fix loop; the construction fuzz (`lib/agent/tools/__tests__/constructionFuzz.test.ts` — a tool-grown doc carries ZERO findings once its first module lands) plus per-mutation-kind guard coverage (`lib/doc/__tests__/rescopingGuardCoverage.test.ts`) prove it.

**The reference index — no document searches in the write path.** Every write-path question of the shape "who references X?" / "who declares X?" (the rename cascade, `moveField`'s re-anchor pass, the case-type retirement planner, the peer-aware rename verdict) is a lookup on `BlueprintDoc.refIndex` — derived state maintained per mutation inside `applyMutation(s)`, identical on every apply surface, rebuilt from the doc alone at every hydration boundary, and never persisted (`toPersistableDoc` strips it; zero bytes of any stored or emitted artifact change). Edges key on identity — a form-local ref on the target field's stable uuid, a case-property ref on `(caseType, property)`, a type-naming ref on the case-type name — and record only (carrier uuid, reference-slot-registry slot id); a consumer that needs structure walks the named slot's AST leaves or re-locates its prose hashtags. Correctness is the incremental ≡ rebuild oracle (`buildReferenceIndex` is both the hydration builder and the fuzz oracle; pinned-seed fuzzes assert deep-equality after every applied batch). Details + the query surface: `lib/doc/CLAUDE.md`.

**Expressions are stored as typed ASTs — references are identity, text is a projection.** Every XPath-kind slot (a field's `calculate`/`relevant`/`validate`/`default_value`/`required`, the repeat `repeat_count`/`ids_query`, form-link conditions/datums, the Connect bindings) stores the expression AST from `lib/domain/xpath`: a form-local reference is a leaf holding the target field's UUID, a case-property reference a `(caseType, property)` name pair, and everything between is byte-exact text runs. Renames and moves never touch these slots — printing resolves identity to CURRENT names (`printXPath` against the doc), which is what every reader consumes through `expressionSource`/`readFieldString`. Close conditions point at their field by uuid the same way. The boundaries stay TEXT: the SA tools and the builder editors parse on commit (`lib/doc/expressionText.ts`) and print for display; prose (labels/hints/help, markdown + hashtags) stays strings permanently with the prose rewriter. The parser/printer pair obeys the fuzz-pinned round-trip law `print(parse(s)) === s` byte-identical for every input (`lib/commcare/xpath/expressionAst.ts` ↔ `lib/domain/xpath`), which is the migration-safety oracle: stored docs and event logs convert via the one-time `scripts/scan-expression-asts.ts` / `migrate-expression-asts.ts` pair with provably zero wire-byte changes. The code reads only the new shape — no dual-read paths; run the migration when deploying over pre-AST data.

### CommCare boundary

`lib/commcare/` owns CommCare's wire vocabulary (HqApplication JSON, XForm XML, `.ccz`, the XPath dialect, identifier rules, HQ REST client, KMS-encrypted HQ credentials). Everything else speaks the domain shape and crosses only through the `@/lib/commcare` barrel — enforced by a Biome `noRestrictedImports` rule with the allowed consumers in `biome.json`. See `lib/commcare/CLAUDE.md`.

### Multimedia

Media assets (image/audio/video) attach to field message slots, select options, module/form menu tiles, and the app logo. Bytes live in GCS keyed by content hash; one Firestore row per asset tracks status (`lib/db/mediaAssets`, `lib/storage/media`). Uploads are validated by magic-bytes sniff (`lib/media/validate`) — accepted set is image (png/jpg/gif/webp), audio **`.mp3`/`.wav` only**, video `.mp4`; `.m4a`/`.ogg` are rejected because CommCare HQ's deployed mime table can't ingest them. `lib/media/manifest` + `lib/media/boundaryValidation` are the only consumers of the `@/lib/commcare` boundary outside the emitter itself (allowlisted in `biome.json`): they resolve assets to wire paths and run the export-boundary validation.

**Media attaches verify the asset at the source.** An asset's lifecycle lives outside the doc (bytes in GCS, a Firestore status row), so the attach is the LAST commit that can see its state — and it checks it there: the five SA/MCP media tools run `lib/media/attachVerdicts.ts::mediaAttachVerdict` before their gated commit (exists, owned, `ready`, kind-matched to the slot, referenced-media aggregate inside the export ceiling), and the browser picker attaches only ready assets — a picked FILE stages in the session store (`stagedUploads`: progress + cancel on the slot chip, never doc state) and dispatches the gated attach only on upload confirm. Both browser entry points (library pick, staged confirm) ALSO run the export-ceiling check pre-dispatch (`components/builder/media/useAttachBudget.ts` over the session's `assetMeta` registry, fetching unknown refs via the library route's resolve mode) with the same prose the tool verdict speaks. The ceiling math has ONE source — `lib/media/exportBudget.ts` — consumed by the boundary, the tool verdict, and the browser check; its header carries the trust model (client checks = honest-user UX guarantee, the boundary = enforcement authority — a bypassing client changes nothing, the export still refuses). Attach-time checking is sufficient because an asset can't go bad afterward: deleting a referenced asset is refused (`lib/media/assetDeletion.ts::findAppReferencesToAsset` on both delete surfaces), `ready` is terminal, owner and kind are immutable (citations in the verdict module's header). On MCP the per-asset judgment re-runs INSIDE the transactional commit (the asset rows join the transaction's read set), so a delete racing the attach serializes against it. The boundary gate's media arm is therefore defense-in-depth — legacy refs and ops disasters — like the rest of the boundary.

**Media-OFF/ON emit contract.** Media wire artifacts (itext `<value form>`, `media_suite.xml`, `multimedia_map`, the logo profile property) emit ONLY where the bytes also ship: the `.ccz` compile path (bundled in the archive), the HQ-upload path (app imported media-ON, then every referenced file shipped as ONE bulk `multimedia.zip` to HQ's api-key `upload_multimedia_api`, which path-matches each entry to the app's `jr://` references), and the JSON-export paths (`/api/compile/json`, MCP `compile_app` json) — which return a media-ON bundle (the app JSON + that same bulk `multimedia.zip`) when the app has media, and the plain media-OFF JSON (byte-identical to the pre-media output) when it doesn't. Every export entry point runs the zero-tolerance boundary gate before expand (`lib/media/boundaryValidation.ts::collectBoundaryViolations` — the full validator with the resolved asset manifest), so a stale/pending/foreign/kind-mismatched ref — or any other validator finding — surfaces as an actionable rejection rather than a broken artifact on the device or HQ. Clearing a media slot uses a dedicated mutation kind (never an `{ key: undefined }` patch, which JSON drops on the wire) — see `lib/doc/CLAUDE.md`.

**Export resource bounds.** Media-ON compile / HQ upload load every referenced ready asset into memory at once, so the same boundary gate enforces an aggregate ceiling (`MAX_MEDIA_EXPORT_ASSETS` / `MAX_MEDIA_EXPORT_BYTES` in `lib/domain/multimedia`) before any byte is fetched, and `resolveMediaManifest` downloads under bounded concurrency. Browser uploads PUT to a `pending/<owner>/...` key via a V4 signed URL that can't cap size, so the bucket relies on a lifecycle rule reaping abandoned/oversized `pending/` objects — apply it (idempotently) with `scripts/infra/apply-media-bucket-lifecycle.ts`. Compiled `.ccz` archives are returned inline from `POST /api/compile` (the binary twin of `/api/compile/json`) and never persisted server-side — the bytes go straight back to the authenticated compiler in the same request, so there is no stored artifact to access-scope or reap, and nothing that can go missing when a follow-up request lands on a different Cloud Run instance.

### Persistence invariants

- **Fail-closed**: the Firestore app doc is created BEFORE generation — Firestore down = 503, never an orphaned build. Every blueprint mutation advances `updated_at`. Failure detection is two-layer (route catch blocks + a stalled-`updated_at` reaper) because Cloud Run can kill processes before catch blocks run.
- **Server-side drain**: the chat route drains the agent loop server-side and forwards chunks manually, so a closed tab neither cancels nor mis-finalizes a run; a fatal model error arrives as an `{type:"error"}` CHUNK, not a throw. Charge/refund finalization invariants live in `lib/db/CLAUDE.md`.
- The root route branches landing / get-started / app list with no redirects; there is no `/apps` route.

### Firestore

`ignoreUndefinedProperties: true`. **App ownership is explicit** — apps are root-level docs with an `owner` field; every route serving user data verifies ownership (admin routes skip). Event log + per-run summaries: `lib/log/CLAUDE.md`. **Two-ledger credits**: `usage/` is the accumulate-only actual-dollar record feeding the invisible $50 backstop; `credits/` is the resettable user-facing gate (missing doc = full balance); build = 100, edit = 5, reserved in a transaction, refunded on no-op/failed runs (`lib/db/CLAUDE.md`). **Better Auth's user collection is the identity source of truth**; the admin dashboard and admin gating read Firestore directly (the typed client omits `additionalFields`; the session cookie caches 5 min). **Chat threads** are one doc per conversation with embedded messages; thread id = run id.

## Data model

**Fields are self-contained.** All metadata lives on the field. Case-type metadata is a generation-time artifact — defaults are baked into fields at add time and the case-type record is never consulted at runtime.

**Field id = case property name.** A field saves to the case type named by its `case_property_on` value — matching the module's type is a normal property; naming a different type auto-derives child case creation. The pointer is named `case_property_on` (not `case_property`) so the parameter reads as a preposition pointing at the case type, not as the property name itself.

**Form-level case wiring is derived, not stored** — expander + validator scan fields on demand.

**Four form types.** Registration (creates case), followup (updates), close (loads + closes), survey (no case). Close is a superset of followup. Centralized form-type sets exist — use them rather than ad-hoc string comparisons.

**Two identities per field.** Semantic id (mutable, used as XForm node name / CommCare property key) vs stable uuid (assigned at creation, never changed on rename). Use uuid for UI identity (React keys, DOM selectors, drag-and-drop IDs); use id / path for blueprint mutations + expander/compiler calls.

**Sibling ids must be unique** (CommCare requirement; cousins can share). Enforced at the source on every surface via the shared verdicts in `lib/doc/identifierVerdicts.ts` (UI rename guard, SA `addFields`/`editField` rejections) plus auto-suffix on cross-level moves and duplication; `DUPLICATE_FIELD_ID` stays as the validator backstop.

**Case list columns are fully LLM-controlled** — no auto-prepend/filter by expander or compiler.

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

- `connect_type` is an enum, not a plain string — `z.string()` only enforces "any string" in JSON Schema, so an enum is required to force a valid value from the LLM.
- A state stash preserves form-level connect configs across app-level mode switches (learn ↔ deliver) so toggling off/on doesn't lose work.
- **Connect sub-config ids** (`learn_module.id` etc.) are each an XForm element name *and* a Connect Postgres slug (`varchar(50)` is the tightest column), so each must be a legal element name, ≤50 chars, and unique app-wide. Forced correct at the **source**: autofilled valid+unique when omitted, rejected when an explicit value is invalid/duplicate (field commit guard + SA tools fail the call; validator backstops; the UI restore/seed paths re-derive on collision). The emit resolver `buildConnectSlugMap` is a typed pass-through that asserts and throws — never caps, dedups, or falls back. Don't add an emit-time fixup: an over-length slug 500ing Connect's insert is exactly the bug this prevents.
- Content-based sub-config assignment for learn apps (educational → learn module only; quiz → assessment only; combined → both) is enforced by the SA prompt.
- Sub-configs are independent; a PRESENT connect block must carry ≥1 sub-config of the app's mode (the per-form `CONNECT_MISSING_LEARN`/`CONNECT_MISSING_DELIVER` well-formedness rules).
- **A connect block marks that a form PARTICIPATES in Connect — omitting it makes the form auxiliary, a legal wire state.** Connect's ingestion is coverage-blind (`commcare_connect/opportunity/app_xml.py::extract_modules` scans per form and silently skips blockless forms; opportunity creation upserts what was found with no coverage check), so the only coverage rule is the app-level floor: `CONNECT_NO_PARTICIPATING_FORMS` fires on a Connect app whose forms include zero participants of its mode family (zero learn modules makes progress meaningless; zero deliver units pays nothing). Per-form `connect` rides the creation tools (`createModule` / `createForm`) and the `planAppDesign` plan, so a participating form lands WITH its block; an empty Connect app is clean, which is why a Connect build flips `connect_type` first (`updateApp`) and an existing app gives ≥1 form its block before the flip. Removing a block is an ordinary gated edit unless it is the app's last participating form.
- Wire-format defaults for configurable-but-rarely-customized XPath fields (`deliver_unit.entity_id` / `entity_name`, `assessment.user_score`) live at `lib/commcare/connectDefaults.ts` and run at bind-emit time only. The doc tracks what was explicitly set; the wire layer fills the rest. Same pattern for any future Connect field with this shape — don't scatter defaults across the agent layer or validate time.
- **Connect sub-toggles collect, never invent.** A sub-config's names/descriptions are content the user writes: the form-settings sub-toggles stage the block (the Connect manager's collect-before-commit pattern at sub-config scale) and commit only once the user fills it; a stashed prior block restores silently. Derived identifiers autofill; wire-defaulted XPaths stay absent.
