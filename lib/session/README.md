# lib/session — The Builder Ephemeral Session Store

Transient UI state scoped to the builder route: cursor mode, sidebar
visibility, agent status, active field, connect-mode stash. None of this is
undoable; none of it is persisted across page loads.

## Boundary rule

Same as `lib/doc`: anything outside `lib/session/hooks/**` must not import
from `lib/session/store.*` directly. Consumer code uses named hooks
(`useCursorMode()`, `useAgentStatus()`, `useSidebarState("chat")`, ...).

## Why a separate store

Separating ephemeral UI from the blueprint document means:
- Zundo (undo middleware) can track the entire document store without a
  `partialize` allow-list, because UI fields don't live in it.
- The two stores have disjoint responsibilities and can be reasoned about
  independently.
- Stream handlers and route handlers can toggle `agent` status from outside
  React's render tree without threading through context.

## Status

**Phase 0 (scaffolding):** only `types.ts` exists. Store and hooks are
added in Phase 3.

See `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md`.
