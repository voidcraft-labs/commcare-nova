# Web Preview Engine

Client-side form preview running entirely from `AppBlueprint` — no XForm parsing, no server calls.

## Three Subsystems

**1. XPath Evaluator** (`xpath/`) — Reuses the Lezer parser from `lib/codemirror/xpath-parser.ts`. Walks CST to evaluate paths, arithmetic, comparisons, logical ops, function calls, and hashtag refs. Function registry in `functions.ts` (~35 functions).

**2. Form Engine** (`engine/`) — Reactive state machine. Initializes from `BlueprintForm` + `CaseType` metadata. Maintains `DataInstance` (values by path), builds `TriggerDag` from XPath expressions, cascades recalculation on every value change.

**3. Preview UI** (`components/preview/`) — Navigation shell: Home → Module → (Case List →) Form Entry. Cyan accent theme (`.preview-theme` in globals.css).

## XPath Evaluator — Lezer Grammar Gotcha

The grammar produces **two distinct `Child` node types** (one from `rootStep`, one from `expr`) and two `Descendant` types. `one('Child')` only finds the first. The evaluator and dependency extractor use `many('Child')` to create `Set` collections and check with `.has()` — same pattern the formatter uses for `Keywords`.

## Form Engine Lifecycle

**On init**: merge data model defaults → build DataInstance → preload case data (followup) → build TriggerDag → init QuestionStates → apply `default_value` (one-time) → full cascade.

**On `setValue(path)`**: update instance → DAG cascade (topologically sorted) → re-evaluate expressions per affected path (calculate, relevant, required, constraint) → re-validate constraint.

**On `touch(path)` (blur)**: mark touched → validate (required + constraint).

**On `validateAll()` (submit)**: mark all visible fields touched → validate each → return boolean. `FormScreen` scrolls to first error on failure.

**Validation display**: errors show only when `state.touched && !state.valid`. Fields start untouched — no error spam on load.

## Navigation Flow (matches CommCare)

```
Home (module cards)
  → Module (form list)
    → Registration/Survey → Form opens directly
    → Followup → Case list ("Select a case") → Form with case data
```

Case list is a gate for a specific followup form, not a module-level screen. Selected row passes properties as `caseData` to `FormEngine`.

## Key Files

- `xpath/dependencies.ts` — extracts `/data/...` path refs from XPath for DAG construction
- `xpath/rewrite.ts` — Lezer-based XPath rewriting for rename propagation
- `engine/dataInstance.ts` — flat `Map<path, value>` with repeat group support
- `engine/triggerDag.ts` — dependency graph + topological cascade ordering
- `engine/outputTag.ts` — parse/resolve/rewrite `<output value="..."/>` tags via htmlparser2
- `engine/dummyData.ts` — generates realistic placeholder case rows from CaseType
