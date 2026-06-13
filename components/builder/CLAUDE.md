# Builder Components

## Edit vs preview mode

Edit is a frozen, stateless view: inputs empty, validation suppressed, submit bar hidden, and ALL fields render regardless of relevant conditions (hidden ones as compact cards) so the full structure stays editable. Preview is a persistent sandbox: values survive round-trips through edit; validation resets on exit; blueprint mutations recreate the engine but restore only user-touched values, so edited defaults show immediately.

## Preview mode

One global Preview toggle (centered in the BuilderHeader — directly above the canvas for reach; `P`, Escape exits) flips the whole canvas to the running app. Breadcrumbs live in the canvas column's own strip so a long trail can never collide with the centered toggle. **The mode flip is one layout commit choreographed by transforms** — centered (max-width) content can't track a sliding sidebar edge through layout (it stays pinned until the column narrows past the frame, then rushes), so the flip commits the final layout in a single render and everything that travels does so on the shared `SIDEBAR_TRANSITION`: the structure column and chat rail slide through `AnimatePresence popLayout`, the never-unmounted chat panel is an absolute right dock (its layout space is an in-flow spacer) sliding via `x`, and every centered surface is a `ContentFrame` gliding a delta computed from the column geometry (`ModeFlipGlideProvider`) — computed, not FLIP-measured, because Activity-swapped frames have no "before" box yet must stay edge-locked with the breadcrumbs. **New centered canvas surfaces must use ContentFrame** or they'll snap while everything else glides. Manual sidebar toggles keep the plain width tween. There is no per-surface preview affordance and no cursor-mode pill. Entering hides both sidebars AND their collapsed rails atomically, stashing open-state in one set call so leaving restores the layout. Keep the early return on no-op toggles — without it, entering preview twice overwrites the stash with `{ false, false }`.

## Flipbook (edit ↔ live) invariants

- Scroll sync captures the topmost visible field BEFORE the mode change and corrects `scrollTop` in a layout effect after; the anchor must be React state (the effect depends on it). If the anchor is hidden in the new mode, search outward from its index backward first. A ResizeObserver re-corrects during the ~200ms sidebar animation, then clears after 250ms.
- Both renderers must land every row at identical X/Y — scroll sync can't rescue genuinely different layouts. Group/repeat collapse state lives in `FormLayoutContext` (mounted once per form), never in the virtual list, which unmounts on mode switch. Rows pad right with `depthPadding(depth)` (not `depthPadding(0)`), and live-mode labels wrap in `px-[5px] py-[5px]` to match edit mode's idle wrapper — without it every labelled row is 10px shorter live and the flipbook drifts.

## ProseMirror trailingBreak — CSS fix, not DOM

prosemirror-view hardcodes a `<br class="ProseMirror-trailingBreak">` per block. Hide it only where it adds phantom height: `.tiptap .ProseMirror-trailingBreak:not(:only-child)` (sole-child breaks must stay for cursor positioning) and `.tiptap:has(> :not(p)) > p:last-child > .ProseMirror-trailingBreak:only-child` (the structural paragraph after block elements). Preview markdown sets `white-space: break-spaces` + `position: relative` globally to match ProseMirror, so mode switches don't reflow. TipTap 3's class is `tiptap`, not `ProseMirror`.

## Scroll, selection, navigation

- Scroll-to-selection is a rAF loop, not native smooth — panel mount/unmount layout shifts make the browser abandon native `scrollTo` mid-flight. Cross-screen navigation scrolls `"instant"`.
- Clicking empty space never deselects (it would constantly dismiss the inspector).
- Selection is a URL replace; scroll is a separate pending-target request the selected field's wrapper consumes. Undo/redo scrolls directly — never through the pending mechanism.
- The edit guard (XPath editor with unsaved invalid content) blocks navigation two-strike: first attempt warns, second lets through, any keystroke resets.
- Field uuid is the stable UI identity (survives renames); the path is only for mutation calls.

## Drag-and-drop

