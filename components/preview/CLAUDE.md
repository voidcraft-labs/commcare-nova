# Preview Components

Client-side web preview with cyan accent theme (`.preview-theme` in globals.css).

## Navigation Shell

- **PreviewShell** — Screen dispatch container. Accepts optional `nav` prop (from `usePreviewNav`), `hideHeader`, and `onBack`. When used inside BuilderLayout, the header is rendered externally in the subheader bar, nav state is shared via prop, and `onBack` syncs builder selection on post-submit navigation. Screen transitions use shared `SCREEN_TRANSITION` constants from `screenTransition.ts`. Content fills the full pane (no border/padding wrapper).
- **PreviewHeader** — Nav buttons (back + up via `ScreenNavButtons compact`), breadcrumb, actions slot. Used by PreviewShell when rendering standalone (not used by BuilderLayout).
- **ScreenNavButtons** (`ScreenNavButtons.tsx`) — Back (left arrow) + up (up arrow) nav buttons. Rendered in BuilderLayout's Tier 2 breadcrumb bar (left of `CollapsibleBreadcrumb`) and in standalone `PreviewHeader`. Back steps through history; up navigates to the parent screen. Back disabled when no history; up disabled at home level. Props: `compact` (smaller 18px icons for standalone header).
- **screenTransition.ts** — Shared slide/fade transition constants (`SCREEN_TRANSITION`) consumed by PreviewShell's AnimatePresence. Single source of truth for slide distance, duration, and easing.
- **ViewModeToggle** (`ViewModeToggle.tsx`) — Compact `h-[34px]` 2-segment control: `[✏ Design] [▶ Preview]` with icons. Design uses cyan accent, Preview uses emerald. Active indicator animated via `layoutId="view-mode-indicator"`. Rendered in BuilderLayout's full-width toolbar (Tier 3).

## Screens

- **HomeScreen** — Module cards. `max-w-3xl mx-auto`. Accepts optional `builder`/`mode` for inline app name editing.
- **ModuleScreen** — Form list within a module. `max-w-3xl mx-auto`. Accepts optional `builder`/`mode` for inline module name editing.
- **CaseListScreen** — Case selector for followup forms (reads cached dummy data via `getDummyCases()`). `max-w-3xl mx-auto`.
- **FormScreen** — Form entry with question fields, submit button (preview mode only), reset button in header (preview mode only), scroll-to-first-error on validation failure. Wraps form body in `EditContextProvider` when builder is present. Followup forms without a `caseId` fall back to the first dummy case; blocks with "no cases" error only when no case data is available at all. `max-w-3xl mx-auto`.

Screen titles render in a header row within each screen. Nav buttons (back + up) live in BuilderLayout's Tier 2 breadcrumb bar, not in individual screens. `navigateUp` pushes the parent screen onto the history stack (derived via `getParentScreen` from `lib/preview/engine/types.ts`).

**Inline title editing** — In edit mode, all screen titles (app name, module name, form name) use `EditableTitle` instead of a static `<h2>`. Click to edit, Enter/blur to save, Escape to cancel. A hidden span mirror sizes the input to its exact text width. `SavedCheck` (animated emerald checkmark) renders after the title on Home/Module screens and after the settings button on FormScreen. Form name was removed from `FormSettingsPanel` — the inline title is the primary edit surface. In preview mode, all three screens render `<EditableTitle readOnly />` — the identical `<input>` element with `pointer-events-none` — so the title occupies the same box in both modes and there is no layout shift on toggle. **Inline form type** — In edit mode, the form type icon (left of title) is a `FormTypeButton` (`p-1.5` padding) that opens a floating dropdown (`FormTypeDropdown`) to change the type. In preview mode, the icon is wrapped in a matching `p-1.5` span so the title stays at the same horizontal position. Violet dot + highlight marks the current selection. Form type was removed from `FormSettingsPanel` — the settings panel now only contains close case info and Connect configuration.

## Edit Mode

Preview is an always-editable canvas. `EditContextProvider` (`hooks/useEditContext.tsx`) threads `builder`, `moduleIndex`, `formIndex`, and `mode` ('edit' | 'test') through the tree.

### Selection

Click a question → `builder.select()` → outline highlight + DetailPanel sidebar. Shared with Structure tree (in LeftPanel) via same `builder.selected` state.

