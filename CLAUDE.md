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

## Architecture

### Single Agent, Single Endpoint

`POST /api/chat` runs everything. One `ToolLoopAgent` — the **Solutions Architect (SA)** — converses with users, generates apps through tool calls, and edits them. All within one conversation context and one prompt-caching window. See `lib/services/CLAUDE.md` for the full tool inventory and build sequence.

### Key Classes

- **Builder** (`lib/services/builder.ts`) — singleton state machine shared via `useBuilder()`. Phases: `Idle → DataModel → Structure → Modules → Forms → Validate → Fix → Done | Error`. Holds a persistent `MutableBlueprint` instance. Exposes `subscribe` + `getSnapshot` for `useSyncExternalStore`.
- **MutableBlueprint** (`lib/services/mutableBlueprint.ts`) — single state container for the entire lifecycle. Progressive population during generation, in-place mutation during editing. Components call mutation methods directly, then `builder.notifyBlueprintChanged()`.
- **GenerationContext** (`lib/services/generationContext.ts`) — all LLM calls flow through here. Wraps Anthropic client + stream writer + RunLogger + PipelineConfig.

### Reference Chip System (`lib/references/`)

Hashtag references (`#form/question`, `#case/property`, `#user/property`) render as styled inline chips across three surfaces:

- **CodeMirror 6** — `xpathChips(provider)` extension in `lib/codemirror/xpath-chips.ts`. MatchDecorator + WidgetType with raw DOM via `chipDom.ts`. Backspace-to-revert deletes one char, exposing raw text and reopening autocomplete.
- **TipTap** — `commcareRef` atom node in `lib/tiptap/commcareRefNode.ts`, React NodeView via `CommcareRefView.tsx`. `#` trigger wired to `ReferenceProvider.search()` via `refSuggestion.ts`. On save, tiptap-markdown serializes chips as bare `#type/path` hashtags. On load, tiptap-markdown parses the markdown (hashtags pass through as plain text), then `hydrateHashtagRefs()` (`lib/tiptap/hydrateRefs.ts`) walks the ProseMirror document and promotes hashtag text into `commcareRef` atom nodes, preserving marks (bold, italic, etc.) from the source text for round-trip fidelity. `CommcareRefView` only renders a chip when `ReferenceProvider.resolve()` succeeds — unresolvable refs (typos, partial edits) render as plain muted text.
- **Preview canvas** — `LabelContent` (labels/hints) and `ExpressionContent` (calculate/default in HiddenField) render chips as React components. `LabelContent` uses the shared `previewMarkdownOptions()` from `lib/markdown.tsx` with `withChipInjection` to compose a chip-detecting `renderRule` that intercepts text nodes containing `#type/path` patterns and replaces them with `ReferenceChip` components directly — markdown handles all formatting natively. `resolveRefFromExpr` tries the provider for rich resolution (label, icon), falling back to pattern-based parsing when the provider can't resolve (e.g. no form selected, cross-form ref). Design mode shows chips; preview mode shows engine-resolved values. **Table key workaround:** `TABLE_KEY_OVERRIDES` in `lib/markdown.tsx` patches a markdown-to-jsx bug (keyless thead/tbody array children) via `createElement` spread — remove once [PR #859](https://github.com/quantizor/markdown-to-jsx/pull/859) lands and the package is bumped past 9.7.13.
- **Structure sidebar** — `AppTree` renders question labels with inline chips via the shared `textWithChips()` function from `LabelContent.tsx`. Uses `useReferenceProvider()` for resolution. During search, falls back to `HighlightedText` for match highlighting.

**Type system:** `Reference` is a discriminated union — `FormReference` (path: `QuestionPath`), `CaseReference` (path: `string`), `UserReference` (path: `string`). Config per type in `config.ts` (icon, Tailwind classes for React, raw CSS for CM6 DOM).

**ReferenceProvider** (`provider.ts`) — unified search/resolve API. Caches form question entries and case properties; cache invalidated via `builder.subscribeMutation` (fires only on blueprint mutations and selection changes). `ReferenceProviderWrapper` in `ReferenceContext.tsx` provides the provider via React context; wraps `BuilderLayout`'s content area.

**Canonical format:** All internal label text uses bare `#type/path` hashtags. The export layer (`xformBuilder.ts`) converts these to CommCare's XML format at the boundary.

**Shared utilities:** `useSaveQuestion` hook (`hooks/useSaveQuestion.ts`) extracts the common question mutation + notify pattern used by all three contextual editor tabs. `splitOnPattern` in `renderLabel.ts` is the single regex-split implementation used by label parsing, expression parsing, and TipTap hydration. `HASHTAG_REF_PATTERN` in `config.ts` is the regex matching `#type/path` hashtags — used by `parseLabelSegments` (TipTap hydration, RefLabelInput, LabelContent renderRule, AppTree sidebar). `textWithChips` in `LabelContent.tsx` is the shared chip renderer used by both the markdown-based LabelContent and the lightweight AppTree sidebar.

