# lib/ui — Cross-cutting UI primitives

Stateless, domain-agnostic React hooks + the imperative UI singletons they subscribe to, shared across builder, preview, chat, and landing surfaces. Hooks here depend only on the DOM, React, or the colocated singletons (`toastStore`, `keyboardManager`). They do not read the doc store, session store, or routing state — a UI hook that needs one of those belongs in the owning domain package instead.

## What belongs here

- Imperative UI singletons (`toastStore`, `keyboardManager`) — module-level instances callable from anywhere, including callbacks and catch blocks.
- Pure interaction models + their DOM bindings (`insertionIntent.ts` — the insertion-affordance intent state machine (EMA'd pointer speed, dwell-evidence accumulator, geometric zone containment), pure and clock-injected so gestures unit-test deterministically; `hooks/useInsertionZone.tsx` — its provider/zone binding: document-level listeners, throttled rect cache, occlusion hit-test against `[data-insertion-surface]`, and a rAF loop that runs only while a zone is arming/open/closing; `chatScroll.ts` — the chat conversation's one scroll model: pure pinned/free decisions (any upward user scroll escapes, downward re-pins within slop, the pinned target caps at a waiting question card's top) plus `ChatScrollController`, the ResizeObserver + programmatic-scroll-counter binding `components/ai-elements/conversation.tsx` mounts. Its `attach` is idempotent per element pair and the ref callbacks that call it must be identity-stable — a re-attach on every render resets the mode, which is how an escaped view once snapped straight back to the bottom).
- Shared right-rail width constants (`inspector.tsx`) — chat and the docked inspector resolve to the SAME width so selecting something never reflows the canvas. The inspector itself is rendered directly from shared selection state by the chat sidebar (`components/builder/inspector/activeInspector.tsx`); there is no claim/portal coordination here. See `components/builder/CLAUDE.md` § Inspector rail.
- DOM observers (`useIsBreakpoint`).
- Input-interaction models (`useCommitField` — the commit/cancel/checkmark pattern).
- Keyboard / focus / menu navigation primitives (`useMenuNavigation`, `useKeyboardShortcuts`, `useInlineConfirmFocus`, `useMenuArrowKeys`).
- Thin subscribers to the imperative singletons (`useToasts` over `toastStore`).
- Library wrappers with no domain binding (`useTiptapEditor`).

**`useMenuArrowKeys` is for a POPOVER that acts as a menu, and it is not
`useMenuNavigation`.** Base UI's `Menu` gives arrow keys for free, but the
account and Project menus are popovers whose rows are plain buttons and
links, because they hold sections, headings and mixed content a menu's row
model does not fit. So they answered the pointer and not the keyboard, and
both record a real choice (switch Project, sign out). The difference
from `useMenuNavigation` is where the rows come from: that one takes a static
`items` array and owns a selected index (the TipTap toolbar), while these
panels add and remove rows WHILE OPEN (a Project list finishes loading, a
confirmation arms), so the rows are read from the DOM on each keystroke and a
captured list would step onto a row that is gone.

**An action that removes the control the author just pressed hands focus
forward — `hooks/useClearedSlotFocus` (an optional slot's Clear, whose trigger
unmounts with the editor it removed) and `hooks/useRemovedRowFocus` (a row's
own Remove; next, then previous, then Add). Base UI's `finalFocus` alone does
NOT do this**: it resolves during the closing dialog's layout-effect cleanup,
before the replacement button's ref is attached, so it reads `null` and falls
back to the trigger being unmounted. Both hooks therefore carry the intent on a
ref and consume it in an effect once the slot or list has actually re-rendered.
Pass `finalFocus` as well; it costs nothing and covers an already-mounted
replacement.

**The mirror case is an action that adds a row BELOW the fold —
`hooks/useAppendedRowReveal`.** An Add control sits under its own list, so the
list grows above it and in a dialog (whose body is a fixed-height scroll region)
the new row lands out of sight; the only visible change is the button shifting
down, and the press reads as "nothing happened". It scrolls the new row into
view, `block: "start"` so a row taller than the scrollport shows its heading
rather than its foot, and honors `prefers-reduced-motion`. Same family, same
rule below — and `onAppended` reads the live length off a ref precisely so a
call site may freeze it in a `useCallback([])` without recording a stale count.

**The intent is armed before the commit, so it must expire after exactly ONE
render.** These gestures can be REFUSED — a stale edit, a read-only carrier, the
commit gate — and a refusal renders without emptying the slot or shortening the
list. An intent keyed on "wait until it empties" therefore survives the refusal
and fires on whatever empties it next: the author reads the refusal, adds a row,
and focus jumps to an unrelated control. Both effects consequently run on EVERY
render (no dep array) and always consume the intent, moving focus only if the
change they were armed for is the one that landed. A new hook in this family
inherits that rule — arming on an outcome you have not yet confirmed is the
whole hazard.

**A destructive action that confirms IN PLACE uses `hooks/useInlineConfirmFocus`.** The builder's confirm-in-place pattern swaps the trigger button for a panel, which unmounts the trigger and drops focus to the document body — a keyboard or screen-reader user is returned to the top of the page while a destructive question sits on screen they never heard. The hook focuses the panel on open and returns focus to the trigger on close. It exists here rather than beside any one panel because the defect looks fine at every individual site and is only visible across them. A confirmation that opens a real dialog needs none of this: Base UI's dialog primitives own focus entry and return.

A hook that subscribes to doc state → `lib/doc/hooks/`.
A hook that subscribes to session state → `lib/session/hooks.tsx`.
A hook that subscribes to URL state → `lib/routing/hooks.tsx`.
