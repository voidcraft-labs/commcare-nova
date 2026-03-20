# Preview Components

Client-side web preview with cyan accent theme (`.preview-theme` in globals.css).

## Navigation Shell

- **PreviewShell** — Screen dispatch container. Accepts optional `nav` prop (from `usePreviewNav`) and `hideHeader` — when used inside BuilderLayout, the header is rendered externally in the subheader bar and nav state is shared via prop. Content fills the full pane (no border/padding wrapper).
- **PreviewHeader** — Back button, breadcrumb, actions slot. Used by PreviewShell when rendering standalone (not used by BuilderLayout).
- **ViewModeToggle** (`ViewModeToggle.tsx`, renamed from PreviewToggle) — Compact `h-[34px]` 3-segment control: `[Overview] [✏ Design] [▶ Preview]` with icons. Each mode has a distinct accent: Overview is neutral, Design uses cyan, Preview uses emerald. Active indicator animated via `layoutId="view-mode-indicator"`. Rendered in BuilderLayout's full-width toolbar (Tier 3).

## Screens

- **HomeScreen** — Module cards
- **ModuleScreen** — Form list within a module
- **CaseListScreen** — Case selector for followup forms (generates dummy data from CaseType)
- **FormScreen** — Form entry with question fields, submit button (preview mode only), reset button in header (preview mode only), scroll-to-first-error on validation failure. Wraps form body in `EditContextProvider` when builder is present. Blocks followup forms in preview mode without case data (shows "no cases" error).

## Edit Mode

Preview is an always-editable canvas. `EditContextProvider` (`hooks/useEditContext.tsx`) threads `builder`, `moduleIndex`, `formIndex`, and `mode` ('edit' | 'test') through the tree.

### Selection

Click a question → `builder.select()` → outline highlight + DetailPanel sidebar (inline in both overview and preview modes). Shared with TreeView via same `builder.selected` state. `EditableQuestionWrapper` scrolls selected question into view via ref callback on selection change (250ms delay for AnimatePresence transitions).

### Drag & Drop

Uses `@dnd-kit/react` — `DragDropProvider` wraps the question list, each question uses `useSortable`. `RestrictToElement` modifier confines drag to the preview pane. `PointerSensor` with 5px distance activation constraint distinguishes click from drag. `DragOverlay` renders a simplified label card following the cursor.

### Insertion

`InsertionPoint` — zero-height hover zones between questions. Expand on hover with CSS height transition to reveal a line + plus button. `QuestionTypePicker` (floating-ui popover) opens on click for type selection. Inserts via `mb.addQuestion()` with `atIndex` for exact array position.

**Velocity-aware hover**: FormRenderer tracks cursor speed via EMA-smoothed velocity (α=0.01, document-level mousemove + wheel listeners, ref-based, no re-renders). InsertionPoints check the speed ref on mouseenter — slow cursor (< 0.01 px/ms) shows immediately, fast cursor enters a polling loop (16ms interval) that decays the EMA (0.15/tick) when the cursor is stationary (no mousemove for 32ms). Scroll speed is included so fast scrolling suppresses triggers. Prevents accidental triggers when traversing the question list quickly.

### Delete

Trash icon on hover/selection in `EditableQuestionWrapper`. Deletes immediately (no confirmation — undo/redo is the safety net). Selects nearest sibling after deletion.

## Form Components

- **FormRenderer** — Iterates visible questions, wraps each in `SortableQuestion` + `EditableQuestionWrapper`, interleaves `InsertionPoint` zones. Manages drag state and cursor velocity tracking. In edit mode, `SortableQuestion` passes a clean `displayState` (empty value, untouched, valid) to field components so preview inputs appear pristine. Each question wrapper has a `data-question-id` attribute for focus targeting.
- **EditableQuestionWrapper** — Hover chrome (outline with `outline-offset-3`), click-to-select, delete button, hold-to-grab cursor (300ms timer). `pointer-events-none` on children prevents form input interaction in edit mode. `data-question-wrapper` attribute for nested click delegation. Outline is always faintly visible (10% opacity) to show click targets, brightens on hover (30%), full on selection. Uses `outline` instead of `ring` so the border projects outward without affecting layout — question content stays pixel-aligned with preview mode. **Portal guard:** `onClickCapture` checks `e.currentTarget.contains(target)` first — React synthetic events from `FloatingPortal`-rendered children (e.g. `QuestionTypePicker`) still bubble through the React tree even though their DOM target is outside the wrapper. Without this guard, the capture handler would swallow portal clicks and select the parent question.
- **QuestionField** — Dispatches to type-specific field component. When `state.caseRef` is set (unresolved case property in edit mode), renders a `.case-ref` badge instead of any input.

### Field Components

`TextField`, `NumberField`, `DateField`, `SelectOneField`, `SelectMultiField`, `GroupField`, `RepeatField`, `LabelField`, `MediaField`, `ConstraintError`

Each field calls `engine.setValue(path, value)` on change and `engine.touch(path)` on blur. Blur only validates constraints — required validation is deferred to submit. Errors display via `ConstraintError` when `state.touched && !state.valid`.

## Design vs Preview Mode

**Design (edit)**: Frozen, stateless view. Inputs appear empty, no validation errors, submit bar hidden. Engine state is preserved internally but suppressed at the display layer. For editing form structure via DetailPanel. Cyan accent for edit chrome (outline selection borders, insertion points, drag overlays). `.design-theme` overrides input borders to neutral gray so cyan selection chrome stands out. Question layout is pixel-aligned with preview mode — outlines project outward via `outline-offset` without affecting content position.

**Preview (test)**: Persistent testing sandbox. Values survive round-trips through design. Validation state resets on exit from test mode (`engine.resetValidation()`) so fields start clean on re-entry. On switch back to preview, all rules (constraints, relevants, calculations) re-evaluate with the current schema against persisted values. `FormScreen` auto-focuses the selected question's input on entry. Blueprint mutations in design (incrementing `mutationCount`) recreate the engine, but `useFormEngine` snapshots and restores values across recreations. Reset button in the form header calls `engine.reset()` to fully reinitialize all values, defaults, and expressions back to the fresh state.

**Focus tracking**: BuilderLayout tracks the last focused question in preview mode via a `focusin` ref callback on the layout container. On Preview → Design switch, this ref drives `builder.select()` so the question the user was typing in becomes selected in design.
