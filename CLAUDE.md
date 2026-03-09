# CommCare Nova

Next.js web app that generates CommCare mobile apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (imported as `motion/react`, NOT `framer-motion`)
- **Validation**: Zod v4
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`) with structured output via `zodOutputFormat`
- **Testing**: Vitest

## Project Structure

```
app/                    # Next.js App Router pages and API routes
  api/                  # REST + SSE endpoints (generate, validate, compile, chat)
  build/[id]/           # Main builder view (3-panel layout)
  builds/               # Build history
components/
  builder/              # AppTree, DetailPanel, GenerationProgress, EmptyState
  chat/                 # ChatSidebar, ChatMessage, ChatInput
  ui/                   # Button, Input, Badge, Logo
hooks/                  # useBuilder (state machine), useSSE, useChat, useApiKey, useBuilds
lib/
  services/             # Core generation pipeline (copied from commcare-forge-mcp)
  schemas/              # Zod schemas for AppBlueprint and tier outputs
  prompts/              # System/tier prompts for Claude
  types/                # TypeScript type definitions
  sse.ts                # SSE encoding helpers
  store.ts              # JSON file persistence in .data/
  generation-manager.ts # In-memory job tracking with subscriber pattern
```

## Key Architecture Decisions

### Three-Tiered Generation Pipeline
The AI generation runs in three tiers to stay within Anthropic's schema compilation limits:
1. **Scaffold** (Tier 1): App structure + data model (case types, modules, forms)
2. **Module Content** (Tier 2): Case list columns per module
3. **Form Content** (Tier 3): Questions + case config per form

Each tier uses its own slim Zod schema with `sendOneShotStructured()`. Results are assembled into a full `AppBlueprint` via `assembleBlueprint()`.

### Stateless Claude Service
Unlike the Electron app's class-based `ClaudeService`, Nova uses stateless functions that accept an API key per-call. No conversation history is stored server-side.

### SSE Streaming
Generation progress streams to the client via Server-Sent Events. The `generation-manager.ts` maintains a subscriber map; the SSE route handler subscribes and forwards events.

### Bring-Your-Own-API-Key
No auth layer. The user's Anthropic API key is stored in localStorage and sent per request. Never persisted server-side.

## Schemas

### Nullable vs Optional
- **Tier schemas** (for Claude's structured output): use `.nullable()` — required by the API
- **Assembled blueprint** (for validation/expansion): use `.optional()` — more natural for TS
- Assembly strips nulls via spread: `...(value != null && { key: value })`

### Question Format
- Tier 3 outputs flat questions with `parent_id` for nesting
- Assembled blueprint uses recursive `children` arrays
- `unflattenQuestions()` and `flattenQuestions()` convert between formats

### Close Case
- `{}` = unconditional close
- `{question, answer}` = conditional close
- absent/undefined = no close

## Commands

```bash
npm run dev          # Start dev server (Turbopack)
npm run build        # Production build
npm test             # Run tests (vitest)
npm run test:watch   # Watch mode tests
```

## Theme

Dark "Stellar Minimalism" theme. CSS custom properties defined in `globals.css`:
- Backgrounds: `--nova-void` (#050510) → `--nova-elevated` (#1a1a3e)
- Text: `--nova-text` (#e8e8ff) → `--nova-text-muted` (#555577)
- Accents: `--nova-violet`, `--nova-cyan`, `--nova-emerald`, `--nova-amber`, `--nova-rose`
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)

## Origin

Backend services in `lib/` were copied and adapted from `../commcare-forge-mcp/backend/src/`. Key adaptations:
- `claude.ts`: Stateless functions instead of class, API key per-call
- `appGenerator.ts`: Event emitter callbacks instead of BuildLogger/AppExporter, no disk I/O
- `cczCompiler.ts`: Returns `Buffer` instead of writing to filesystem
- `system.ts`: Embedded prompt constant instead of `fs.readFileSync` for reference docs