### Client-Server Data Flow

Server emits transient data parts → `useChat` `onData` callback → builder methods. `applyDataPart()` in `builder.ts` is the shared switch for both real-time streaming and log replay.

### React Patterns

- **External store subscription** — `useBuilder()` and `useFormEngine()` use `useSyncExternalStore` with versioned snapshots. No useState/useEffect for subscription. `getServerSnapshot` must return a **cached** (module-level) value — returning a new object each call causes infinite loops.
- **Ref callback cleanup** — DOM listeners (click-outside, Escape, ResizeObserver, MutationObserver, focusin) use React 19 ref callback cleanup instead of useEffect. `useDismissRef` hook for the common click-outside + Escape pattern.
- **Hydration-safe settings** — `useSettings()` uses `useSyncExternalStore` with `getServerSnapshot` (defaults) during SSR and hydration, then switches to `getSnapshot` (localStorage) after hydration. Never branch on `typeof window` during render — it creates hydration mismatches. Components render consistently with server defaults, then update post-hydration.
- **No navigation during render** — `router.push`/`router.replace` must be called from `useEffect`, never from the render body. Conditional redirects use a `shouldRedirect` flag checked by both the effect and the early return.
- **Error boundaries** — Route-level (`app/error.tsx`, `app/build/[id]/error.tsx`) and component-level (`ErrorBoundary` wrapping ChatSidebar, PreviewShell, ContextualEditor). Route-level error boundaries use `window.location.href` for navigation (not `router.push`) because React's tree is in an error state and can't handle client-side transitions.

### Error Handling

End-to-end error system: API/stream errors are classified (`lib/services/errorClassifier.ts`), logged to run logs (`RunLogger.logError()`), emitted to the client as `data-error` parts, and surfaced via toast notifications (`lib/services/toastStore.ts` → `ToastContainer`). The signal grid has two error modes: `error-recovering` (reasoning with warm-hued cells) and `error-fatal` (flicker settling into dim rose-pink pulse). `GenerationProgress` shows which step failed with rose indicators. Builder has `errorSeverity` (`'recovering'` | `'failed'`) to distinguish retryable from fatal errors. The route handler uses a manual reader loop (not `writer.merge()`) so stream errors can be caught and emitted before the stream closes. Fallback: if the writer is broken, `useChat`'s error property fires a toast on the client.

### BYOAPI-Key

No auth layer. API key in `localStorage('nova-settings')`, sent per request via `useChat` body. Never server-persisted.

## Rules

### Icons

```tsx
import { Icon } from '@iconify/react/offline'
import ciIconName from '@iconify-icons/ci/icon-name'
<Icon icon={ciIconName} width="16" height="16" />
```

**Always import from `@iconify/react/offline`**, never `@iconify/react`. The default export uses `useState` + `useEffect` for hydration safety, which renders an empty `<span>` for 1–3 frames before swapping in the SVG. The `/offline` export renders synchronously on the first frame. Browse available: `node_modules/@iconify-icons/ci/` (one file per icon). No build plugin — pure ESM.

### Inputs

All `<input>` and `<textarea>` elements must include `autoComplete="off"` and `data-1p-ignore` to prevent browser autocomplete and 1Password autofill. Nothing on the site is a real login/signup form.

### Theme

Dark "Stellar Minimalism". CSS custom properties in `globals.css`:
- Backgrounds: `--nova-void` (#050510) → `--nova-elevated` (#1a1a3e)
- Text: `--nova-text` (#e8e8ff) → `--nova-text-muted` (#555577)
- Accents: `--nova-violet`, `--nova-cyan`, `--nova-emerald`, `--nova-amber`, `--nova-rose`
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)
- Popover layers (`lib/styles.ts`): `POPOVER_GLASS` (L1, frosted glass with bright inset border) for base-layer floating panels, `POPOVER_ELEVATED` (L2, nearly opaque) for popovers stacked above glass. Both share a 1px inner highlight (`inset box-shadow`) that catches light.

### Structured Output Schemas

The Anthropic schema compiler times out with >8 `.optional()` fields per array item. Use sentinel values (empty string, false) for required-but-sparse fields, post-process with `stripEmpty()`. Test with `npx tsx scripts/test-schema.ts`. See `lib/schemas/CLAUDE.md` for the full constraint details.

All SA tool question schemas are derived from `questionFields` in `blueprint.ts` — see `lib/schemas/toolSchemas.ts`. Field descriptions come from `QUESTION_DOCS` (also in `blueprint.ts`). Never define question field schemas inline in tool definitions.

### Model Configuration

`lib/models.ts` is the single source of truth for model IDs and pricing. Single pipeline stage: `solutionsArchitect` (the SA agent). Settings flow: `localStorage → useSettings() → useChat body → route.ts → GenerationContext.pipelineConfig`.

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
