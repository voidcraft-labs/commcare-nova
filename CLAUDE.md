# commcare nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (import from `motion/react`, NOT `framer-motion`)
- **Drag & Drop**: `@dnd-kit/react` — `DragDropProvider`, `useSortable` from `@dnd-kit/react/sortable`, `move` from `@dnd-kit/helpers`, modifiers from `@dnd-kit/dom/modifiers`
- **Validation**: Zod v4
- **AI**: Vercel AI SDK (`ai` + `@ai-sdk/react` + `@ai-sdk/anthropic`) — `ToolLoopAgent`, `createUIMessageStream`, `useChat`, `generateText`, `streamText`, `Output.object()`
- **Rich Text**: TipTap 3 (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-mention`, `@tiptap/suggestion`, `@tiptap/extension-image`, `@tiptap/extension-table`)
- **Markdown**: markdown-to-jsx (read-only rendering in `lib/markdown.tsx`); tiptap-markdown handles TipTap editor I/O separately
- **XML**: htmlparser2 + domutils + dom-serializer
- **Icons**: Tabler (`@iconify-icons/tabler`) via `@iconify/react/offline`
- **Auth**: Better Auth (Firestore-backed sessions via `better-auth-firestore`, Google OAuth — domain restriction enforced by GCP OAuth consent screen, not application code) with admin plugin (`better-auth/plugins/admin`) for role-based access, banning, impersonation, and user management
- **Database**: Google Cloud Firestore (`@google-cloud/firestore`) — apps in root-level `apps/{appId}` collection (owner field stores Better Auth user ID), per-app chat threads at `apps/{appId}/threads/{threadId}` (threadId = runId), per-user monthly usage at `usage/{userId}/months/{yyyy-mm}`, per-user settings at `user_settings/{userId}` (CommCare HQ credentials, encrypted via Cloud KMS), auth state (including user identity) in `auth_*` collections managed by Better Auth
- **Encryption**: Google Cloud KMS (`@google-cloud/kms`) — symmetric encrypt/decrypt for credentials at rest. Key resource derived from `GOOGLE_CLOUD_PROJECT` (already required for Firestore) + hardcoded ring/key names — no extra env var. Key rotation handled by KMS automatically.
- **State**: Zustand (`zustand/vanilla` + `zustand/middleware`) — builder reactive state in a scoped Zustand store per buildId, imperative logic in scoped React contexts (scroll, edit guard, form preview) and store helpers
- **Linting**: Biome (`biome.json`) — formatting + lint rules. Lefthook (`lefthook.yml`) runs `biome check --staged` as a pre-commit hook. `noArrayIndexKey` is suppressed where entities lack unique IDs (modules, forms in TreeData)
- **Testing**: Vitest

## Commands

```bash
npm run dev          # Start dev server (Turbopack)
npm run build        # Production build
npm run lint         # Biome lint + format check
npm run format       # Biome auto-format
npm test             # Run tests (vitest)
npm run test:watch   # Watch mode tests
npx tsx scripts/test-schema.ts       # Test structured output schemas (reads ANTHROPIC_API_KEY from .env)
npx tsx scripts/build-xpath-parser.ts # Rebuild Lezer parser from xpath.grammar
```

### Production Diagnostic Scripts

Read-only Firestore inspection tools for debugging production issues. Excluded from Docker builds (`.dockerignore`). Shared analysis libraries in `scripts/lib/` — `blueprint-stats.ts` (blueprint analysis), `log-stats.ts` (event log analysis), `format.ts` (display formatting), `types.ts` (canonical type re-exports).

**inspect-app** — App metadata, blueprint structure, quality analysis

```
npx tsx scripts/inspect-app.ts <appId> [options]

  --stats        Quality analytics: logic counts, question types, form types, quality flags
  --questions    Full question tree with types, labels, and UUIDs
  --logic        Only questions with logic elements (calculates, show-whens, defaults, etc.)
  --case-lists   Case list and detail columns per module
  --threads      Full chat thread content and config events
  --blueprint    Raw blueprint JSON only (standalone mode, skips structure view)

Flags are combinable (e.g. --stats --case-lists) except --blueprint which is standalone.
```

**inspect-logs** — Generation event stream, cost analysis, agent behavior

```
npx tsx scripts/inspect-logs.ts <appId> [options]

  --steps        Per-step breakdown table (tools, tokens, cache%, cost, reasoning snippet)
  --timeline     Step timing analysis (delta between steps, identifies slow steps)
  --tools        Tool usage distribution (call counts, inner LLM cost per tool)
  --verbose      Full event detail (reasoning text, tool args/output, inner LLM usage)
  --type=<type>  Filter by event type (step, emission, error, config, message)
  --run=<runId>  Filter to a specific run
  --last=N       Show only last N events

Cost summary (steps, duration, tokens, cache hit rate, total cost) is always shown in the
run header. Analytical views (--steps, --timeline, --tools) replace the default event list.
```

**inspect-compare** — Side-by-side app comparison

```
npx tsx scripts/inspect-compare.ts <appId1> <appId2> [options]

  --run=build    Compare initial build runs (default)
  --run=latest   Compare most recent run (may be an edit)
  --run=<a>,<b>  Compare specific run IDs (comma-separated, one per app)
  --verbose      Include per-module form-by-form detail

Outputs: header, structure, quality metrics, case design, cost, agent behavior, quality flags.
```

**inspect-usage** — User token consumption and spend

```
npx tsx scripts/inspect-usage.ts <userId> [--all]

  --all          Show all historical months (default: current month only)
```

**recover-app** — Recover stuck apps (⚠️ WRITES to production)

```
npx tsx scripts/recover-app.ts <appId> [--confirm]

  --confirm      Actually write (without this flag, dry run only)

Sets status to "complete" and clears error_type. Only works if blueprint has modules.
```

### Performance Diagnostic Scripts

**analyze-react-profile** — React DevTools profiler trace analysis

```
python3 scripts/analyze-react-profile.py <file.json> [options]

  (no flags)                  Summary of all commits + top components + wasted renders
  --frame N                   Detail for frame N (1-indexed): all components, durations, change causes
  --frame N --ancestors Name  Ancestor chain for a component in that frame
  --component Name            All frames where a component rendered (with change causes)
  --wasted                    Components with highest wasted render counts
  --top N                     Top N components by cumulative self duration
  --min-duration F            Min ms to show in frame detail (default 0.05)

Parses JSON exported from React DevTools Profiler tab. Change descriptions show what
triggered each re-render: props (which ones), hooks (which indices), context, state,
first mount, or parent cascade (wasted). Ancestor chains trace the re-render cause
from a leaf component up to the root.
```

## Deployment

Deployed to **Google Cloud Run** via Docker. `next.config.ts` uses `output: "standalone"`.

```bash
docker build -t commcare-nova .
docker run -p 8080:8080 commcare-nova
gcloud run deploy nova --source . --region <region>
```

## Architecture Decisions

### Single Agent, Single Endpoint

`POST /api/chat` runs everything. One `ToolLoopAgent` (the **Solutions Architect / SA**) converses with users, generates apps through tool calls, and edits them. Why: one conversation context means one prompt-caching window — the SA has full memory of every design decision it made. No orchestration layer, no sub-agents, no routing. See `lib/services/CLAUDE.md` for tool inventory and build sequence.

**Edit vs. build mode.** Two orthogonal decisions control the SA's behavior: (1) `appReady` determines the prompt and tool set — if the app exists, the SA always gets the editing prompt + blueprint summary + shared tools only (no generation tools), regardless of cache state. (2) The prompt cache window (`lastResponseAt` + 5 min TTL) determines the message strategy — when the cache has expired, only the last user message is sent (one-shot edit); within the cache window, full conversation history is sent so the SA can iterate across multi-turn exchanges (e.g. askQuestions rounds). `appReady` is false during initial generation even after modules exist, so generation tools are never stripped mid-build.

### Unified Root Route

`/` has three branches, zero redirects: unauthenticated → landing page, authenticated with no apps → get-started prompt, authenticated with apps → app list (Suspense-streamed). A lightweight `userHasApps` existence check (`limit(1)`) runs before the Suspense boundary so new users see the get-started state immediately without the app-list skeleton flashing. The header hides via `isAuthenticated` prop, not pathname. `/build/[id]` is the builder (auth-gated by `app/build/layout.tsx`). No `/apps` route — the domain *is* the namespace.

### Fail-Closed Persistence

The route handler creates the Firestore app document (`status: 'generating'`) **before** generation starts — if Firestore is down, the request returns 503 rather than generating an app that can't be saved. `GenerationContext.emit()` fires background `updateApp()` calls on each blueprint-mutating emission, advancing `updated_at` throughout generation. Two-layer failure detection ensures apps never stay stuck in `generating`: (1) route handler catch blocks call `failApp()` fire-and-forget, (2) `listApps()` infers failure for any app whose `updated_at` hasn't advanced in 10 minutes. Layer 2 exists because Cloud Run can kill processes before catch blocks run (OOM, platform restart).

### Manual Stream Reader Loop

The chat route uses a manual reader loop instead of `writer.merge()` so stream errors can be caught and emitted as `data-error` parts before the stream closes. If the writer is already broken, the error still lands in the Firestore event log, and `useChat`'s error property fires on the client as a fallback.

### Controlled Drag State (No OptimisticSortingPlugin)

Question reordering uses the controlled state pattern: `onDragOver` → `move(itemsMap, event)` → React state → re-render. `useSortable` passes `plugins: []` to disable the default `OptimisticSortingPlugin` — the plugin independently reorders DOM elements and mutates sortable indices, conflicting with React's reconciliation. Do not remove `plugins: []`.

`InlineSettingsPanel` renders as a **sibling** of the sortable element (`<div ref={ref}>`), not inside it. If the panel were a child, its expanded height would inflate the sortable's collision shape, breaking group droppable detection on subsequent drags. `RestrictToElement` targets `[data-preview-scroll-container]` (the visible editor viewport).

**Connected card visual design** — when a question is selected, `EditableQuestionWrapper` gains `rounded-b-none outline-offset-0` (flat bottom, outline flush to the element edge) and the panel gets `rounded-t-none cursor-auto`. These look like mistakes but are intentional: they make the question and its properties panel read as one connected card. `cursor-auto` resets the `cursor-pointer` the panel would otherwise inherit from the `div[role=button]`. Do not "fix" these back to `rounded-lg` or `outline-offset-3`.

`RepeatField` renders a **single template instance** in edit mode — all repeat instances share the same question schema, so rendering N copies creates duplicate `useSortable` IDs that corrupt dnd-kit state. Preview mode renders all instances normally (no `DragDropProvider` in preview, so hooks are no-ops).

Sortable items are keyed by **UUID** (`q.uuid`), not `questionPath` — so sortable IDs survive renames. Group/repeat droppable containers use `${uuid}:container`. `buildDragState()` builds a `uuidToPath` reverse map so mutation calls (`moveQuestion` etc.) still receive `QuestionPath` arguments.

**InsertionPoints own the inter-question gap in edit mode.** Each `InsertionPoint` has a 24px resting height that IS the gap between questions — the hover detector covers only this area (no negative margins into adjacent fields). Questions have zero bottom margin in edit mode. In interact mode (no InsertionPoints), `mb-6` on each question provides the same 24px gap. Group/repeat body containers use `px-4` only (no vertical padding) when they have children — InsertionPoints (edit) or `pt-6` on the nested FormRenderer (interact) provide the vertical inset. Empty containers keep `p-4 min-h-[72px]` for the droppable target. `FormScreen`'s body container follows the same pattern. Do not re-add `mb-*` to questions in edit mode or `py-*` to group containers with children.

### Firestore Configuration

`ignoreUndefinedProperties: true` on the Firestore instance because `stripEmpty()` converts sentinel strings back to `undefined` during post-processing — without this flag, Firestore would throw on any write containing `undefined` values.

**App ownership is explicit, not path-scoped.** Apps live at `apps/{appId}` (root-level) with an `owner` field storing the user's ID. API routes that serve user data must verify `app.owner === session.user.id` — the collection path doesn't scope access. Admin routes skip this check. `loadAppOwner(appId)` reads just the owner field without pulling the full blueprint.

**`auth_users` is the single source of truth for user identity.** No separate user collection — `auth_users` stores profile, role (admin plugin), and `lastActiveAt` (app's `additionalFields` extension). `session.user.id` is the canonical identifier used for app ownership and usage tracking. Usage lives at `usage/{userId}/months/{yyyy-mm}` (root-level). Admin dashboard reads `auth_users` directly via Firestore SDK because Better Auth's admin plugin types (`UserWithRole`) don't include `additionalFields` — the data is there at runtime but invisible to TypeScript.

**Admin role lives on `auth_users`.** Available as `session.user.role` in sessions. `requireAdminAccess()` (RSC gate) reads `auth_users` directly to bypass the 5-minute cookie cache for immediate demotion detection. Bootstrap via `ADMIN_USER_IDS` env var or set `role: "admin"` on the `auth_users` record in Firestore console.

**Chat threads at `apps/{appId}/threads/{threadId}`.** Each thread captures one conversation session (initial build or subsequent edit). Messages are embedded in the document (not a subcollection) — threads are small (2–10 messages) and always loaded together. `threadId` = `runId` (1:1 mapping with generation sessions). Only display-relevant parts are stored: user text and answered `askQuestions` Q&A pairs. Thread persistence is fire-and-forget via server action (`saveThread` in `lib/db/threads.ts`) on each `status=ready` transition. Historical threads are loaded by `ThreadHistory` (async Server Component at `app/build/[id]/thread-history.tsx`) inside a Suspense boundary — they stream in independently without blocking the builder. The pre-rendered thread markup passes through the client boundary as `children` of ChatSidebar.

## Data Model Decisions

**Questions are self-contained.** All metadata (label, type, validation, options, case_property_on) lives on the question itself. `case_types` is a frozen generation-time artifact — `applyDefaults()` bakes case property defaults into questions during `addQuestions`, after which `case_types` is never consulted again.

**Question ID = case property name.** Questions with `case_property_on: "<case_type>"` save to that case type. When it matches the module's case type, it's a normal property. When it names a different type, child case creation is auto-derived.

**`deriveCaseConfig()` is on-demand.** Form-level case wiring (primary config, child creation, repeat context) is derived by scanning questions — never stored on the form. Called by the expander and validator.

**Four form types.** Registration (creates case), followup (updates case), close (loads + closes case), survey (no case). Close is a superset of followup: it loads the case, can preload/update properties, and always closes it. Optional `close_condition` (question + answer) makes the close conditional. `CASE_FORM_TYPES` and `CASE_LOADING_FORM_TYPES` sets in `blueprint.ts` centralize form-type behavior checks — use these instead of ad-hoc `=== "followup"` comparisons.

**Questions have two identity fields.** `id` is the semantic CommCare name (e.g. `case_name`) — mutable, used as the XForm node name and CommCare property key. `uuid` is a stable crypto UUID assigned at creation, never changed on rename. Use `uuid` for UI-layer identity: React keys, DOM selectors (`[data-question-uuid]`), dnd-kit sortable IDs, and `SelectedElement.questionUuid`. Use `id`/`QuestionPath` for blueprint mutations and CommCare expander/compiler calls.

**Sibling IDs must be unique.** CommCare requires unique question IDs within each parent level (siblings can't share IDs; cousins in different groups can). Enforced at two points: `moveQuestion()` auto-deduplicates with `_2`/`_3` suffix on cross-level moves and rewrites XPath references; `ContextualEditorHeader` blocks renames that conflict with siblings.

**`QuestionPath` is a branded string type** (`questionPath.ts`). Slash-delimited tree path like `"group1/child_q"`. Always built via `qpath(id, parent?)`, never by string concatenation.

**Case list columns are fully LLM-controlled** — no auto-prepend or filtering by the expander or compiler.

### CommCare HQ Integration

Users can upload apps directly to CommCare HQ from the builder. The upload flow creates a **new app** each time — CommCare HQ has no atomic update API yet.

**Architecture:** Upload goes through an API route (`/api/commcare/upload`) that expands the blueprint and proxies to CommCare HQ. Settings management uses Server Actions (`app/settings/actions.ts`). The user's CommCare API key stays server-side, encrypted via Cloud KMS in `user_settings/{userId}`. The HQ base URL is hardcoded (`COMMCARE_HQ_URL` in `lib/commcare/client.ts`) to prevent SSRF — never user-configurable.

**CommCare HQ API endpoints used:**
- `GET /api/user_domains/v1/` — list user's project spaces
- `POST /a/{domain}/apps/api/import_app/` — import app from JSON (multipart: `app_name` + `app_file`)

**CSRF workaround for import_app.** The import endpoint is missing `@csrf_exempt` (unlike every other POST API endpoint in HQ). Django's CSRF middleware rejects the POST with 403 before any auth or permission logic runs. The client fetches a token from `/accounts/login/` (unauthenticated GET) immediately before each import, then sends it as `X-CSRFToken` + `Cookie` + `Referer` headers on the POST. API endpoints don't set the `csrftoken` cookie — only HTML pages do, so the login page is the lightest option. If HQ fixes the decorator upstream, the extra GET is harmless.

**WAF bypass for import_app.** The import endpoint is also missing the `waf_allow('XSS_BODY')` decorator that all other XForms-handling endpoints in HQ have. AWS WAF scans the multipart request body for XSS patterns and blocks when it finds XForms elements (`<input>`, `<select1>`, `<label>`) that look like HTML tags. The fix is a 16KB padding form field (`waf_padding`) inserted before `app_file` in the multipart body — this pushes the JSON (which contains XForms XML) past the WAF inspection window. Django ignores unknown POST fields, so the padding never reaches HQ's handler. CouchDB rejects `_`-prefixed keys as reserved, so the field must NOT start with underscore. Symptom of WAF block: bare nginx 403 (`<center><h1>403 Forbidden</h1></center>`) — distinct from Django's verbose CSRF 403 page.

**Settings page** (`/settings`) — auth-gated, Server Actions for verify+save and delete (`app/settings/actions.ts`). CommCare API keys are scoped to a single domain, so verification tests domains sequentially and bails on first match.

**Export dropdown** — CommCare HQ upload is the primary option; file downloads (JSON/CCZ) are secondary below a divider. When credentials aren't configured, an informative prompt links to Settings. CommCare settings are read by the builder's RSC page (`app/build/[id]/page.tsx`) — no client-side fetch.

**Domain slug validation** — `isValidDomainSlug()` in `lib/commcare/client.ts` validates domain names against HQ's `legacy_domain_re` pattern (`^[\w.:-]+$`) to prevent path traversal in the import URL template. The permissive pattern accepts all three tiers of HQ domain slugs: new (alphanum + hyphens), grandfathered (+ dots, colons), and legacy (+ underscores).

## Conventions

### Icons

```tsx
import { Icon } from '@iconify/react/offline'
import tablerIconName from '@iconify-icons/tabler/icon-name'
<Icon icon={tablerIconName} width="16" height="16" />
```

Always import from `@iconify/react/offline`, never `@iconify/react`. The default export uses `useState` + `useEffect` for hydration safety, which renders an empty `<span>` for 1–3 frames before the SVG appears. The `/offline` export renders synchronously.

The `@iconify-icons/tabler` package is stale (v1.2.95, ~5010 icons) while Tabler has 6000+. Icons missing from the package go in `components/icons/tablerExtras.ts` as `IconifyIcon` data objects with SVG sourced from [tabler.io/icons](https://tabler.io/icons). TipTap toolbar icons (`components/tiptap-icons/`) use the same tabler set via a `TiptapIcon` wrapper.

### Inputs

All `<input>` and `<textarea>` elements must include `autoComplete="off"` and `data-1p-ignore` to suppress browser autocomplete and 1Password autofill overlays.

### RSC Architecture

Pages are Server Components that handle auth, fetch data, and render structure. Interactive leaves are small colocated client components. Push `'use client'` as far down the tree as possible. Name components by what they do (`UserTable`, `AppList`), not by runtime (`*Client`). Colocate page-specific components next to their page in `app/`.

**Server layout is the auth gate.** `app/build/layout.tsx` calls `requireAuth()` — by the time any client component mounts, auth is guaranteed. Client components must not re-gate on `useAuth().isAuthenticated` — no redirect guards, no conditional renders that return to login. Use `useAuth()` only for display concerns (user name, avatar, admin badge). `auth-client.ts` sets `refetchOnWindowFocus: false` because Better Auth's default refetch briefly nulls session data on every tab switch, causing false "unauthenticated" flashes even in non-redirect contexts.

**No portals for fixed-position elements.** `createPortal` to `document.body` causes SSR hydration mismatches (`document` doesn't exist on the server). Fixed-position elements render at the viewport level regardless of DOM position — place them in the component tree directly. Global UI (toasts, modals) belongs in the root layout as client component leaves.

### Builder State (Zustand + URL)

Three sources of truth, each scoped to what it's good at:

- **URL** (`lib/routing/*`) — "where you are" and "what's focused": screen (home/module/cases/form), selected question. Browser history gives back/forward for free.
- **Doc store** (`lib/doc/store.ts`) — blueprint entity data (modules, forms, questions) with temporal middleware for undo/redo. Accessed via `lib/doc/hooks/*` and mutated via `useBlueprintMutations`.
- **Legacy builder store** (`lib/services/builderStore.ts`) — near-empty shell. Contains only `reset()`. Phase 6 deletes this file entirely. Generation lifecycle, replay, and appId have moved to the BuilderSession store.
- **BuilderSession store** (`lib/session/store.ts`) — ephemeral UI state: `cursorMode`, sidebar visibility + stash, active field id, connect stash, focus hint, new-question marker. **Also owns generation lifecycle** (agentActive, agentStage, agentError, statusMessage, postBuildEdit, justCompleted, loading), **app identity** (appId), **generation UI state** (partialScaffold), and **replay** (stages, doneIndex, exitPath, messages). Mutated via `lib/session/hooks.tsx`. `beginAgentWrite`/`endAgentWrite` coordinate with the doc store's zundo pause/resume for undo tracking.

**Provider stack.** `BuilderProvider` (`hooks/useBuilder.tsx`) mounts: `StoreContext` → `BlueprintDocProvider` → `BuilderSessionProvider` (accepts `SessionStoreInit` for initial loading/appId) → `ScrollRegistryProvider` → `EditGuardProvider` → `BuilderFormEngineProvider`. `SyncBridge` installs the doc store ref on the session store (no longer on the legacy store). `LoadAppHydrator` stamps appId and clears loading for existing apps. `ReplayHydrator` applies replay emissions via `applyStreamEvent`. DOM helpers that used to hang off the engine (`findFieldElement`, `flashUndoHighlight`) live in `lib/routing/domQueries.ts`; the reset routine moved to `lib/services/resetBuilder.ts`.

**Two cursor modes:** `"pointer"` (live form test) and `"edit"` (combined inspect + text editing). Edit mode shows click-to-select outlines AND inline text editing simultaneously — `cursor: pointer` on question wrappers, `cursor: text` on `[data-text-editable]` zones, `cursor: auto` on the properties panel.

**Hook API** (`hooks/useBuilder.tsx` — legacy store; `lib/session/hooks.tsx` — session store; `lib/routing/hooks.tsx` — URL):
- `useBuilderStore(selector)` / `useBuilderStoreShallow(selector)` — reactive subscriptions to the legacy store (`Object.is` / shallow equality). Nearly unused — the store is a shell.
- `useBuilderStoreApi()` — imperative handle on the legacy store.
- Session hooks (`@/lib/session/hooks`): `useBuilderPhase()`, `useBuilderIsReady()`, `useAgentActive()`, `useAgentStage()`, `useAgentError()`, `useStatusMessage()`, `usePostBuildEdit()`, `useAppId()`, `usePartialScaffold()`, `useIsLoading()`, `useInReplayMode()`, `useReplayMessages()`, `useCursorMode()`, `useSwitchCursorMode()`, `useActiveFieldId()`, `useSidebarState()`, `useSetSidebarOpen()`, `useSessionFocusHint()`, `useSetFocusHint()`, `useIsNewQuestion()`, `useMarkNewQuestion()`.
- Doc-derived hooks (`hooks/useBuilder.tsx`): `useBuilderTreeData()`, `useModule()`, `useForm()`, `useQuestion()`, `useOrderedModules()`, `useOrderedForms()`, `useAssembledForm()`.
- URL hooks (`@/lib/routing/hooks`): `useLocation()`, `useNavigate()`, `useSelect()`, `useBreadcrumbs()`, `useSelectedQuestion()`, `useSelectedFormContext()`, `useIsModuleSelected(uuid)`, `useIsFormSelected(uuid)`, `useIsQuestionSelected(uuid)`.
- Composite actions (`@/lib/routing/builderActions`): `useUndoRedo()`, `useDeleteSelectedQuestion()`.

**Navigation is URL-owned.** The URL on `/build/[id]` is the sole source of truth for screen + selection. Schema: `/build/[id]?s=m|cases|f&m=<uuid>&f=<uuid>&sel=<uuid>&case=<caseId>`. `useLocation()` parses `useSearchParams()` into a discriminated `Location` union (`home | module | cases | form`). `useNavigate()` returns a stable action bag (`goHome`, `openModule`, `openCaseList`, `openCaseDetail`, `openForm`, `back`, `up`) — screen changes go through `router.push({ scroll: false })` so back/forward traverse them. `useSelect()` flips `sel=` via `router.replace({ scroll: false })` (no history entry) and honors `useConsultEditGuard()` from `EditGuardContext` so inline editors with unsaved invalid content can block the transition. `useBreadcrumbs()` derives from location + doc entities with shallow-stable selectors.

**URL validation.** First load goes through `validateAndRecover(incomingParams, doc)` (`lib/routing/validateSearchParams.ts`) in the RSC page — a stale or malformed URL triggers `redirect()` to a recovered location before the builder mounts. After mount, `LocationRecoveryEffect` (`components/builder/LocationRecoveryEffect.tsx`) subscribes to doc entity maps and calls `recoverLocation` on every change, issuing a `router.replace` when a referenced uuid disappears mid-session. Both paths share `recoverLocation` in `lib/routing/location.ts`, which walks the location inside-out (selection → form → module → home) and returns by reference when nothing changed so the happy path short-circuits.

**Screen retention via `<Activity>`.** `PreviewShell` wraps each screen in React 19's `<Activity>` so navigating away preserves the screen tree instead of unmounting it — return visits are instant. A `locationToScreen` adapter translates the URL `Location` into the legacy index-based `PreviewScreen` shape the interact-mode engine still expects, and `useDeferredValue` wraps the result so the Activity mode flip happens at low priority. PreviewShell tracks the last screen of each type in refs and passes identity to screens as a `screen` prop. This is not prop drilling (one level, direct parent→child): it's Activity's invariant that a hidden component's identity must not depend on the global current screen, which has moved on. Subscribing to the global screen would force hidden screens to render `null` and destroy the tree Activity is designed to preserve.

**No prop drilling — every component self-subscribes.** Components subscribe directly to the store or URL via hooks. `AppTree`, `BuilderSubheader`, `GenerationProgress`, `CursorModeSelector`, `StructureSidebar`, `UploadToHqDialog` — all read their own state. `ChatContainer` isolates `useChat` so per-token re-renders are scoped to the chat subtree. `BuilderContentArea` owns sidebar visibility (`chatOpen`, `structureOpen`, `cursorMode`). `BuilderLayout` subscribes to exactly `phase` + `inReplayMode` — it re-renders only on app lifecycle transitions and replay toggle, never on keystrokes, messages, clicks, or selection changes. The URL-aware reference context (which reads `useLocation()` for `getRefContext`) lives in `BuilderReferenceProvider` — extracted as a child of `BuilderLayout` specifically so `router.replace` for selection doesn't cascade back into the layout. Selection and navigation are wired through `useSelect` / `useNavigate` (`lib/routing/hooks.tsx`) at the call site, not through engine methods.

**Selection changes re-render only the 2 affected wrappers** (old + new) via `useIsQuestionSelected(uuid)` — each wrapper receives its own identity, only the matching booleans flip. Nuance: because `useIsQuestionSelected` / `useIsModuleSelected` / `useIsFormSelected` call `useLocation()` (which subscribes to `useSearchParams()`), every consumer re-runs its hook body on any URL change. The boolean return still prevents child reconciliation for non-matching rows, so the net cost is just the component function call. Phase 5's virtualization bounds the consumer count to visible rows. Components that only dispatch actions (mutations, scroll, energy) read the store API via `useBuilderStoreApi()` or scoped context hooks with zero re-render cost.

**Generation stream.** Server events from the SA agent route through `applyStreamEvent` (`lib/generation/streamDispatcher.ts`) which dispatches to three handlers: (1) doc mutation events (`data-schema`, `data-scaffold`, `data-module-done`, `data-form-done`/`fixed`/`updated`) go through the pure `toDocMutations` mapper (`lib/generation/mutationMapper.ts`) then `docStore.applyMany()`, (2) doc lifecycle events (`data-done`, `data-blueprint-updated`) call `docStore.load()` for full replacement, (3) session events (`data-start-build`, `data-phase`, `data-error`, etc.) update session store actions. The old `applyDataPart` dispatcher is deleted.

**`phase` is derived, not stored.** `useBuilderPhase()` (`lib/session/hooks.tsx`) computes it from session + doc state via `derivePhase`: Loading > Completed > Generating > Ready > Idle. No explicit `setPhase` calls. The `BuilderPhase` enum still lives in `lib/services/builder.ts` because it's imported across the builder surface.

**treeData** is derived by `useBuilderTreeData()` — subscribes to doc entity maps via `useBlueprintDocShallow`, then memoizes `deriveTreeData(data)`. Immer structural sharing keeps unchanged map references stable, so the shallow-equality selector prevents recomputation when unrelated state changes. During generation, scaffold modules are real doc entities created by the mutation mapper, so the doc derivation works at all phases.

**Replay stages are data-only** (`ReplayStage` in `lib/session/types.ts`) with an `emissions` array instead of closures. `ReplayController` applies emissions through `applyStreamEvent` — the same dispatcher used by real-time streaming.

**Undo tracking is paused during hydration and agent writes.** The doc store's temporal middleware is paused while the store is populated from `loadApp` or replay stages so the empty→populated transition never enters history. `BlueprintDocProvider` resumes tracking after synchronous hydration via `startTracking={true}` for loaded apps. During generation, `beginAgentWrite()` pauses tracking and `endAgentWrite()` resumes it — changes inside are invisible to undo, and the entire agent write becomes a single undoable unit. New builds start with tracking paused (doc is empty) until the first blueprint lands. Do not remove the pause/resume calls; without them the first undo restores a blank state.

**subscribeMutation** is owned by `BuilderReferenceProvider`: it subscribes to the doc store's `[questions, modules, forms]` tuple with a reference-equality comparator and forwards invalidations to `ReferenceProviderWrapper`. Lives there so the reference cache flushes whenever any entity map gets a new Immer reference, without adding a store subscription to `BuilderLayout`.

**Builder initial phase.** `BuilderProviderInner` pre-computes a `SessionStoreInit` with `loading: true` for existing apps/replays and `appId` derived from the buildId. `derivePhase` reads this on the very first render, so the initial phase is `Loading` (existing app/replay) or `Idle` (new build). For existing apps, `LoadAppHydrator` clears the loading flag after the doc store hydrates from `initialBlueprint`. `loading.tsx` at `app/build/[id]/` covers the server-side wait (auth + Firestore read). New builds start in `Idle` for chat-driven generation.

**Completed vs Ready.** `Completed` is a transient celebration phase after generation or a mutating edit — the signal grid shows the done animation, then `acknowledgeCompletion()` auto-decays it to `Ready`. `loadApp()` goes straight to `Ready` (no celebration). Gate on `useBuilderIsReady()` (covers both phases) when checking "has a usable blueprint" — not `phase === Ready` directly.

### Ref Callback Cleanup

DOM listeners (click-outside, Escape, ResizeObserver, MutationObserver, focusin) use React 19 ref callback cleanup instead of useEffect.

### Floating Elements (Base UI)

All floating elements (popovers, tooltips, menus, autocompletes) use `@base-ui/react` — no raw `@floating-ui/react` in application code (only vendored tiptap-ui-primitive). Base UI's `FloatingTreeStore` coordinates dismiss/focus across all floating elements automatically. `Tooltip.Provider` in the root layout provides shared delay grouping (400ms hover delay, instant adjacent reveal). Glass/elevated surface styles live on the `Positioner`, not the `Popup` — `will-change: transform` on the Positioner breaks `backdrop-filter` on descendants. Style constants in `lib/styles.ts`: `MENU_POSITIONER_CLS` / `MENU_SUBMENU_POSITIONER_CLS` / `MENU_POPUP_CLS` / `MENU_ITEM_CLS` for menus, `POPOVER_POSITIONER_GLASS_CLS` / `POPOVER_POSITIONER_ELEVATED_CLS` / `POPOVER_POPUP_CLS` for popovers. All selectable-option dropdowns use `Menu.*` (not `Popover.*`) for proper ARIA roles and keyboard navigation. `Autocomplete.*` for searchable field pickers — use `Autocomplete.Collection` for filtered item rendering (not manual `.map()`), uncontrolled mode (`defaultValue`) to let the component own input state, and commit on `"item-press"` reason only. Base UI event reasons are kebab-case strings (e.g. `"item-press"`, `"input-change"`) — see `node_modules/@base-ui/react/utils/reason-parts.js`.

### No Navigation During Render

`router.push`/`router.replace` must be called from `useEffect`, never from the render body. Conditional redirects use a `shouldRedirect` flag checked by both the effect and the early return.

### Error Boundaries

Route-level (`app/error.tsx`, `app/build/[id]/error.tsx`) use `window.location.href` for navigation (not `router.push`) because React's tree is in an error state. All boundaries report to the server via `reportClientError()`.

## Theme

Dark "Violet Monochrome" — violet is the single non-semantic accent. CSS custom properties in `globals.css`:
- Backgrounds: `--nova-void` (#050510) → `--nova-elevated` (#1a1a3e)
- Text: `--nova-text` (#ededf4) → `--nova-text-muted` (#6b6b8a) — warm whites, no blue tint
- Brand accent: `--nova-violet` (#8b5cf6), `--nova-violet-bright` (#a78bfa) — used for all interactive chrome
- Semantic only: `--nova-emerald` (#86cebc, sage-mint), `--nova-amber` (#d4a76a, muted gold), `--nova-rose` (#d4708f, dusty mauve) — never decorative, only for success/warning/error states
- In-theme accent: `--nova-orchid` (#cda0d4, warm pink-purple) — from the xpath "lavender milk bath" palette, used for UI states that need distinction without semantic warning weight (e.g. impersonation banner)
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)
- Z-index scale (`globals.css`): 7 semantic tokens — `z-ground` → `z-raised` → `z-popover` → `z-popover-top` → `z-tooltip` → `z-modal` → `z-system`. Use Tailwind `z-{token}` classes, never hardcoded `z-{number}`. Dialogs and their backdrops use `z-modal`; toasts use `z-system` so they're visible over modals.
- Floating surface layers (`lib/styles.ts`): L1 (frosted glass, backdrop-blur) for primary panels, L2 (nearly opaque, no blur) for panels stacked above glass. Both menus and popovers have glass/elevated positioner variants. Animations use CSS `data-[starting-style]`/`data-[ending-style]` data attributes
- CodeMirror theme (`lib/codemirror/xpath-theme.ts`): "lavender milk bath" palette — all syntax colors in the purple/orchid family, differentiated by lightness and warmth, not by clashing hues

## Structured Output Constraint

The Anthropic schema compiler times out with >8 `.optional()` fields per array item. Use sentinel values (empty string, false) for required-but-sparse fields, post-process with `stripEmpty()`. Test with `npx tsx scripts/test-schema.ts`. All SA tool question schemas are derived from `questionFields` in `blueprint.ts` — never define question field schemas inline in tool definitions.

## Model Configuration

`lib/models.ts` is the single source of truth for model IDs, pricing, and the SA agent's model/reasoning config. Code constants, not user-configurable.

## CommCare Connect

**`connect_type` uses an enum** (`'learn' | 'deliver' | ''`), not a free string — `z.string()` with `strict: true` only enforces "any string" in JSON Schema, while the enum forces the model to pick a valid value.

**State stash** preserves form connect configs across app-level mode switches (learn ↔ deliver). `switchConnectMode()` stashes outgoing configs, records the last active mode, sets the new mode, and restores stashed configs. Passing `undefined` re-enables with the last active mode for toggle off/on cycles.

**Content-based sub-config assignment** for learn apps: educational content → `learn_module` only, quiz/test → `assessment` only, combined → both. Never add `learn_module` to a quiz-only form or `assessment` to a content-only form. The SA prompt enforces this.

**Sub-configs are independent.** Each has an optional `id` field (XForm wrapper element name, bind paths). IDs follow question ID rules (alphanumeric snake_case, starts with letter). Learn apps require at least one of `learn_module` or `assessment`. Deliver apps require at least one of `deliver_unit` or `task`. Both connect types follow the same pattern: independent sub-toggles that can be enabled/disabled individually.