**Cross-panel scroll sync** — scroll is source-driven, never self-scroll:
- **Design canvas click** → `EditableQuestionWrapper` scrolls the matching tree row into view (queries `[data-tree-question]`), only if not already visible.
- **Tree click** → `handleTreeSelect` in BuilderLayout scrolls the design canvas to the selected question only if not already visible (queries `[data-question-id]`, 250ms delay for AnimatePresence, visibility check against `[data-preview-scroll-container]`, `block: 'start'` with 20px `scrollMarginTop`).
- Clicking an item does NOT scroll its own panel.

### Drag & Drop

Uses `@dnd-kit/react` with cross-level support — a single `DragDropProvider` at the root `FormRenderer` wraps all question levels. Each `SortableQuestion` uses `useSortable` with `group` (`${parentPath}:container` or `'__root__'`), `type: 'question'`, `accept: 'question'`, enabling items to be dragged in and out of groups/repeats at any depth. `RestrictToElement` modifier confines drag to the preview pane. `PointerSensor` with 5px distance activation constraint distinguishes click from drag. `DragOverlay` renders a simplified label card following the cursor. Nested `FormRenderer` instances (inside groups/repeats) do NOT create their own `DragDropProvider` — they participate in the root's drag context. Circular nesting (dragging a group into itself or its descendants) is prevented at the data layer.

**Empty group drop targets**: `GroupField` and `RepeatField` use `useDroppable` on their inner children container (`id: ${questionPath}:container`, `type: 'container'`, `accept: 'question'`, `collisionPriority: CollisionPriority.Low`). This is necessary because dnd-kit's `OptimisticSortingPlugin` only processes `SortableDroppable` instances — plain `useDroppable` targets are invisible to it. The `:container` suffix separates the droppable id from the group's sortable id. Group/repeat `SortableQuestion` elements use `collisionPriority: CollisionPriority.Lowest` so the inner container droppable (Low) wins collision detection over the outer sortable when items are dragged over the content area.

