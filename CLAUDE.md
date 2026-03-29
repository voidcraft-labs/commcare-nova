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
- **Markdown**: marked — allowlist renderers in `lib/markdown.ts`, `breaks: true` (single newlines → `<br>`). `renderMarkdown` (chat): headings, bold, italic, lists, tables, hr, code; blocks links/images/HTML. `renderPreviewMarkdown` (preview): same plus links and images.
- **XML**: htmlparser2 + domutils + dom-serializer
- **Icons**: Coolicons (`@iconify-icons/ci`) + Tabler (`@iconify-icons/tabler`) via `@iconify/react`
- **Testing**: Vitest

## Commands

```bash
npm run dev          # Start dev server (Turbopack)
npm run build        # Production build
npm test             # Run tests (vitest)
npm run test:watch   # Watch mode tests
npx tsx scripts/test-schema.ts       # Test structured output schemas (requires ANTHROPIC_API_KEY)
npx tsx scripts/build-xpath-parser.ts # Rebuild Lezer parser from xpath.grammar
```

## Architecture

### Single Agent, Single Endpoint

`POST /api/chat` runs everything. One `ToolLoopAgent` — the **Solutions Architect (SA)** — converses with users, generates apps through tool calls, and edits them. All within one conversation context and one prompt-caching window. See `lib/services/CLAUDE.md` for the full tool inventory and build sequence.

### Key Classes

- **Builder** (`lib/services/builder.ts`) — singleton state machine shared via `useBuilder()`. Phases: `Idle → DataModel → Structure → Modules → Forms → Validate → Fix → Done | Error`. Holds a persistent `MutableBlueprint` instance. Exposes `subscribe` + `getSnapshot` for `useSyncExternalStore`.
- **MutableBlueprint** (`lib/services/mutableBlueprint.ts`) — single state container for the entire lifecycle. Progressive population during generation, in-place mutation during editing. Components call mutation methods directly, then `builder.notifyBlueprintChanged()`.
- **GenerationContext** (`lib/services/generationContext.ts`) — all LLM calls flow through here. Wraps Anthropic client + stream writer + RunLogger + PipelineConfig.

### Client-Server Data Flow

Server emits transient data parts → `useChat` `onData` callback → builder methods. `applyDataPart()` in `builder.ts` is the shared switch for both real-time streaming and log replay.

### React Patterns

- **External store subscription** — `useBuilder()` and `useFormEngine()` use `useSyncExternalStore` with versioned snapshots. No useState/useEffect for subscription. `getServerSnapshot` must return a **cached** (module-level) value — returning a new object each call causes infinite loops.
- **Ref callback cleanup** — DOM listeners (click-outside, Escape, ResizeObserver, MutationObserver, focusin) use React 19 ref callback cleanup instead of useEffect. `useDismissRef` hook for the common click-outside + Escape pattern.
- **Hydration-safe settings** — `useSettings()` uses `useSyncExternalStore` with `getServerSnapshot` (defaults) during SSR and hydration, then switches to `getSnapshot` (localStorage) after hydration. Never branch on `typeof window` during render — it creates hydration mismatches. Components render consistently with server defaults, then update post-hydration.
- **No navigation during render** — `router.push`/`router.replace` must be called from `useEffect`, never from the render body. Conditional redirects use a `shouldRedirect` flag checked by both the effect and the early return.
- **Error boundaries** — Route-level (`app/error.tsx`, `app/build/[id]/error.tsx`) and component-level (`ErrorBoundary` wrapping ChatSidebar, PreviewShell, ContextualEditor).

### Error Handling

End-to-end error system: API/stream errors are classified (`lib/services/errorClassifier.ts`), logged to run logs (`RunLogger.logError()`), emitted to the client as `data-error` parts, and surfaced via toast notifications (`lib/services/toastStore.ts` → `ToastContainer`). The signal grid has two error modes: `error-recovering` (reasoning with warm-hued cells) and `error-fatal` (flicker settling into dim rose-pink pulse). `GenerationProgress` shows which step failed with rose indicators. Builder has `errorSeverity` (`'recovering'` | `'failed'`) to distinguish retryable from fatal errors. The route handler uses a manual reader loop (not `writer.merge()`) so stream errors can be caught and emitted before the stream closes. Fallback: if the writer is broken, `useChat`'s error property fires a toast on the client.

