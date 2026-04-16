# commcare nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- Next.js 16 (App Router, Turbopack) · TypeScript strict · Tailwind v4 (`@theme inline`)
- AI: Vercel AI SDK — `ToolLoopAgent`, streamed UI messages, `useChat`
- State: Zustand scoped per-buildId · doc store with zundo undo/redo
- DB: Firestore · Encryption: Cloud KMS
- Auth: Better Auth + admin plugin. OAuth domain restriction lives on the GCP consent screen, not app code
- Use `motion/react` for animation (NOT `framer-motion`)
- Use `@base-ui/react` for floating elements (no raw `@floating-ui/react` in app code)
- Biome + Lefthook pre-commit · Vitest

## Commands

```bash
npm run dev                             # Turbopack
npm run build / lint / format / test
npx tsx scripts/test-schema.ts          # test structured output schemas
npx tsx scripts/build-xpath-parser.ts   # rebuild Lezer parser from xpath.grammar
```

`scripts/` also has read-only Firestore inspection tools and a `recover-app` writer (⚠️). Run any with `--help` for flags. Excluded from Docker.

## Deployment

Google Cloud Run via Docker (`next.config.ts` → `output: "standalone"`).

## Architecture

### Single agent, single endpoint

One chat route runs everything. A single `ToolLoopAgent` (the Solutions Architect) converses, generates, and edits. One conversation = one prompt-cache window, so the SA keeps full memory of every design decision. No orchestration, no sub-agents. See `lib/services/CLAUDE.md`.

**Edit vs build mode.** Two orthogonal decisions: (1) whether the app already exists picks the prompt + tool set — existing apps get editing prompt + blueprint summary + shared tools only; generation tools are never exposed in edit mode. (2) Prompt-cache window (5-min TTL) picks message strategy — within window: full history; after expiry: last-user-message only. App-exists stays false during initial generation even after modules land, so gen tools aren't stripped mid-build.

### Root route

`/` branches between landing / get-started / app list with no redirects. A cheap app-existence check runs before the Suspense boundary so new users skip the skeleton flash. No `/apps` route — the domain *is* the namespace.

### Fail-closed persistence

The Firestore app doc is created **before** generation — Firestore down = 503, not an orphaned build. Every blueprint mutation advances `updated_at`. Two-layer failure detection: route catch blocks fail the app fire-and-forget; the list query infers failure when `updated_at` stalls >10 min. The second layer exists because Cloud Run can kill processes before catch blocks run.

### Manual stream reader loop

The chat route reads the model stream manually (not `writer.merge()`) so stream errors can be caught and emitted as error data parts before the stream closes.

### Firestore

`ignoreUndefinedProperties: true` — sentinel-to-undefined post-processing would otherwise throw on write.

**App ownership is explicit, not path-scoped.** Apps are root-level with an `owner` field; any route serving user data must verify ownership (admin routes skip).

**Better Auth's user collection is the single source of truth for user identity.** The admin dashboard reads it directly via Firestore SDK because Better Auth's typed user omits `additionalFields` (present at runtime). Admin gating also reads Firestore directly to bypass the 5-min session-cookie cache.

**Chat threads** are one doc per conversation with messages embedded (not a subcollection) — threads are small and always loaded together. Thread id = run id. Fire-and-forget persistence on each ready transition; historical threads stream in via Suspense.

## Data model

**Questions are self-contained.** All metadata lives on the question. Case-type metadata is a generation-time artifact — defaults are baked into questions at add time and the case-type record is never consulted at runtime.

**Question id = case property name.** A question saves to the case type named by its `case_property_on` field — matching the module's type is a normal property; naming a different type auto-derives child case creation.

**Form-level case wiring is derived, not stored** — expander + validator scan questions on demand.

**Four form types.** Registration (creates case), followup (updates), close (loads + closes), survey (no case). Close is a superset of followup. Centralized form-type sets exist — use them rather than ad-hoc string comparisons.

**Two identity fields per question.** Semantic id (mutable, used as XForm node name / CommCare property key) vs stable uuid (assigned at creation, never changed on rename). Use uuid for UI identity (React keys, DOM selectors, dnd-kit IDs); use id / path for blueprint mutations + expander/compiler calls.

**Sibling ids must be unique** (CommCare requirement; cousins can share). Enforced on cross-level moves (auto-suffix + XPath rewrite) and on rename.

**Case list columns are fully LLM-controlled** — no auto-prepend/filter by expander or compiler.

### CommCare HQ upload

Upload creates a **new app** each time — HQ has no atomic update API. The HQ base URL is hardcoded (prevents SSRF). User API keys are KMS-encrypted at rest. Domain slugs are validated against HQ's legacy regex to prevent path traversal in the import URL.

