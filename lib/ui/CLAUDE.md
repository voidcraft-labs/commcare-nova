# lib/ui — Cross-cutting UI primitives

Stateless, domain-agnostic React hooks + the imperative UI singletons they subscribe to, shared across builder, preview, chat, and landing surfaces. Hooks here depend only on the DOM, React, or the colocated singletons (`toastStore`, `keyboardManager`). They do not read the doc store, session store, or routing state — a UI hook that needs one of those belongs in the owning domain package instead.

## What belongs here

- Imperative UI singletons (`toastStore`, `keyboardManager`) — module-level instances callable from anywhere, including callbacks and catch blocks.
- Pure interaction models + their DOM bindings (`insertionIntent.ts` — the insertion-affordance intent state machine (EMA'd pointer speed, dwell-evidence accumulator, geometric zone containment), pure and clock-injected so gestures unit-test deterministically; `hooks/useInsertionZone.tsx` — its provider/zone binding: document-level listeners, throttled rect cache, occlusion hit-test against `[data-insertion-surface]`, and a rAF loop that runs only while a zone is arming/open/closing).
- Shared right-rail width constants (`inspector.tsx`) — chat and the docked inspector resolve to the SAME width so selecting something never reflows the canvas. The inspector itself is rendered directly from shared selection state by the chat sidebar (`components/builder/inspector/activeInspector.tsx`); there is no claim/portal coordination here. See `components/builder/CLAUDE.md` § Inspector rail.
- DOM observers (`useIsBreakpoint`).
- Input-interaction models (`useCommitField` — the commit/cancel/checkmark pattern).
- Keyboard / focus / menu navigation primitives (`useMenuNavigation`, `useKeyboardShortcuts`, `useInlineConfirmFocus`).
- Thin subscribers to the imperative singletons (`useToasts` over `toastStore`).
- Library wrappers with no domain binding (`useTiptapEditor`).

**A destructive action that confirms IN PLACE uses `hooks/useInlineConfirmFocus`.** The builder's confirm-in-place pattern swaps the trigger button for a panel, which unmounts the trigger and drops focus to the document body — a keyboard or screen-reader user is returned to the top of the page while a destructive question sits on screen they never heard. The hook focuses the panel on open and returns focus to the trigger on close. It exists here rather than beside any one panel because the defect looks fine at every individual site and is only visible across them. A confirmation that opens a real dialog needs none of this: Base UI's dialog primitives own focus entry and return.

A hook that subscribes to doc state → `lib/doc/hooks/`.
A hook that subscribes to session state → `lib/session/hooks.tsx`.
A hook that subscribes to URL state → `lib/routing/hooks.tsx`.
