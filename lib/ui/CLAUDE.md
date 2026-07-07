# lib/ui — Cross-cutting UI primitives

Stateless, domain-agnostic React hooks + the imperative UI singletons they subscribe to, shared across builder, preview, chat, and landing surfaces. Hooks here depend only on the DOM, React, or the colocated singletons (`toastStore`, `keyboardManager`). They do not read the doc store, session store, or routing state — a UI hook that needs one of those belongs in the owning domain package instead.

## What belongs here

- Imperative UI singletons (`toastStore`, `keyboardManager`) — module-level instances callable from anywhere, including callbacks and catch blocks.
- Pure interaction models + their DOM bindings (`insertionIntent.ts` — the insertion-affordance intent state machine (EMA'd pointer speed, dwell-evidence accumulator, geometric zone containment), pure and clock-injected so gestures unit-test deterministically; `hooks/useInsertionZone.tsx` — its provider/zone binding: document-level listeners, throttled rect cache, occlusion hit-test against `[data-insertion-surface]`, and a rAF loop that runs only while a zone is arming/open/closing).
- Cross-surface UI coordination contexts (`inspector.tsx` — the right-rail inspector's claim stack + portal target, shared by the chat sidebar and the builder surfaces that claim it; see `components/builder/CLAUDE.md` § Inspector rail).
- DOM observers (`useIsBreakpoint`).
- Input-interaction models (`useCommitField` — the commit/cancel/checkmark pattern).
- Keyboard / focus / menu navigation primitives (`useMenuNavigation`, `useKeyboardShortcuts`).
- Thin subscribers to the imperative singletons (`useToasts` over `toastStore`).
- Library wrappers with no domain binding (`useTiptapEditor`).

A hook that subscribes to doc state → `lib/doc/hooks/`.
A hook that subscribes to session state → `lib/session/hooks.tsx`.
A hook that subscribes to URL state → `lib/routing/hooks.tsx`.
