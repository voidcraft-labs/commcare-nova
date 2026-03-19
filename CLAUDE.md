# CommCare Nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (imported as `motion/react`, NOT `framer-motion`)
- **Drag & Drop**: `@dnd-kit/react` (`DragDropProvider`, `useSortable` from `@dnd-kit/react/sortable`, modifiers from `@dnd-kit/dom/modifiers`)
- **Validation**: Zod v4
- **AI**: Vercel AI SDK (`ai` + `@ai-sdk/react` + `@ai-sdk/anthropic`) — `ToolLoopAgent`, `createUIMessageStream`, `createAgentUIStream`, `useChat`, `generateText`, `streamText`, `Output.object()`
- **Markdown**: marked — allowlist renderers in `lib/markdown.ts`. `renderMarkdown` (chat): headings, bold, italic, lists, tables, hr, code; blocks links/images/HTML. `renderPreviewMarkdown` (preview): same plus links and images.
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
- **Render-phase initialization** — `useSettings()` reads localStorage synchronously via render-phase state update (not useEffect) to avoid flash of null on client.
- **No navigation during render** — `router.push`/`router.replace` must be called from `useEffect`, never from the render body. Conditional redirects use a `shouldRedirect` flag checked by both the effect and the early return.
- **Error boundaries** — Route-level (`app/error.tsx`, `app/build/[id]/error.tsx`) and component-level (`ErrorBoundary` wrapping ChatSidebar, PreviewShell, DetailPanel).

### BYOAPI-Key

No auth layer. API key in `localStorage('nova-settings')`, sent per request via `useChat` body. Never server-persisted.

## Rules

### Icons

```tsx
import ciIconName from '@iconify-icons/ci/icon-name'
<Icon icon={ciIconName} width="16" height="16" />
```

Browse available: `node_modules/@iconify-icons/ci/` (one file per icon). No build plugin — pure ESM.

### Theme

Dark "Stellar Minimalism". CSS custom properties in `globals.css`:
- Backgrounds: `--nova-void` (#050510) → `--nova-elevated` (#1a1a3e)
- Text: `--nova-text` (#e8e8ff) → `--nova-text-muted` (#555577)
- Accents: `--nova-violet`, `--nova-cyan`, `--nova-emerald`, `--nova-amber`, `--nova-rose`
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)

### Structured Output Schemas

The Anthropic schema compiler times out with >8 `.optional()` fields per array item. Use sentinel values (empty string, false) for required-but-sparse fields, post-process with `stripEmpty()`. Test with `npx tsx scripts/test-schema.ts`. See `lib/schemas/CLAUDE.md` for the full constraint details.

### Model Configuration

`lib/models.ts` is the single source of truth for model IDs and pricing. Pipeline stages read from `ctx.pipelineConfig` — never hardcode model IDs. Settings flow: `localStorage → useSettings() → useChat body → route.ts → GenerationContext.pipelineConfig`.

### Data Model

Case properties are the source of truth for shared question metadata (label, type, hint, help, required, constraint, options). Questions are sparse — only carry overrides when mapped via `case_property`. Defaults merged at assembly time (`contentProcessing.ts`) and expansion time (`hqJsonExpander.ts`).

Each question has `case_property` + `is_case_name`. `deriveCaseConfig()` derives form-level case wiring on-demand — no form-level case fields stored. Case list columns are fully LLM-controlled — no auto-prepend or filtering by expander/compiler.
