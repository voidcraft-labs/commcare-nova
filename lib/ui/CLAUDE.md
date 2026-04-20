# lib/ui — Cross-cutting UI primitives

Stateless, domain-agnostic React hooks shared across builder, preview, chat, and landing surfaces. Hooks here depend only on the DOM, React, or imperative singletons from `lib/services/` (e.g. `toastStore`, `keyboardManager`). They do not read the doc store, session store, or routing state — a UI hook that needs one of those belongs in the owning domain package instead.

## What belongs here

- DOM observers (`useIsBreakpoint`).
- Input-interaction models (`useCommitField` — the commit/cancel/checkmark pattern).
- Keyboard / focus / menu navigation primitives (`useMenuNavigation`, `useKeyboardShortcuts`).
- Thin subscribers to imperative service singletons (`useToasts` over `toastStore`).
- Library wrappers with no domain binding (`useTiptapEditor`).

A hook that subscribes to doc state → `lib/doc/hooks/`.
A hook that subscribes to session state → `lib/session/hooks.tsx`.
A hook that subscribes to URL state → `lib/routing/hooks.tsx`.