**Controlled drag state** (follows dnd-kit's [droppable columns pattern](https://dndkit.com/react/guides/multiple-sortable-lists)): `DragReorderContext` shares a `DragReorderState` (items map + questions lookup) from the root FormRenderer to nested instances. `onDragStart` snapshots the question tree into a flat `Record<group, questionPath[]>` map via `buildDragState()`. `onDragOver` uses the `move` helper from `@dnd-kit/helpers` to update this React state as items cross groups — required because `useDroppable` targets need the `move` helper's `target.id in items` check to detect container drops. `onDragEnd` defers state cleanup via `queueMicrotask` (dnd-kit fires it during `useInsertionEffect` where React 19 forbids `setState`), reads the item's final group and index from the items map, and uses neighboring items as `afterPath`/`beforePath` references for `mb.moveQuestion()`. During drag, `visibleQuestions` renders from the items map so the UI reflects cross-group moves in real time.

### Insertion

`InsertionPoint` — zero-height hover zones between questions. Expand on hover with CSS height transition to reveal a line + plus button. `QuestionTypePicker` (floating-ui popover, `z-popover-top`) opens on mousedown for type selection. Inserts via `mb.addQuestion()` with `atIndex` for exact array position. Uses `onMouseDown` (not `onClick`) so the open action runs in the same browser event as `useDismissRef` handlers on other popovers — React batches both state updates into a single DOM commit, preventing intermediate layout shifts when switching between insertion points. Calls `dismissContentPopovers()` before opening to close any active content popovers (form settings, form type, connect settings, contextual editor).

**Velocity-aware hover**: Root FormRenderer tracks cursor speed via EMA-smoothed velocity (α=0.01, document-level mousemove + wheel listeners, ref-based, no re-renders). Speed refs are shared to nested FormRenderers via `CursorSpeedContext` — without this, nested instances would create their own zero-initialized refs and insertion points inside groups would always open. InsertionPoints check the speed ref on mouseenter — slow cursor (< 0.01 px/ms) shows immediately, fast cursor enters a polling loop (16ms interval) that decays the EMA (0.15/tick) when the cursor is stationary (no mousemove for 32ms). Invisible hover detector extends ±8px above/below each insertion point. Scroll speed is included so fast scrolling suppresses triggers.

### Delete

Trash icon on hover/selection in `EditableQuestionWrapper`. Deletes immediately (no confirmation — undo/redo is the safety net). Selects nearest sibling after deletion.

## Form Components

- **FormRenderer** — Iterates visible questions, wraps each in `SortableQuestion` + `EditableQuestionWrapper`, interleaves `InsertionPoint` zones. Manages controlled drag state (`DragReorderContext`), cursor velocity tracking (`CursorSpeedContext`), and provides both contexts to nested instances. During drag, renders from the controlled items map; otherwise from the questions prop. In edit mode, `SortableQuestion` passes a clean `displayState` (empty value, untouched, valid) to field components so preview inputs appear pristine, and **skips the `!state.visible` check** so questions with unsatisfied relevant conditions are still shown. **Hidden questions** are included in the visible list and drag state in edit mode (rendered as `HiddenField`), but filtered out in preview mode at the list level to avoid unnecessary `useSortable` hook execution. Each question wrapper has a `data-question-id` attribute for focus targeting. Uses stable `questionPath` keys so React doesn't unmount/remount during reorder.
- **EditableQuestionWrapper** — Hover chrome (outline with `outline-offset-3`), click-to-select, delete button, hold-to-grab cursor (300ms timer). `pointer-events-none` on children prevents form input interaction in edit mode. `data-question-wrapper` attribute for nested click delegation. Outline is always faintly visible (10% opacity) to show click targets, brightens on hover (30%), full on selection. Uses `outline` instead of `ring` so the border projects outward without affecting layout — question content stays pixel-aligned with preview mode. **Anchor registration:** React 19 ref callback with cleanup — when the wrapper mounts and `isSelected`, it registers `{ el, path }` on `builder.setQuestionAnchor()`, deregisters on unmount/deselect. This lets `ContextualEditor` reactively position itself without DOM queries, critical for cross-form navigation where the element isn't in the DOM yet. **Portal guard:** `onClickCapture` checks `e.currentTarget.contains(target)` first — React synthetic events from `FloatingPortal`-rendered children (e.g. `QuestionTypePicker`) still bubble through the React tree even though their DOM target is outside the wrapper. Without this guard, the capture handler would swallow portal clicks and select the parent question.
- **QuestionField** — Dispatches to type-specific field component.
- **HelpTooltip** — Inline (?) icon rendered next to the question label when `question.help` is set. In preview mode, hovering/focusing shows a floating-ui tooltip with the markdown-rendered help text. In design mode, the icon renders at reduced opacity with no interaction (indicates help is configured without being functional).

### Field Components

`TextField`, `NumberField`, `DateField`, `SelectOneField`, `SelectMultiField`, `GroupField`, `RepeatField`, `LabelField`, `MediaField`, `HiddenField`, `ValidationError`

Each field calls `engine.setValue(path, value)` on change and `engine.touch(path)` on blur. Errors display via `ValidationError` when `state.touched && !state.valid`.

## Design vs Preview Mode

**Design (edit)**: Frozen, stateless view. Inputs appear empty, no validation errors, submit bar hidden. Engine state is preserved internally but suppressed at the display layer. For editing form structure via ContextualEditor. Cyan accent for edit chrome (outline selection borders, insertion points, drag overlays). `.design-theme` overrides input borders to neutral gray so cyan selection chrome stands out. Question layout is pixel-aligned with preview mode — outlines project outward via `outline-offset` without affecting content position. **All questions are shown regardless of relevant conditions** — the visibility check is skipped in edit mode so the full form structure is always visible for editing. **Hidden questions** are rendered as compact `HiddenField` cards (dashed border, eye-off icon, question ID, truncated calculate/default expression) — clickable and draggable like any other question. They're excluded from Tab/Shift+Tab keyboard navigation since they have no input to focus.

**Preview (test)**: Persistent testing sandbox. Values survive round-trips through design. Validation state resets on exit from test mode (`engine.resetValidation()`) so fields start clean on re-entry. On switch back to preview, all rules (validations, relevants, calculations) re-evaluate with the current schema against persisted values. `FormScreen` auto-focuses the selected question's input on entry. Blueprint mutations in design (incrementing `mutationCount`) recreate the engine, but `useFormEngine` snapshots and restores only user-touched values across recreations — untouched fields pick up new defaults. Reset button in the form header calls `engine.reset()` to fully reinitialize all values, defaults, and expressions back to the fresh state.

**Flipbook scroll sync**: Switching between design and preview preserves scroll position so the same question stays at the same pixel offset — like flipping between two duplicate pages. `handleViewModeChange` (in BuilderLayout) captures the topmost visible question and its offset from the scroll container before the state change. A `useLayoutEffect` fires after React updates the DOM (questions appear/disappear) but before paint, adjusting `scrollTop` to re-align the anchor. If the anchor question is hidden by relevancy in preview mode, the nearest visible question above it is used as the fallback anchor. The scroll container is marked with `data-preview-scroll-container` on PreviewShell's inner scroll div.

**Focus tracking**: BuilderLayout tracks the last focused question in preview mode via a `focusin` ref callback on the layout container. On Preview → Design switch, this ref drives `builder.select()` so the question the user was typing in becomes selected in design.