`pragmatic-drag-and-drop` + TanStack Virtual. `@dnd-kit/react` was removed because its sorting plugin physically moves DOM nodes during drag, which fights the virtualizer's absolute layout; its `position: fixed` overlay also broke under `contain: strict`, which pragmatic DnD's browser-managed preview is immune to.

- During drag, the hovered insertion row is REPLACED by a taller placeholder row (row count stays constant; one slot remeasures). When the cursor is over dead space, the last valid position is preserved — clearing it collapses the gap and flickers.
- At drop time the cursor is over the placeholder, so drop targets carry no useful data: the monitor stashes the resolved position from `onDrag` in a ref that `onDrop` reads. The placeholder registers as a drop target so the native drop is accepted (no snap-back).
- One monitor owns the mutation; row components never mutate. Drop-target payloads are a discriminated union in `dragData.ts` — add new kinds there so the monitor stays one switch.
- The cycle guard (`isUuidInSubtree`) runs in every `canDrop` AND defensively in `onDrop`, reading the doc store imperatively.
- The custom native drag preview renders into a library-owned offscreen container so the source element keeps its size — otherwise the virtualizer's ResizeObserver collapses adjacent rows mid-drag.

## Field wrapper is `div[role=button]`, not `<button>`

Children contain nested interactive elements; HTML forbids interactive content inside `<button>` and SSR parsers mangle the tree. Do not "fix" this. The wrapper sets `pointer-events-none` on children; text-editable zones punch back through via CSS, and the capture-phase click handler selects without stopping propagation for text targets so inline editing also activates.

## Undo / redo

The action runs temporal restore → `flushSync` → URL navigation → scroll → flash. `flushSync` is required (DOM nodes created by the undo must exist before focus queries); do not replace with rAF. Temporal store subscriptions use `useStoreWithEqualityFn` with `Object.is` — plain `useStore` re-renders on every temporal change. Focus restoration consumes a focus-hint string written by a delegated onFocus handler; never query `document.activeElement` (blur has already moved focus). Undo tracking is paused during hydration and agent writes — the empty→populated transition must not enter history, and an agent write is one undoable unit. Do not remove the pause/resume calls.

## Field editor

Registry-driven: Zod schemas + kind metadata in `lib/domain/fields/<kind>.ts`, editor schemas keyed by `FieldKind` in `editor/fieldEditorSchemas.ts`. Adding a property = one schema entry; adding a kind = one domain file + registry entries. Move targets and first/last flags compute inline in the render body, not `useMemo` — reorder produces new Immer references without changing selection, so memoizing on selection misses it.

## Settings popovers

Module/form/app media each clears through its dedicated null-carrying mutation; the case-list appearance slots instead ride wholesale `updateModule({ caseListConfig })`, which cannot carry nulls (see `setOptionalSlot` below).

## Inspector rail (right-rail properties panel)

The right rail is the chat sidebar; the inspector borrows it via a claim model in `lib/ui/inspector.tsx`. **The rail is ONE width in both modes** — `CHAT_SIDEBAR_WIDTH` aliases `INSPECTOR_RAIL_WIDTH`, so selecting something never reflows the canvas. Widen the shared constant if cramped; never re-introduce a per-mode width.

- Panel content portals from the OWNING surface's React tree — the rail never holds content state.
- Claims are established in effects so React 19 `<Activity>` self-releases them (hiding a screen destroys effects → releases the claim). Claims stack last-wins because an incoming surface can claim before the outgoing one cleans up.
- Escape closes only from outside the rail (`[data-inspector-rail]` check) — inside it, CodeMirror/menus own Escape.

## Case-list workspace

The unified case-list authoring surface: three config tabs (Search / Case List / Case Detail); **the tab IS the URL kind**, so tab switches are history navigation and deep links land on the right canvas. Selection is the mode; the run-through is the chrome's global Preview toggle — all three URLs preview as the one assembled running case list (search beside results, detail-in-place, Continue carries the selected case into the module's case-loading form). Entry point is the structure tree's case-list node, not the module screen.

