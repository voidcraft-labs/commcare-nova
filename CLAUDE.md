# CommCare Nova

Next.js web app that generates CommCare mobile apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (imported as `motion/react`, NOT `framer-motion`)
- **Validation**: Zod v4
- **AI (Chat)**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) with built-in `AskUserQuestion` tool + custom `generate_app` MCP tool
- **AI (Generation)**: Anthropic SDK (`@anthropic-ai/sdk`) with structured output via `zodOutputFormat`
- **Testing**: Vitest

## Project Structure

```
app/                    # Next.js App Router pages and API routes
  api/
    chat/               # SSE streaming chat endpoint (Agent SDK)
    chat/respond/       # Endpoint for user answers/confirmations
    generate/           # Generation pipeline endpoint
    validate/           # Blueprint validation
    compile/            # CCZ compilation + download
  build/[id]/           # Main builder view (3-panel layout)
  builds/               # Build history
components/
  builder/              # AppTree, DetailPanel, GenerationProgress, EmptyState
  chat/                 # ChatSidebar, ChatMessage, ChatInput, QuestionCard, GenerationCard, ThinkingIndicator
  ui/                   # Button, Input, Badge, Logo
hooks/                  # useBuilder, useChat, useApiKey, useBuilds
lib/
  services/
    claude.ts           # Stateless Anthropic SDK functions (generation pipeline only)
    appGenerator.ts     # Three-tier generation pipeline
    chatTools.ts        # Custom generate_app MCP tool for Agent SDK
    session.ts          # In-memory session manager (SSE ↔ respond coordination)
    cczCompiler.ts      # CCZ compilation
  schemas/              # Zod schemas for AppBlueprint, tier outputs, chat types
  prompts/              # System/tier prompts for Claude
  types/                # TypeScript type definitions
  store.ts              # JSON file persistence in .data/ (builds + ccz files)
```

## Key Architecture Decisions

### Agentic Chat with Claude Agent SDK

The chat system uses the Claude Agent SDK (`query()`) with two tools:

- **`AskUserQuestion`** (built-in) — Claude asks structured multiple-choice questions. Intercepted via `canUseTool` in the chat route: questions are sent to the client over SSE, the agent loop blocks until the client POSTs answers to `/api/chat/respond`, then `canUseTool` returns `{ behavior: 'allow', updatedInput }` with answers filled in.
- **`generate_app`** (custom MCP tool via `createSdkMcpServer`) — Claude proposes an app. The tool handler sends the proposal to the client via SSE, blocks until the client confirms/cancels via `/api/chat/respond`, then returns the result to Claude.

The chat route streams SSE events to the client:
- `text_delta` — Claude's streaming text (from `includePartialMessages` stream events)
- `processing` — tool call starting (detected from `content_block_start` with `tool_use` type)
- `questions` — AskUserQuestion data (from `canUseTool` interception)
- `generate` — generation proposal (from `generate_app` tool handler)
- `error` / `done` — terminal events

Session coordination uses an in-memory Promise map (`lib/services/session.ts`). When a tool needs user input, it stores a resolver; when `/api/chat/respond` receives the answer, it resolves the Promise and unblocks the agent loop.

Sessions persist across messages via the Agent SDK's `sessionId` (first message) and `resume` (subsequent messages).

### Three-Tiered Generation Pipeline

The generation pipeline stays on the raw Anthropic SDK — it's structured output for schema generation, not interactive conversation.

Runs in three tiers to stay within Anthropic's schema compilation limits:
1. **Scaffold** (Tier 1): App structure + data model (case types, modules, forms)
2. **Module Content** (Tier 2): Case list columns per module
3. **Form Content** (Tier 3): Questions + case config per form

Each tier uses its own slim Zod schema with `sendOneShotStructured()`. Results are assembled into a full `AppBlueprint` via `assembleBlueprint()`.

### Chat-Driven Auto-Generation

User describes app in chat → Claude decides to call tools:
- `AskUserQuestion` → question stepper card renders in chat
- `generate_app` → generation card with Generate/Cancel buttons
- User clicks Generate → `useChat` sets `pendingGeneration` → `BuilderLayout` triggers the three-tier pipeline

### Direct API Calls (No Job System)

Generation runs inline in the POST handler. The client calls `/api/generate`, waits for the result, and gets the blueprint back directly. No background jobs, no pub/sub.

### Stateless Claude Service

`lib/services/claude.ts`: Stateless functions that accept an API key per-call. Used only by the generation pipeline. The chat system uses the Agent SDK instead.

### Bring-Your-Own-API-Key

No auth layer. The user's Anthropic API key is stored in localStorage and sent per request. Never persisted server-side.

## Chat Components

- **`ChatSidebar`** — Message list + input. Passes tool callbacks through to messages.
- **`ChatMessage`** — Thin dispatcher: renders `QuestionCard`, `GenerationCard`, or text bubble based on `message.type`.
- **`QuestionCard`** — Animated stepper for `AskUserQuestion`. Shows questions one at a time with option buttons. Previously answered questions display as checkmark + answer chips. Supports free-text override (user types instead of clicking).
- **`GenerationCard`** — Shows app name + architecture preview with Generate/Cancel buttons. States: default, generating (pulsing), cancelled (dimmed).
- **`ThinkingIndicator`** — Orbital violet dot animation shown when the agent is processing (before first response and between text completion and tool card arrival). Standalone component, not a fake message.

## Schemas

### Nullable vs Optional
- **Tier schemas** (for Claude's structured output): use `.nullable()` — required by the API
- **Assembled blueprint** (for validation/expansion): use `.optional()` — more natural for TS
- Assembly strips nulls via spread: `...(value != null && { key: value })`

### Chat Types
`lib/schemas/chat.ts` exports `ClarifyingQuestion` and `QuestionOption` interfaces matching the built-in `AskUserQuestion` tool format (question, header, options with label/description, multiSelect).

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

## Service Layer Notes

Key design choices in `lib/services/`:
- `claude.ts`: Stateless functions, API key per-call. `sendOneShotStructured` for single-message structured output, `sendStructured` for multi-turn structured output. Used by generation pipeline only.
- `chatTools.ts`: Custom `generate_app` MCP tool factory. Creates a per-session server via `createSdkMcpServer` so the tool handler closes over the session's `waitForClient` function.
- `session.ts`: In-memory `Map<string, resolver>`. `setPending()` stores a Promise resolver, `respond()` resolves it. Bridges SSE stream and respond endpoint.
- `appGenerator.ts`: Pure function — takes inputs, returns `GenerationResult`. No events, no callbacks, no I/O.
- `cczCompiler.ts`: Returns `Buffer`, stored to disk via `store.ts` for download
