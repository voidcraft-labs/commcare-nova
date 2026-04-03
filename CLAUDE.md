# commcare nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (imported as `motion/react`, NOT `framer-motion`)
- **Drag & Drop**: `@dnd-kit/react` (`DragDropProvider`, `useSortable` from `@dnd-kit/react/sortable`, modifiers from `@dnd-kit/dom/modifiers`)
- **Validation**: Zod v4
- **AI**: Vercel AI SDK (`ai` + `@ai-sdk/react` + `@ai-sdk/anthropic`) — `ToolLoopAgent`, `createUIMessageStream`, `createAgentUIStream`, `useChat`, `generateText`, `streamText`, `Output.object()`
- **Rich Text**: TipTap 3 (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-mention`, `@tiptap/suggestion`, `@tiptap/extension-image`, `@tiptap/extension-table`) — WYSIWYG label editing with full CommCare markdown support (headings, bold, italic, strike, links, images, lists, code, blockquotes, hr, GFM tables) and inline reference chips
- **Markdown**: markdown-to-jsx — unified read-only renderer in `lib/markdown.tsx`. `ChatMarkdown` (chat): headings, bold, italic, lists, tables, hr, code; strips links/images/HTML via component overrides. `PreviewMarkdown` (preview): same plus links (`target="_blank"`) and images. Both support `breaks: true` semantics via custom `renderRule`. `withChipInjection` composes reference chip rendering on top of either variant. tiptap-markdown handles TipTap editor I/O (markdown ↔ ProseMirror) separately.
- **XML**: htmlparser2 + domutils + dom-serializer
- **Icons**: Coolicons (`@iconify-icons/ci`) + Tabler (`@iconify-icons/tabler`) via `@iconify/react/offline`
- **Auth**: Better Auth (stateless sessions, Google OAuth, `@dimagi.com` domain restriction)
- **Database**: Google Cloud Firestore (`@google-cloud/firestore`) — serverless NoSQL, subcollection hierarchy under `users/{email}`
- **Testing**: Vitest

## Commands

```bash
npm run dev          # Start dev server (Turbopack)
npm run build        # Production build
npm test             # Run tests (vitest)
npm run test:watch   # Watch mode tests
npx tsx scripts/test-schema.ts       # Test structured output schemas (reads ANTHROPIC_API_KEY from .env)
npx tsx scripts/build-xpath-parser.ts # Rebuild Lezer parser from xpath.grammar
```

## Deployment

Deployed to **Google Cloud Run** via Docker. `next.config.ts` uses `output: "standalone"` for a self-contained production build.

```bash
docker build -t commcare-nova .                    # Build image locally
docker run -p 8080:8080 commcare-nova              # Run locally
gcloud run deploy nova --source . --region <region> # Deploy to Cloud Run
```

## Architecture

### Single Agent, Single Endpoint

`POST /api/chat` runs everything. One `ToolLoopAgent` — the **Solutions Architect (SA)** — converses with users, generates apps through tool calls, and edits them. All within one conversation context and one prompt-caching window. See `lib/services/CLAUDE.md` for the full tool inventory and build sequence.

### Firestore Persistence (`lib/db/`)

Subcollection hierarchy keyed by `@dimagi.com` email:

- `users/{email}` → `UserDoc` — profile from Google OAuth, role
- `users/{email}/usage/{yyyy-mm}` → `UsageDoc` — monthly token/cost aggregation
- `users/{email}/projects/{projectId}` → `ProjectDoc` — full `AppBlueprint` as a Firestore map
- `users/{email}/projects/{projectId}/logs/{logId}` → `StoredEvent` — flat event stream (discriminated union: message/step/emission/error)

Zod schemas in `lib/db/types.ts` are the single source of truth — TypeScript types are derived via `z.infer`, and Firestore converters validate reads via `schema.parse()`. `lib/db/firestore.ts` exports a lazy singleton (`getDb()`) with `ignoreUndefinedProperties: true` (silently drops `undefined` values from writes — needed because `stripEmpty()` converts sentinel strings back to `undefined`), typed collection helpers (`collections.*`), and document reference helpers (`docs.*`). `lib/db/projects.ts` exports CRUD helpers (`createProject`, `completeProject`, `failProject`, `updateProject`, `loadProject`, `listProjects`). `listProjects` uses Firestore `select()` to fetch only denormalized summary fields — the blueprint is never read. Data is validated on write, not re-validated on read. `lib/db/logs.ts` exports log event helpers (`writeLogEvent`, `loadRunEvents`, `loadLatestRunId`). `lib/db/usage.ts` exports usage tracking helpers (`getMonthlyUsage`, `incrementUsage`, `getCurrentPeriod`, `MONTHLY_SPEND_CAP_USD`). `lib/db/users.ts` exports user CRUD helpers (`createUser`, `touchUser`, `isUserAdmin`, `getUser`, `listAllUsers`). ADC on Cloud Run, `gcloud auth application-default login` for local dev.

### Project Persistence

Authenticated users' projects are auto-saved to Firestore. Loading is a single document read — no replay needed.

- **Project creation:** The route handler creates the project document (`status: 'generating'`) at the start of the first request for new builds. Emits `data-project-saved` immediately so the client URL updates to `/build/{id}` before generation begins. Log events write to this project's subcollection from the start.
- **Completion:** On generation success, `validateApp` calls `completeProject` to update the existing project with the final blueprint and `status: 'complete'`.
- **Failure detection:** Two-layer system ensures failed projects never stay stuck in `generating`. Layer 1 (server catch): route handler catch blocks call `failProject()` with the classified error type — fire-and-forget, same pattern as `incrementUsage()`. Layer 2 (timeout inference): `listProjects()` checks `created_at` age — any project still `generating` after `MAX_GENERATION_MINUTES` (10 min, well above the 5 min `maxDuration` route timeout) is inferred as failed, returned as `status: 'error'`, and lazily persisted via `failProject()`. The `error_type` field on `ProjectDoc` stores the `ErrorType` string from the classifier (or `'internal'` for timeout-inferred failures).
- **Auto-save:** `useAutoSave` hook subscribes to `builder.subscribeMutation` and debounces edits (2s) to `PUT /api/projects/{id}`. Silent failure — best-effort.
- **Loading:** `BuilderLayout` fetches `GET /api/projects/{id}` on mount when `buildId !== 'new'`, then calls `builder.setDone()` to hydrate. If the project's `status !== 'complete'` (error or stale generating), redirects to `/builds` with a toast instead of attempting hydration.
- **Project list:** `/builds` page fetches `GET /api/projects` (denormalized summaries, no full blueprints). Complete projects are clickable. Replay button visible to admins only (log replay is admin-gated — see Admin Dashboard). Failed projects (`status: 'error'`) render as inert cards — muted opacity, "Generation failed" subtitle, no click-through, no replay. Shared `ProjectCard` component (`components/ui/ProjectCard.tsx`) handles card rendering with optional `href` (Link vs plain card) and optional `onReplay` (show/hide replay button). Used by both the builds page and admin user profile.
- **BYOK exclusion:** BYOK users have no session → no save, no project loading, no project list, no Firestore logging. Same ephemeral behavior as before.

### Event Logging (`lib/services/eventLogger.ts`)

A log is a flat, ordered stream of `StoredEvent` objects written to Firestore.

- **Firestore sink** (`enableFirestore`): One document per event at `users/{email}/projects/{projectId}/logs/`. Fire-and-forget writes — a Firestore outage never blocks generation.
- **Event types:** `StoredEvent` wraps a `LogEvent` discriminated union (four variants: `message`, `step`, `emission`, `error`). Each variant has exactly its own fields — no defaults, no sparse stripping, no unused fields.
- **Typed payloads:** Emission data and tool call args/outputs use `JsonValue` (recursive JSON type) instead of `unknown`. Guarantees serialization round-trip fidelity without losing type safety.
- **Tool results in logs:** `logStep` receives `tool_results` from the AI SDK's `onStepFinish` callback and matches them to tool calls by `toolCallId`. Every tool's return value (success or error) appears in the log's `output` field automatically — no manual `logToolOutput` plumbing needed.
- **Cost tracking:** Step events carry `TokenUsage` (model, tokens, cost). EventLogger accumulates request-level cost across all steps and flushes a single `incrementUsage` write in `finalize()`. The route registers `finalize()` on both `onFinish` (normal completion) and `req.signal.abort` (client disconnect) — a `_finalized` guard ensures exactly one write.
- **Replay:** `extractReplayStages()` consumes `StoredEvent[]` directly from Firestore. The project list page loads events via `GET /api/projects/{id}/logs`.

### Usage Tracking & Spend Cap (`lib/db/usage.ts`)

Per-user monthly spend tracking for authenticated users on the shared server key. BYOK users are uncapped and never touch usage documents.

- **Pre-request cap check:** The chat route reads `docs.usage(email, currentPeriod)` — a single O(1) Firestore document lookup by period string (e.g. `"2026-04"`). If `cost_estimate >= MONTHLY_SPEND_CAP_USD`, returns a 429 with a friendly message. Fails open on Firestore errors (logs to console, does not block generation).
- **Post-request cost flush:** EventLogger accumulates cost across all agent steps (outer step + inner tool sub-generations) in private fields. `finalize()` writes a single atomic `incrementUsage` call using `FieldValue.increment()` — concurrent-safe, creates the document automatically on the first request of a new month via `set({ merge: true })`.
- **Cancellation safety:** The route registers `logger.finalize()` on both `onFinish` (stream completion) and `req.signal.abort` (client disconnect). A `_finalized` idempotency guard ensures exactly one write regardless of which fires.
- **Cap configuration:** `MONTHLY_SPEND_CAP_USD` reads from env var, defaults to $30. Applies globally to all authenticated users.

### Key Classes

- **Builder** (`lib/services/builder.ts`) — singleton state machine shared via `useBuilder()`. Phases: `Idle → DataModel → Structure → Modules → Forms → Validate → Fix → Done | Error`. Holds a persistent `MutableBlueprint` instance. Exposes `subscribe` + `getSnapshot` for `useSyncExternalStore`. Tracks `projectId` for Firestore persistence.
- **MutableBlueprint** (`lib/services/mutableBlueprint.ts`) — single state container for the entire lifecycle. Progressive population during generation, in-place mutation during editing. Components call mutation methods directly, then `builder.notifyBlueprintChanged()`.
- **GenerationContext** (`lib/services/generationContext.ts`) — all LLM calls flow through here. Wraps Anthropic client + stream writer + EventLogger. Carries `session` (for Firestore saves) and `projectId` (for updating existing projects).

### Reference Chip System (`lib/references/`)

Hashtag references (`#form/question`, `#case/property`, `#user/property`) render as styled inline chips across three surfaces:

- **CodeMirror 6** — `xpathChips(provider)` extension in `lib/codemirror/xpath-chips.ts`. MatchDecorator + WidgetType with raw DOM via `chipDom.ts`. Backspace-to-revert deletes one char, exposing raw text and reopening autocomplete.
- **TipTap** — `commcareRef` atom node in `lib/tiptap/commcareRefNode.ts`, React NodeView via `CommcareRefView.tsx`. `#` trigger wired to `ReferenceProvider.search()` via `refSuggestion.ts`. On save, tiptap-markdown serializes chips as bare `#type/path` hashtags. On load, tiptap-markdown parses the markdown (hashtags pass through as plain text), then `hydrateHashtagRefs()` (`lib/tiptap/hydrateRefs.ts`) walks the ProseMirror document and promotes hashtag text into `commcareRef` atom nodes, preserving marks (bold, italic, etc.) from the source text for round-trip fidelity. `CommcareRefView` only renders a chip when `ReferenceProvider.resolve()` succeeds — unresolvable refs (typos, partial edits) render as plain muted text.
- **Preview canvas** — `LabelContent` (labels/hints) and `ExpressionContent` (calculate/default in HiddenField) render chips as React components. `LabelContent` uses the shared `previewMarkdownOptions()` from `lib/markdown.tsx` with `withChipInjection` to compose a chip-detecting `renderRule` that intercepts text nodes containing `#type/path` patterns and replaces them with `ReferenceChip` components directly — markdown handles all formatting natively. `resolveRefFromExpr` tries the provider for rich resolution (label, icon), falling back to pattern-based parsing when the provider can't resolve (e.g. no form selected, cross-form ref). Design mode shows chips; preview mode shows engine-resolved values. **Table key workaround:** `TABLE_KEY_OVERRIDES` in `lib/markdown.tsx` patches a markdown-to-jsx bug (keyless thead/tbody array children) via `createElement` spread — remove once [PR #859](https://github.com/quantizor/markdown-to-jsx/pull/859) lands and the package is bumped past 9.7.13.
- **Structure sidebar** — `AppTree` renders question labels with inline chips via the shared `textWithChips()` from `LabelContent.tsx`, passing `iconOverrides` (a per-form question icon map via `FormIconContext`) for correct question-type icons without depending on the ReferenceProvider. During search, falls back to `HighlightedText` for match highlighting.

**Type system:** `Reference` is a discriminated union — `FormReference` (path: `QuestionPath`), `CaseReference` (path: `string`), `UserReference` (path: `string`). Config per type in `config.ts` (icon, Tailwind classes for React, raw CSS for CM6 DOM).

**ReferenceProvider** (`provider.ts`) — unified search/resolve API. Caches form question entries and case properties; cache invalidated via `builder.subscribeMutation` (fires only on blueprint mutations and selection changes). `ReferenceProviderWrapper` in `ReferenceContext.tsx` provides the provider via React context; wraps `BuilderLayout`'s content area.

**Canonical format:** All internal label text uses bare `#type/path` hashtags. The export layer (`xformBuilder.ts`) converts these to CommCare's XML format at the boundary.

**Shared utilities:** `useSaveQuestion` hook (`hooks/useSaveQuestion.ts`) extracts the common question mutation + notify pattern used by all three contextual editor tabs. `splitOnPattern` in `renderLabel.ts` is the single regex-split implementation used by label parsing, expression parsing, and TipTap hydration. `HASHTAG_REF_PATTERN` in `config.ts` is the regex matching `#type/path` hashtags — used by `parseLabelSegments` (TipTap hydration, RefLabelInput, LabelContent renderRule, AppTree sidebar). `textWithChips` in `LabelContent.tsx` is the shared chip renderer — accepts an optional `iconOverrides` map to enrich form refs with question-type icons when rendering outside the ReferenceProvider context (e.g. structure sidebar).

### Client-Server Data Flow

Server emits transient data parts → `useChat` `onData` callback → builder methods. `applyDataPart()` in `builder.ts` is the shared switch for both real-time streaming and log replay.

### React Patterns

- **External store subscription** — `useBuilder()` and `useFormEngine()` use `useSyncExternalStore` with versioned snapshots. No useState/useEffect for subscription. `getServerSnapshot` must return a **cached** (module-level) value — returning a new object each call causes infinite loops.
- **Ref callback cleanup** — DOM listeners (click-outside, Escape, ResizeObserver, MutationObserver, focusin) use React 19 ref callback cleanup instead of useEffect. `useDismissRef` hook for the common click-outside + Escape pattern (inline dropdowns where the trigger is inside the container DOM).
- **Floating dropdowns** — `useFloatingDropdown` hook (`hooks/useFloatingDropdown.tsx`) encapsulates the full portal dropdown lifecycle: open/close state, FloatingUI positioning, entrance animation, trigger-aware dismiss (no race between click-outside and toggle), and optional content popover coordination. Generic `<T extends HTMLElement>` for typed trigger refs. `matchTriggerWidth` option uses FloatingUI's `size` middleware to apply the trigger's width as `min-width` on the floating element — use for form-field dropdowns (select menus) where the menu should match the input width. `DropdownPortal` component (same file) renders the `FloatingPortal` + positioned wrapper div — eliminates the repeated 5-line portal boilerplate from every consumer. Used by AccountMenu, FormSettingsButton, FormTypeButton, AfterSubmitSection, AppConnectSettings, and ContextualEditorUI type picker.
- **RSC with client leaves** — Pages are Server Components that render structure (headers, headings, cards, tables) and import small client components only for interactive elements (search inputs, sort controls, replay buttons, navigation buttons). Push `'use client'` as far down the tree as possible — don't wrap entire pages. Name components by what they do (`UserTable`, `ProjectList`, `NewBuildButton`), not by runtime (`*Client`). Colocate page-specific components next to their page in `app/` (e.g. `app/admin/user-table.tsx`, `app/builds/project-list.tsx`). Shared components stay in `components/ui/`.
- **Hydration-safe settings** — `useSettings()` uses `useSyncExternalStore` with `getServerSnapshot` (defaults) during SSR and hydration, then switches to `getSnapshot` (localStorage) after hydration. Never branch on `typeof window` during render — it creates hydration mismatches. Components render consistently with server defaults, then update post-hydration.
- **No navigation during render** — `router.push`/`router.replace` must be called from `useEffect`, never from the render body. Conditional redirects use a `shouldRedirect` flag checked by both the effect and the early return.
- **Error boundaries** — Route-level (`app/error.tsx`, `app/build/[id]/error.tsx`) and component-level (`ErrorBoundary` wrapping ChatSidebar, PreviewShell, ContextualEditor). Route-level error boundaries use `window.location.href` for navigation (not `router.push`) because React's tree is in an error state and can't handle client-side transitions.

### Error Handling

End-to-end error system: API/stream errors are classified (`lib/services/errorClassifier.ts`), logged to the event stream (`EventLogger.logError()`), emitted to the client as `data-error` parts, and surfaced via toast notifications (`lib/services/toastStore.ts` → `ToastContainer`). Error types: `api_auth`, `api_rate_limit`, `api_overloaded`, `api_timeout`, `api_server`, `model_error`, `stream_broken`, `spend_cap_exceeded`, `internal`. The `MESSAGES` record (exported from `errorClassifier.ts`) maps each type to a user-facing string. The signal grid has two error modes: `error-recovering` (reasoning with warm-hued cells) and `error-fatal` (flicker settling into dim rose-pink pulse). `GenerationProgress` shows which step failed with rose indicators. Builder has `errorSeverity` (`'recovering'` | `'failed'`) to distinguish retryable from fatal errors. The route handler uses a manual reader loop (not `writer.merge()`) so stream errors can be caught and emitted before the stream closes. Fallback: if the writer is broken, `useChat`'s error property fires a toast on the client. `parseApiErrorMessage()` in `lib/apiError.ts` extracts the `error` field from JSON error responses so toast messages are human-readable.

### Authentication & API Key Resolution

Dual-mode system supporting both authenticated (Google OAuth) and BYOK (bring your own key) access.

**Auth layer** — Better Auth with stateless JWT sessions (no database for auth). Google OAuth restricted to `@dimagi.com` emails via a `before` hook on the callback path. Server instance in `lib/auth.ts`, client in `lib/auth-client.ts`, route handler at `app/api/auth/[...all]/route.ts`.

**User provisioning** — Better Auth `after` hook on the callback path calls `createUser()` from `lib/db/users.ts` on every sign-in. `createUser` checks if the Firestore user doc exists: first sign-in creates it (with `role: 'user'` and `created_at`), subsequent sign-ins update mutable fields (`name`, `image`, `last_active_at`) without overwriting `role` or `created_at`. The chat route calls `touchUser()` (fire-and-forget) on every authenticated request to keep `last_active_at` current.

**Admin role** — `UserDoc.role` is `'user' | 'admin'`, managed exclusively via the Firestore console. Application code never writes the `role` field. The `customSession` plugin enriches the session with `isAdmin` by reading the Firestore role server-side — no extra client fetch. `useAuth()` exposes `isAdmin` directly from the session. Server-side: `requireAdmin()` in `lib/auth-utils.ts` calls `isUserAdmin()` from `lib/db/users.ts` and throws 403 if not admin.

**API key resolution** — `resolveApiKey()` in `lib/auth-utils.ts` is the single decision point, shared by all API routes:
1. Authenticated session exists → use `process.env.ANTHROPIC_API_KEY` (server key)
2. `apiKey` in request body → use that (BYOK)
3. Neither → 401

**Server-side auth (RSC)** — Protected pages use Server Components that call `auth.api.getSession({ headers: await headers() })` to check auth before rendering. Three RSC functions in `lib/auth-utils.ts`: `getSession()` (returns session or null), `requireAuth()` (redirects to `/` if no session), `requireAdminAccess()` (redirects to `/builds` if not admin). These are separate from the `req`-based functions used by API route handlers (`requireSession(req)`, `requireAdmin(req)`).

**Proxy layer** — `proxy.ts` (Next.js 16 convention, replaces middleware.ts) checks for the session cookie via `getSessionCookie()` from `better-auth/cookies`. Fast optimistic redirect — unauthenticated users hitting `/builds`, `/admin/*`, or `/settings` are redirected to `/` before the page JS downloads. Not a security boundary — RSC does the real auth check.

**Page architecture** — Protected pages are Server Components that handle auth, fetch data, and render structure. Interactive leaves are small colocated client components. All pages use `PageHeader` (`components/ui/PageHeader.tsx`) — a server component that renders the logo, optional back arrow + breadcrumb, and `HeaderNav` (client leaf). Pages: `/` (RSC redirects authenticated → `/builds`, `app/landing.tsx` handles BYOK + sign-in), `/builds` (RSC fetches projects, "New Build" button in page content), `/settings` (RSC resolves auth, `api-key-editor.tsx` handles key input), `/admin` (RSC layout gate + `stat-card.tsx` server-rendered, `user-table.tsx` handles sorting/search), `/admin/users/[email]` (RSC renders profile card + usage table with back arrow + breadcrumb).

**Unified header** — `PageHeader` (server component, `components/ui/PageHeader.tsx`) renders the consistent header across all pages: `[back?] [Logo] [breadcrumb?] ... [Projects] [Admin?] [AccountMenu]`. `HeaderNav` (`components/ui/HeaderNav.tsx`, client component) renders the right-side nav links with active state via `usePathname()` and `AccountMenu`. Nav items are a fixed set defined in `HeaderNav`: Projects (`/builds`, folder icon) and Admin (`/admin`, user-shield icon, admin-only). Active state uses pathname prefix matching. `isAdmin` flows as a prop from server pages (where the session is already resolved) to avoid client session fetches and hydration flicker. BuilderLayout imports `HeaderNav` directly for its collapsible header and centered-mode overlay.

**Client-side auth** — `useAuth()` hook wraps Better Auth's `useSession` with `customSessionClient` for type-safe access to `isAdmin`. Returns `{ user, isAuthenticated, isAdmin, isPending, signIn, signOut }`. Used only in client components that need reactive auth state (BuilderLayout, AccountMenu, landing page sign-in). NOT used for page-level auth gates — those use RSC.

**Landing page** — Server component redirects authenticated users to `/builds`. Client component handles Google sign-in button (primary) + API key input (secondary). BYOK users with a saved key are redirected to `/build/new` client-side (requires localStorage).

**Account menu** — `AccountMenu` (`components/ui/AccountMenu.tsx`) is the rightmost element in every header. Authenticated users see an avatar trigger that opens a `POPOVER_GLASS` dropdown (via `useFloatingDropdown` + `DropdownPortal`) with profile info, monthly usage progress bar (`GET /api/user/usage`), Settings link, and Sign Out. BYOK users see a plain settings gear link to `/settings`.

**Settings page** — API key field (becomes "API Key Override" for authenticated users). Header rendered by `PageHeader` with back arrow (→ `/builds` for authenticated, → `/` for BYOK) and "Settings" breadcrumb. Auth status resolved server-side and passed as prop. Account info and sign-out live in the AccountMenu dropdown, not on this page.

### Admin Dashboard

Admin-only dashboard at `/admin` for org-wide visibility into usage and user activity. Protected by `app/admin/layout.tsx` — an async Server Component that calls `requireAdminAccess()` to check `isAdmin` on the session and redirects non-admins before any HTML is sent. All pages under `/admin/*` inherit this gate and can assume admin access without self-gating. Server-side: all admin API routes use `requireAdmin()` from `lib/auth-utils.ts`.

- **Dashboard page** (`/admin`): Headline stat cards (total users, generations this month, total spend) + sortable user table via `@tanstack/react-table` with live search. Columns: user (avatar + name), email, role, projects, generations, spend, last active. Click a row → user profile. Table supports keyboard navigation (`tabIndex`, `role="link"`, Enter/Space).
- **User profile** (`/admin/users/[email]`): User info card, all-time usage history table (per-month breakdown), and project list with replay buttons. Replay uses the shared `useReplay` hook with the admin log endpoint.
- **Admin API routes** (`/api/admin/*`): All use `requireAdmin()`. `GET /api/admin/users` returns user list + headline stats (iterates users, fetches current month usage + project count per user in parallel). `GET /api/admin/users/[email]` returns user detail + all-time usage + projects. `GET /api/admin/users/[email]/projects/[projectId]/logs` returns log events for admin replay.
- **Log replay gating**: All Firestore-based replay is admin-only. The user-facing logs endpoint (`GET /api/projects/[id]/logs`) uses `requireAdmin`. The replay button on `/builds` is hidden for non-admins (`onReplay={isAdmin ? handleReplay : undefined}`).
- **Shared utilities**: `ProjectCard` component, `useReplay` hook, `STATUS_STYLES` constant, `formatRelativeDate`/`formatCurrency`/`formatTokenCount`/`formatPeriodLabel` in `lib/utils/format.ts`.

## Rules

### Icons

```tsx
import { Icon } from '@iconify/react/offline'
import ciIconName from '@iconify-icons/ci/icon-name'
<Icon icon={ciIconName} width="16" height="16" />
```

**Always import from `@iconify/react/offline`**, never `@iconify/react`. The default export uses `useState` + `useEffect` for hydration safety, which renders an empty `<span>` for 1–3 frames before swapping in the SVG. The `/offline` export renders synchronously on the first frame. Browse available: `node_modules/@iconify-icons/ci/` (one file per icon). No build plugin — pure ESM.

### Inputs

All `<input>` and `<textarea>` elements must include `autoComplete="off"` and `data-1p-ignore` to prevent browser autocomplete and 1Password autofill. The Google OAuth sign-in is handled externally by Better Auth — no credential inputs on our pages.

### Theme

Dark "Stellar Minimalism". CSS custom properties in `globals.css`:
- Backgrounds: `--nova-void` (#050510) → `--nova-elevated` (#1a1a3e)
- Text: `--nova-text` (#e8e8ff) → `--nova-text-muted` (#555577)
- Accents: `--nova-violet`, `--nova-cyan`, `--nova-emerald`, `--nova-amber`, `--nova-rose`
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)
- Popover layers (`lib/styles.ts`): `POPOVER_GLASS` (L1, frosted glass with bright inset border) for base-layer floating panels, `POPOVER_ELEVATED` (L2, nearly opaque) for popovers stacked above glass. Both share a 1px inner highlight (`inset box-shadow`) that catches light. `NAV_ICON_CLASS` (icon-only button styling, used by PageHeader back arrow and AccountMenu BYOK fallback) also lives here.
- Popover entrance animation (`lib/animations.ts`): `POPOVER_ENTER_KEYFRAMES` + `POPOVER_ENTER_OPTIONS` — shared Web Animations API config. Consumed internally by `useFloatingDropdown` for all portal-based dropdowns and by `ExportDropdown`'s inline AnimatePresence (same values in Motion config format).

### Structured Output Schemas

The Anthropic schema compiler times out with >8 `.optional()` fields per array item. Use sentinel values (empty string, false) for required-but-sparse fields, post-process with `stripEmpty()`. Test with `npx tsx scripts/test-schema.ts`. See `lib/schemas/CLAUDE.md` for the full constraint details.

All SA tool question schemas are derived from `questionFields` in `blueprint.ts` — see `lib/schemas/toolSchemas.ts`. Field descriptions come from `QUESTION_DOCS` (also in `blueprint.ts`). Never define question field schemas inline in tool definitions.

### Model Configuration

`lib/models.ts` is the single source of truth for model IDs, pricing, and the SA agent's model/reasoning config (`SA_MODEL`, `SA_REASONING`). These are code constants — not user-configurable. To change the model, update `lib/models.ts` and deploy.

### Data Model

Question ID = case property name. Questions with `case_property_on: "<case_type>"` are saved to/loaded from that case type. When `case_property_on` matches the module's case type, it's a normal case property. When it names a different case type, the system auto-derives child case creation. The case name question must always have `id: "case_name"`. Questions are fully self-contained — all metadata (label, type, validation, options) lives on the question itself. `case_types` is a frozen generation-time artifact; `applyDefaults` bakes defaults into questions during `addQuestions`, after which `case_types` is never consulted again. Validation derives known case properties reactively by scanning questions.

Child case types declare `parent_type` and optional `relationship` (`'child'` | `'extension'`) on their case type definition. `deriveCaseConfig()` derives all form-level case wiring on-demand — primary case config, child case creation, repeat context — no form-level case fields stored. Case list columns are fully LLM-controlled — no auto-prepend or filtering by expander/compiler. Every case type must have its own module — child types with no follow-up workflow use `case_list_only: true` on their module (the expander sets `case_list.show` and label automatically).

### Post-Submit Navigation

`post_submit` on forms controls where the user goes after submission. Three user-facing choices: `default` (App Home), `module` (This Module), `previous` (Previous Screen). Two internal-only values for CommCare export fidelity: `root` (auto-resolved when `put_in_root` is modeled) and `parent_module` (auto-resolved when nested modules are modeled). `form_links` on forms enables conditional navigation to other forms/modules — fully validated (target existence, cycles, fallback) but not yet exposed in SA tools or UI. Session module (`commcare/session.ts`) derives all suite.xml stack operations. See `lib/services/CLAUDE.md` "Session & Navigation" for the complete edge case and gap inventory, including `put_in_root` impact.

### CommCare Connect

App-level `connect_type: 'learn' | 'deliver'` set during scaffolding. Individual forms opt in via `connect` config. `deriveConnectDefaults()` in `validateAndFix` fills defaults for sub-configs that are present — it never auto-creates sub-configs. All fields are user-visible and editable in `FormSettingsPanel`; defaults are populated but never overwrite user-set values. The SA sets `connect_type` on the scaffold and sets `learn_module` and/or `assessment` per form based on content. Connect apps set `auto_gps_capture: true` at the app level so HQ handles GPS capture during build. Connect XForm blocks use a two-level wrapper with `vellum:role` attributes (`ConnectLearnModule`, `ConnectAssessment`, `ConnectDeliverUnit`, `ConnectTask`) — without these, HQ treats them as plain hidden questions instead of Connect entities.

**Learn apps: content-based sub-config assignment.** In production, learn modules and assessments are often in separate forms. The SA matches sub-configs to form content: a form with educational content gets `learn_module` only, a quiz/test form gets `assessment` only, a combined form gets both. The SA prompt and tool schema descriptions enforce this — never add `learn_module` to a quiz-only form or `assessment` to a content-only form.

**Connect sub-configs are independent.** Each has an optional `id` field that becomes the XForm element ID (wrapper tag name + inner `id` attribute + bind paths). IDs must follow question ID rules (alphanumeric snake_case, starts with letter). Default IDs: module ID = `toSnakeId(moduleName)`, assessment/task ID = `toSnakeId(moduleName)_toSnakeId(formName)`. All four sub-configs — `learn_module`, `assessment`, `deliver_unit`, `task` — are independently optional. Learn apps require at least one of `learn_module` or `assessment`. Deliver apps require `deliver_unit`. `task` is always optional.

**Connect state stash.** `MutableBlueprint` maintains a per-mode stash (`Map<number, Map<number, ConnectConfig>>`) that preserves form connect configs across app-level mode switches (learn ↔ deliver). `switchConnectMode(type | null | undefined)` is the single entry point for all app-level connect state changes — it stashes the outgoing mode's form configs, records the last active mode, sets the new mode, and restores its stashed configs. Passing `undefined` re-enables with the last active mode (for toggle off/on cycles); the mode is captured from the blueprint at toggle-off time so it works regardless of how `connect_type` was originally set (scaffold, replay, edit). Form-level toggles use `stashFormConnect`/`getFormConnectStash` for per-form preservation.

**UI structure.** App-level settings in Tier 2 subheader (`AppConnectSettings`). Form-level settings in `FormSettingsPanel` (gear icon in FormScreen header). Learn mode: two independent sub-toggle cards (Learn Module, Assessment), each with configurable ID + fields. Deliver mode: name + unit fields + Task sub-toggle card. Sub-toggles use `Toggle variant="sub"` (smaller, cyan). Default IDs derived via `toSnakeId()` from `commcare/validate.ts`.