**Preview passes the selected case down the stack like the running app** — it never hardcodes select→detail→form. Picking a case records a `previewCaseTarget` (session store: the case-loading form + the chosen `caseId`); `PreviewShell` grafts that `caseId` onto the form screen so `FormScreen` preloads it. The destination is a CASE-LOADING form (followup/close — never registration/survey): the module menu seeds which form when you tap one, else the list defaults to the module's first case-loading form. No case-loading form ⇒ the list is informational (no Continue). The target clears on every preview toggle.

Canvases are artifact-first: the case list IS a live table, the search panel IS the app's search screen, the detail card IS the opened-case view. **Clicking a thing configures that thing** in the inspector rail. Selection is workspace-local state keyed by module, cleared on tab switches and Esc — Escape must register through `useKeyboardShortcuts` (the manager preventDefaults matched keys; a raw listener never fires, and later registrations win).

Rules that aren't enforced by tooling:

- **Add affordances land WORKING entities.** Seeds bind a real property (never unbound — an unbound field matches nothing and reads as "search is broken"), take a human label and a legal unique wire name, match the widget to the property type, and give text properties fuzzy match. The same bar applies to custom→standard match conversion and property changes; hand-typed labels/names are never overwritten.
- **Picker vocabulary is familiar words with exact descriptions**; items a property's type can't run are disabled with the reason, never selectable into a validation error.
- **Every interactive control is at least 44px tall, carries a visible text label, and hover text rides the shared `Tooltip`** — never a native `title=`.
- **A body never re-titles its panel** — the inspector header already names the entity; bodies open with content, not a second heading. Removal is always the body's LAST row (shared `RemoveRow`).
- **Counts are information, not success** — live readouts use the quiet mono `LIVE` treatment, never semantic green.
- **Fill = pressable, and only Preview presses.** On edit canvases the search button renders as an outlined blueprint with no hover state or click handler of its own (clicks bubble to the panel selection). A fill or hover lift would promise a search the canvas can't run. No in-canvas Preview affordance — the chrome's global toggle owns the run-through.
- **Search fields are one source** (`caseListConfig.searchInputs`) across the search and list screens; screen labels/button condition/owner exclusions live in the separate `caseSearchConfig` slot.
- **Preview gating is config-derived, not editor-derived** — only the inspected editor is mounted, so the gate re-derives the whole-config verdict purely, mirroring each editor's verdict source so they can't disagree. The same derivation drives the per-tab error dots.

## Predicate / expression card editor (shared)

Cross-workspace authoring surface for Predicate / ValueExpression ASTs; lives under `shared/` so workspaces don't import each other's chrome.

- **Conditions are sentences**: subject (property) → verb → object (value), as headerless rows — nothing titles a row with its AST node name. ONE verb menu holds every behavior plus a Structure group. Changing a verb carries the subject (and value where the target holds one) — **changing how you compare never loses what you compare**. Wrapping shapes (groups, not, when-field-filled) wrap the current condition rather than replacing it; only the always-true/false sentinels rebuild from defaults. Container kinds keep titled cards — a box's identity isn't expressible inline.
- Term values are unboxed: the term's source dropdown carries a "Computed" group with the expression kinds, so one menu answers "what is this value?".
- Every kind in both discriminator unions has a card; round-trip preservation is structural — a saved AST must render and re-emit without destruction, so non-editable shapes get read-only badges with lossless recovery, never refusals.
- Validity flows through `useValidityPropagator` (the shared parent-boundary hook) and a WeakMap per-row shadow that survives reorder. `OptionalSlotCard`'s slot-presence short-circuit is load-bearing: an undefined slot reports valid regardless of stale inner shadows.
- `setOptionalSlot` drops cleared keys by destructuring — the doc store applies module patches via `Object.assign`, which would persist `key: undefined` as a real own property and break `key in config` checks.

## Preview data binding

Server-only I/O (`caseDataBindingHelpers`, `import "server-only"`) is split from the client-safe surface (`caseDataBindingClient`) because `@google-cloud/cloud-sql-connector` would otherwise leak into the client bundle. Client code imports values only through the client module; vitest aliases `server-only` to its shipped shim because vitest ignores the `react-server` export condition.