Two workarounds live on the import endpoint because HQ's decorators on it are incomplete:

- **CSRF:** missing `@csrf_exempt`. The client fetches a token from the unauthenticated login GET and sends it on the POST. Harmless if HQ fixes it upstream.
- **WAF:** missing the XSS-body exemption. AWS WAF blocks XForms-looking tags in multipart bodies. Fix: a 16KB padding form field inserted **before** the app file pushes JSON past the WAF inspection window. The padding field name must NOT start with `_` (CouchDB reserved). Symptom of a block: a bare nginx 403 — distinct from Django's verbose CSRF 403.

## Conventions

### Icons

Always import from `@iconify/react/offline`. The default `@iconify/react` export hydrates via effects and renders an empty span for 1–3 frames; `/offline` renders synchronously. The Tabler iconify package is stale vs upstream — missing icons go in the project's extras file with SVG sourced from tabler.io.

### Inputs

All `<input>` / `<textarea>` need `autoComplete="off"` and `data-1p-ignore`.

### RSC + auth

Pages are Server Components; interactive leaves are small colocated clients. Push `'use client'` down. Name components by what they do, not by runtime.

Server layouts are the auth gate — by the time a client component mounts, auth is guaranteed. Client code must not re-gate on session state. The Better Auth client disables refetch-on-focus because its default briefly nulls session data on tab switch.

**No portals for fixed-position elements.** `createPortal` to `document.body` causes SSR hydration mismatches. Fixed-position elements render at the viewport regardless of DOM position.

### Builder state

Three sources of truth — URL (where you are + selection), doc store (blueprint entities with zundo undo/redo), session store (ephemeral UI + generation lifecycle + replay). See `components/builder/CLAUDE.md`.

Navigation is URL-owned and uses the browser History API (not Next's router) to avoid server-side RSC re-renders. All entity UUIDs are globally unique, so a single path segment identifies the entity.

**Undo tracking is paused during hydration and agent writes** — the empty→populated transition must not enter history, and the entire agent write becomes one undoable unit. Do not remove the pause/resume calls.

**Store boundary rules enforced by Biome.** Components and app code import from `lib/doc/hooks/`, `lib/session/hooks`, and `lib/routing/hooks` — never from the raw store modules. The `noRestrictedImports` rule in `biome.json` fails the build on violations. Internal lib code (providers, stream dispatchers, tests) is exempt.

**BuilderProvider** lives at `components/builder/BuilderProvider.tsx` — mounts the full provider stack (doc store → session store → scroll registry → edit guard → form engine) and the lifecycle hydrators (SyncBridge, ReplayHydrator, LoadAppHydrator).

### DOM listeners

Use React 19 ref-callback cleanup (not `useEffect`) for click-outside, Escape, and observer wire-up.

### Floating elements (Base UI)

A single floating-tree coordinator handles dismiss/focus across all surfaces; the root layout provides shared tooltip delay grouping.

**Glass/elevated styles live on the positioner, not the popup** — `will-change: transform` on the positioner breaks `backdrop-filter` on descendants. Selectable-option dropdowns use the menu primitive (not popover) for ARIA + keyboard nav. Searchable pickers use the autocomplete primitive's collection in uncontrolled mode and commit on item-press only.

### Navigation + errors

Never call `router.push` / `router.replace` during render. Route-level error boundaries use `window.location.href` because React's tree is in an error state. All boundaries report to the server.

## Theme

Dark "Violet Monochrome" — violet is the single non-semantic accent; success/warning/error hues are reserved for semantic states, never decoration. CSS custom properties in `globals.css` drive everything.

Z-index is a semantic scale of named tokens (not hardcoded numbers) — use the Tailwind classes that reference them. Floating surfaces have two layers: frosted-glass primary, and a near-opaque elevated tier that stacks above glass (glass-on-glass loses blur).

## Structured output constraint

The Anthropic schema compiler times out with more than ~8 optional fields per array item. Use sentinel values (empty string, false) for required-but-sparse fields and post-process to strip them. Question-field schemas come from one shared source — never inline new ones in tool defs. Test with the schema script.

## Model configuration

Model IDs, pricing, and SA model/reasoning settings live in one file as code constants, not user-configurable.

## CommCare Connect

- `connect_type` is an enum, not a plain string — `z.string()` only enforces "any string" in JSON Schema, so an enum is required to force a valid value from the LLM.
- A state stash preserves form-level connect configs across app-level mode switches (learn ↔ deliver) so toggling off/on doesn't lose work.
- Content-based sub-config assignment for learn apps (educational → learn module only; quiz → assessment only; combined → both) is enforced by the SA prompt.
- Sub-configs are independent; learn and deliver apps each require ≥1 sub-config.
