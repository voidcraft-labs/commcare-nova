# Preview Components

Client-side web preview with cyan accent theme (`.preview-theme` in globals.css).

## Navigation Shell

- **PreviewShell** — Screen dispatch container. Accepts optional `nav` prop (from `usePreviewNav`) and `hideHeader` — when used inside BuilderLayout, the header is rendered externally in the subheader bar and nav state is shared via prop. Content fills the full pane (no border/padding wrapper).
- **PreviewHeader** — Back button, breadcrumb, actions slot. Used by PreviewShell when rendering standalone (not used by BuilderLayout).
- **PreviewToggle** — 3-segment control: `[Tree] [⏸ Preview] [▶ Live]` with icons. Live segment uses emerald accent. Rendered in BuilderLayout subheader toolbar.

## Screens

- **HomeScreen** — Module cards
- **ModuleScreen** — Form list within a module
- **CaseListScreen** — Case selector for followup forms (generates dummy data from CaseType)
- **FormScreen** — Form entry with question fields, submit button, scroll-to-first-error on validation failure. Wraps form body in `EditContextProvider` when builder is present. Blocks followup forms in live mode without case data (shows "no cases" error).

## Edit Mode

Preview is an always-editable canvas. `EditContextProvider` (`hooks/useEditContext.tsx`) threads `builder`, `moduleIndex`, `formIndex`, and `mode` ('edit' | 'test') through the tree.

### Selection

Click a question → `builder.select()` → ring highlight + DetailPanel sidebar (inline in both tree and preview modes). Shared with TreeView via same `builder.selected` state. `EditableQuestionWrapper` scrolls selected question into view via ref callback on selection change (250ms delay for AnimatePresence transitions).

### Drag & Drop

Uses `@dnd-kit/react` — `DragDropProvider` wraps the question list, each question uses `useSortable`. `RestrictToElement` modifier confines drag to the preview pane. `PointerSensor` with 5px distance activation constraint distinguishes click from drag. `DragOverlay` renders a simplified label card following the cursor.

### Insertion

`InsertionPoint` — zero-height hover zones between questions. Expand on hover with CSS height transition to reveal a line + plus button. `QuestionTypePicker` (floating-ui popover) opens on click for type selection. Inserts via `mb.addQuestion()` with `atIndex` for exact array position.

**Velocity-aware hover**: FormRenderer tracks cursor speed via EMA-smoothed velocity (α=0.1, ~160ms window, ref-based, no re-renders). InsertionPoints check the speed ref on mouseenter — slow cursor (< 0.1 px/ms) shows immediately with a 50ms transition delay, fast cursor waits for slowdown or 200ms fallback. Prevents accidental triggers when traversing the question list quickly.

### Delete

Trash icon on hover/selection in `EditableQuestionWrapper`. Deletes immediately (no confirmation — undo/redo is the safety net). Selects nearest sibling after deletion.

## Form Components

- **FormRenderer** — Iterates visible questions, wraps each in `SortableQuestion` + `EditableQuestionWrapper`, interleaves `InsertionPoint` zones. Manages drag state and cursor velocity tracking. In edit mode, `SortableQuestion` passes a clean `displayState` (empty value, untouched, valid) to field components so preview inputs appear pristine. Each question wrapper has a `data-question-id` attribute for focus targeting.
- **EditableQuestionWrapper** — Hover chrome (ring, grip handle), click-to-select, delete button, hold-to-grab cursor (300ms timer). `pointer-events-none` on children prevents form input interaction in edit mode. `data-question-wrapper` attribute for nested click delegation.
- **QuestionField** — Dispatches to type-specific field component. When `state.caseRef` is set (unresolved case property in edit mode), renders a `.case-ref` badge instead of any input.

### Field Components

`TextField`, `NumberField`, `DateField`, `SelectOneField`, `SelectMultiField`, `GroupField`, `RepeatField`, `LabelField`, `MediaField`, `ConstraintError`

Each field calls `engine.setValue(path, value)` on change and `engine.touch(path)` on blur. Errors display via `ConstraintError` when `state.touched && !state.valid`.

## Preview vs Live Mode

**Preview (edit)**: Frozen, stateless view. Inputs appear empty, no validation errors or borders. Engine state is preserved internally but suppressed at the display layer. For editing form structure via DetailPanel.

**Live (test)**: Persistent testing sandbox. Values survive round-trips through preview. On switch back to live, all rules (constraints, relevants, calculations) re-evaluate with the current schema against persisted values. `FormScreen` auto-focuses the selected question's input on entry. Blueprint mutations in preview (incrementing `mutationCount`) recreate the engine, but `useFormEngine` snapshots and restores values across recreations.

**Focus tracking**: BuilderLayout tracks the last focused question in live mode via a `focusin` ref callback on the layout container. On Live → Preview switch, this ref drives `builder.select()` so the question the user was typing in becomes selected in preview.
