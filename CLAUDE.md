# commcare nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (import from `motion/react`, NOT `framer-motion`)
- **Drag & Drop**: `@dnd-kit/react` — `DragDropProvider`, `useSortable` from `@dnd-kit/react/sortable`, modifiers from `@dnd-kit/dom/modifiers`
- **Validation**: Zod v4
- **AI**: Vercel AI SDK (`ai` + `@ai-sdk/react` + `@ai-sdk/anthropic`) — `ToolLoopAgent`, `createUIMessageStream`, `useChat`, `generateText`, `streamText`, `Output.object()`
- **Rich Text**: TipTap 3 (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-mention`, `@tiptap/suggestion`, `@tiptap/extension-image`, `@tiptap/extension-table`)
- **Markdown**: markdown-to-jsx (read-only rendering in `lib/markdown.tsx`); tiptap-markdown handles TipTap editor I/O separately
- **XML**: htmlparser2 + domutils + dom-serializer
- **Icons**: Coolicons (`@iconify-icons/ci`) + Tabler (`@iconify-icons/tabler`) via `@iconify/react/offline`
- **Auth**: Better Auth (Firestore-backed sessions via `better-auth-firestore`, Google OAuth — domain restriction enforced by GCP OAuth consent screen, not application code)
- **Database**: Google Cloud Firestore (`@google-cloud/firestore`) — app data in subcollection hierarchy under `users/{email}`, auth state in `auth_*` collections managed by Better Auth
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

Deployed to **Google Cloud Run** via Docker. `next.config.ts` uses `output: "standalone"`.

```bash
docker build -t commcare-nova .
docker run -p 8080:8080 commcare-nova
gcloud run deploy nova --source . --region <region>
```

## Architecture Decisions

### Single Agent, Single Endpoint

`POST /api/chat` runs everything. One `ToolLoopAgent` (the **Solutions Architect / SA**) converses with users, generates apps through tool calls, and edits them. Why: one conversation context means one prompt-caching window — the SA has full memory of every design decision it made. No orchestration layer, no sub-agents, no routing. See `lib/services/CLAUDE.md` for tool inventory and build sequence.

### Fail-Closed Persistence

The route handler creates the Firestore project document (`status: 'generating'`) **before** generation starts — if Firestore is down, the request returns 503 rather than generating an app that can't be saved. Two-layer failure detection ensures projects never stay stuck in `generating`: (1) route handler catch blocks call `failProject()` fire-and-forget, (2) `listProjects()` infers failure for any project still `generating` after 10 minutes (well above the 5-min route timeout). Layer 2 exists because Cloud Run can kill processes before catch blocks run (OOM, platform restart).

### Manual Stream Reader Loop

The chat route uses a manual reader loop instead of `writer.merge()` so stream errors can be caught and emitted as `data-error` parts before the stream closes. If the writer is already broken, the error still lands in the Firestore event log, and `useChat`'s error property fires on the client as a fallback.

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
import ciIconName from '@iconify-icons/ci/icon-name'
<Icon icon={ciIconName} width="16" height="16" />
```

Always import from `@iconify/react/offline`, never `@iconify/react`. The default export uses `useState` + `useEffect` for hydration safety, which renders an empty `<span>` for 1–3 frames before the SVG appears. The `/offline` export renders synchronously.

### Inputs

All `<input>` and `<textarea>` elements must include `autoComplete="off"` and `data-1p-ignore` to suppress browser autocomplete and 1Password autofill overlays.

### RSC Architecture

Pages are Server Components that handle auth, fetch data, and render structure. Interactive leaves are small colocated client components. Push `'use client'` as far down the tree as possible. Name components by what they do (`UserTable`, `ProjectList`), not by runtime (`*Client`). Colocate page-specific components next to their page in `app/`.

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

Dark "Stellar Minimalism" — CSS custom properties in `globals.css`:
- Backgrounds: `--nova-void` (#050510) → `--nova-elevated` (#1a1a3e)
- Text: `--nova-text` (#e8e8ff) → `--nova-text-muted` (#555577)
- Accents: `--nova-violet`, `--nova-cyan`, `--nova-emerald`, `--nova-amber`, `--nova-rose`
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)
- Popover layers (`lib/styles.ts`): `POPOVER_GLASS` (L1, frosted glass) for base-layer panels, `POPOVER_ELEVATED` (L2, nearly opaque) for stacked popovers
- Animation constants (`lib/animations.ts`): `EASE` curve tuple, `POPOVER_ENTER_KEYFRAMES` + `POPOVER_ENTER_OPTIONS` for Web Animations API

## Structured Output Constraint

The Anthropic schema compiler times out with >8 `.optional()` fields per array item. Use sentinel values (empty string, false) for required-but-sparse fields, post-process with `stripEmpty()`. Test with `npx tsx scripts/test-schema.ts`. All SA tool question schemas are derived from `questionFields` in `blueprint.ts` — never define question field schemas inline in tool definitions.

## Model Configuration

`lib/models.ts` is the single source of truth for model IDs, pricing, and the SA agent's model/reasoning config. Code constants, not user-configurable.

## CommCare Connect

**`connect_type` uses an enum** (`'learn' | 'deliver' | ''`), not a free string — `z.string()` with `strict: true` only enforces "any string" in JSON Schema, while the enum forces the model to pick a valid value.

**State stash** preserves form connect configs across app-level mode switches (learn ↔ deliver). `switchConnectMode()` stashes outgoing configs, records the last active mode, sets the new mode, and restores stashed configs. Passing `undefined` re-enables with the last active mode for toggle off/on cycles.

**Content-based sub-config assignment** for learn apps: educational content → `learn_module` only, quiz/test → `assessment` only, combined → both. Never add `learn_module` to a quiz-only form or `assessment` to a content-only form. The SA prompt enforces this.

**Sub-configs are independent.** Each has an optional `id` field (XForm wrapper element name, bind paths). IDs follow question ID rules (alphanumeric snake_case, starts with letter). Learn apps require at least one of `learn_module` or `assessment`. Deliver apps require `deliver_unit`. `task` is always optional.
