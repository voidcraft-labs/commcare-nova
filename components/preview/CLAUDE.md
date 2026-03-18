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
- **FormScreen** — Form entry with question fields, submit button, scroll-to-first-error on validation failure. Wraps form body in `EditContextProvider` when builder is present.

## Edit Mode

Preview is an always-editable canvas. `EditContextProvider` (`hooks/useEditContext.tsx`) threads `builder`, `moduleIndex`, `formIndex`, and `mode` ('edit' | 'test') through the tree.

### Selection

Click a question → `builder.select()` → ring highlight + DetailPanel sidebar (inline in both tree and preview modes). Shared with TreeView via same `builder.selected` state.

### Drag & Drop

Uses `@dnd-kit/react` — `DragDropProvider` wraps the question list, each question uses `useSortable`. `RestrictToElement` modifier confines drag to the preview pane. `PointerSensor` with 5px distance activation constraint distinguishes click from drag. `DragOverlay` renders a simplified label card following the cursor.

### Insertion

`InsertionPoint` — zero-height hover zones between questions. Expand on hover with CSS height transition to reveal a line + plus button. `QuestionTypePicker` (floating-ui popover) opens on click for type selection. Inserts via `mb.addQuestion()` with `atIndex` for exact array position.

**Velocity-aware hover**: FormRenderer tracks cursor speed via EMA-smoothed velocity (ref-based, no re-renders). InsertionPoints check the speed ref on mouseenter — slow cursor shows immediately, fast cursor waits for slowdown or 200ms fallback. Prevents accidental triggers when traversing the question list quickly.

### Delete

Trash icon on hover/selection in `EditableQuestionWrapper`. `ConfirmDialog` for confirmation. Selects nearest sibling after deletion.

### Visual Indicators

`LogicBadges` — small icon badges for `relevant` (cyan), `constraint` (amber), `calculate` (violet) on questions that have logic expressions.

## Form Components

- **FormRenderer** — Iterates visible questions, wraps each in `SortableQuestion` + `EditableQuestionWrapper`, interleaves `InsertionPoint` zones. Manages drag state, delete confirmation, and cursor velocity tracking.
- **EditableQuestionWrapper** — Hover chrome (ring, grip handle), click-to-select, delete button, hold-to-grab cursor (300ms timer). `pointer-events-none` on children prevents form input interaction in edit mode. `data-question-wrapper` attribute for nested click delegation.
- **QuestionField** — Dispatches to type-specific field component

### Field Components

`TextField`, `NumberField`, `DateField`, `SelectOneField`, `SelectMultiField`, `GroupField`, `RepeatField`, `LabelField`, `MediaField`, `ConstraintError`

Each field calls `engine.setValue(path, value)` on change and `engine.touch(path)` on blur. Errors display via `ConstraintError` when `state.touched && !state.valid`.
