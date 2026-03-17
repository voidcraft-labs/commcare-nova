# Preview Components

Client-side web preview with cyan accent theme (`.preview-theme` in globals.css).

## Navigation Shell

- **PreviewShell** — Top-level container with navigation + screen dispatch
- **PreviewHeader** — Back button, breadcrumb, actions slot
- **PreviewToggle** — Segmented `[Tree View] [Preview]` control

## Screens

- **HomeScreen** — Module cards
- **ModuleScreen** — Form list within a module
- **CaseListScreen** — Case selector for followup forms (generates dummy data from CaseType)
- **FormScreen** — Form entry with question fields, submit button, scroll-to-first-error on validation failure

## Form Components

- **FormRenderer** — Iterates visible questions
- **QuestionField** — Dispatches to type-specific field component

### Field Components

`TextField`, `NumberField`, `DateField`, `SelectOneField`, `SelectMultiField`, `GroupField`, `RepeatField`, `LabelField`, `MediaField`, `ConstraintError`

Each field calls `engine.setValue(path, value)` on change and `engine.touch(path)` on blur. Errors display via `ConstraintError` when `state.touched && !state.valid`.