### BYOAPI-Key

No auth layer. API key in `localStorage('nova-settings')`, sent per request via `useChat` body. Never server-persisted.

## Rules

### Icons

```tsx
import ciIconName from '@iconify-icons/ci/icon-name'
<Icon icon={ciIconName} width="16" height="16" />
```

Browse available: `node_modules/@iconify-icons/ci/` (one file per icon). No build plugin — pure ESM.

### Inputs

All `<input>` and `<textarea>` elements must include `autoComplete="off"` and `data-1p-ignore` to prevent browser autocomplete and 1Password autofill. Nothing on the site is a real login/signup form.

### Theme

Dark "Stellar Minimalism". CSS custom properties in `globals.css`:
- Backgrounds: `--nova-void` (#050510) → `--nova-elevated` (#1a1a3e)
- Text: `--nova-text` (#e8e8ff) → `--nova-text-muted` (#555577)
- Accents: `--nova-violet`, `--nova-cyan`, `--nova-emerald`, `--nova-amber`, `--nova-rose`
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)

### Structured Output Schemas

The Anthropic schema compiler times out with >8 `.optional()` fields per array item. Use sentinel values (empty string, false) for required-but-sparse fields, post-process with `stripEmpty()`. Test with `npx tsx scripts/test-schema.ts`. See `lib/schemas/CLAUDE.md` for the full constraint details.

### Model Configuration

`lib/models.ts` is the single source of truth for model IDs and pricing. Single pipeline stage: `solutionsArchitect` (the SA agent). Settings flow: `localStorage → useSettings() → useChat body → route.ts → GenerationContext.pipelineConfig`.

### Data Model

Question ID = case property name. Questions with `case_property_on: "<case_type>"` are saved to/loaded from that case type. When `case_property_on` matches the module's case type, it's a normal case property. When it names a different case type, the system auto-derives child case creation. The case name question must always have `id: "case_name"`. Questions are fully self-contained — all metadata (label, type, validation, options) lives on the question itself. `case_types` is a frozen generation-time artifact; `applyDefaults` bakes defaults into questions during `addQuestions`, after which `case_types` is never consulted again. Validation derives known case properties reactively by scanning questions.

Child case types declare `parent_type` and optional `relationship` (`'child'` | `'extension'`) on their case type definition. `deriveCaseConfig()` derives all form-level case wiring on-demand — primary case config, child case creation, repeat context — no form-level case fields stored. Case list columns are fully LLM-controlled — no auto-prepend or filtering by expander/compiler. Every case type must have its own module — child types with no follow-up workflow use `case_list_only: true` on their module (the expander sets `case_list.show` and label automatically).

### CommCare Connect

App-level `connect_type: 'learn' | 'deliver'` set during scaffolding. Individual forms opt in via `connect` config. The system auto-derives Connect field defaults — `entity_id`, `entity_name`, `assessment.user_score` (defaults to `100`), `learn_module`, `deliver_unit`, `task` — via `deriveConnectDefaults()` in `validateAndFix`. All fields are user-visible and editable in `FormSettingsPanel`; defaults are populated but never overwrite user-set values. The SA only needs to set `connect_type` on the scaffold and optionally `deliver_unit.name` or `learn_module` fields via `updateForm`. Connect apps set `auto_gps_capture: true` at the app level so HQ handles GPS capture during build. Connect XForm blocks use a two-level wrapper with `vellum:role` attributes (`ConnectLearnModule`, `ConnectAssessment`, `ConnectDeliverUnit`, `ConnectTask`) — without these, HQ treats them as plain hidden questions instead of Connect entities. UI: app-level settings in Tier 2 subheader (`AppConnectSettings`), form-level toggle + config in `FormSettingsPanel` (gear icon in FormScreen header).
