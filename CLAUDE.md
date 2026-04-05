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
- **Auth**: Better Auth (Firestore-backed sessions via `better-auth-firestore`, Google OAuth — domain restriction enforced by GCP OAuth consent screen, not application code)
- **Database**: Google Cloud Firestore (`@google-cloud/firestore`) — app data in subcollection hierarchy under `users/{email}`, auth state in `auth_*` collections managed by Better Auth
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

### Unified Root Route

`/` renders the app list for authenticated users and the sign-in landing for unauthenticated users — same route, server-side conditional. The header hides via `isAuthenticated` prop, not pathname. `/build/[id]` is the builder (auth-gated by `app/build/layout.tsx`). No `/apps` route — the domain *is* the namespace.

### Fail-Closed Persistence

The route handler creates the Firestore app document (`status: 'generating'`) **before** generation starts — if Firestore is down, the request returns 503 rather than generating an app that can't be saved. Two-layer failure detection ensures apps never stay stuck in `generating`: (1) route handler catch blocks call `failApp()` fire-and-forget, (2) `listApps()` infers failure for any app still `generating` after 10 minutes (well above the 5-min route timeout). Layer 2 exists because Cloud Run can kill processes before catch blocks run (OOM, platform restart).

### Manual Stream Reader Loop

The chat route uses a manual reader loop instead of `writer.merge()` so stream errors can be caught and emitted as `data-error` parts before the stream closes. If the writer is already broken, the error still lands in the Firestore event log, and `useChat`'s error property fires on the client as a fallback.

### Controlled Drag State (No OptimisticSortingPlugin)

Question reordering uses the controlled state pattern: `onDragOver` → `move(itemsMap, event)` → React state → re-render. `useSortable` passes `plugins: []` to disable the default `OptimisticSortingPlugin` — the plugin independently reorders DOM elements and mutates sortable indices, conflicting with React's reconciliation. Do not remove `plugins: []`.

`InlineSettingsPanel` renders as a **sibling** of the sortable element (`<div ref={ref}>`), not inside it. If the panel were a child, its expanded height would inflate the sortable's collision shape, breaking group droppable detection on subsequent drags. `RestrictToElement` targets `[data-preview-scroll-container]` (the visible editor viewport).

`RepeatField` renders a **single template instance** in edit mode — all repeat instances share the same question schema, so rendering N copies creates duplicate `useSortable` IDs that corrupt dnd-kit state. Preview mode renders all instances normally (no `DragDropProvider` in preview, so hooks are no-ops).

### Firestore Configuration

`ignoreUndefinedProperties: true` on the Firestore instance because `stripEmpty()` converts sentinel strings back to `undefined` during post-processing — without this flag, Firestore would throw on any write containing `undefined` values.

## Data Model Decisions

**Questions are self-contained.** All metadata (label, type, validation, options, case_property_on) lives on the question itself. `case_types` is a frozen generation-time artifact — `applyDefaults()` bakes case property defaults into questions during `addQuestions`, after which `case_types` is never consulted again.

**Question ID = case property name.** Questions with `case_property_on: "<case_type>"` save to that case type. When it matches the module's case type, it's a normal property. When it names a different type, child case creation is auto-derived.

**`deriveCaseConfig()` is on-demand.** Form-level case wiring (primary config, child creation, repeat context) is derived by scanning questions — never stored on the form. Called by the expander and validator.

**`QuestionPath` is a branded string type** (`questionPath.ts`). Slash-delimited tree path like `"group1/child_q"`. Always built via `qpath(id, parent?)`, never by string concatenation.

**Case list columns are fully LLM-controlled** — no auto-prepend or filtering by the expander or compiler.

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

### External Store Pattern

`useBuilder()` and `useFormEngine()` use `useSyncExternalStore`. `getServerSnapshot` must return a **cached** module-level value — returning a new object each call causes infinite loops. `useBuilderInstance()` reads the same context without subscribing — use when a component only needs imperative methods and doesn't read reactive state.

### Ref Callback Cleanup

DOM listeners (click-outside, Escape, ResizeObserver, MutationObserver, focusin) use React 19 ref callback cleanup instead of useEffect. `useDismissRef` hook for the common click-outside + Escape pattern.

### Floating Dropdowns

`useFloatingDropdown` hook (`hooks/useFloatingDropdown.tsx`) encapsulates the full portal dropdown lifecycle: open/close, FloatingUI positioning, entrance animation, trigger-aware dismiss, and content popover coordination. `DropdownPortal` component renders the portal wrapper. `matchTriggerWidth` option for select-style menus.

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
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)
- Popover layers (`lib/styles.ts`): `POPOVER_GLASS` (L1, frosted glass) for base-layer panels, `POPOVER_ELEVATED` (L2, nearly opaque) for stacked popovers
- Animation constants (`lib/animations.ts`): `EASE` curve tuple, `POPOVER_ENTER_KEYFRAMES` + `POPOVER_ENTER_OPTIONS` for Web Animations API
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
