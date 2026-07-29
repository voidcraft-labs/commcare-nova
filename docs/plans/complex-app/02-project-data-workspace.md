# Unit 2 — Project data tables workspace

**PR:** `Project data workspace: schema, rows, CSV import, and options sources`

**Depends on:** unit 18. · **Blocks:** unit 3.

> Read [the binding contracts](00-contracts.md) first — the workspace-structure
> and exact-reference-governance rules there bind this unit — and
> [what is built](../complex-app-plan.md#what-is-built) for the lookup
> persistence boundary, the caps, and the schema-governance entry point.

Build the Project data workspace: schema and row grid, atomic CSV import,
revisions, conflict handling, permissions, Project switching, and the select
options-source editor. It is reachable from expanded and collapsed desktop
navigation and the mobile path menu, and never appears as an app-content tree
child. It always states that a change affects every referencing app.

This unit also gives `applyLookupSchemaGovernance` its confirmation UX, which is
what lets table deletion, column removal, and column retype leave package-private
scope. Each still requires `delete` plus zero applicable edges.

Select source modes are exclusive and valid by construction. Unit 18 replaces
the parallel `options[]` plus optional lookup override with one required
`optionsSource` discriminated union:

- `inline` owns at least two fully identified inline options;
- `lookup` owns the table, value/label columns, and optional row filter, and
  carries no dormant inline receiver body.

There is no precedence rule, null clear, or inactive fallback to preserve. A
mode switch opens the target mode's complete editor and commits one atomic
replacement only after it is valid: Inline → Table requires a valid table/column
selection; Table → Inline requires an explicitly authored set of at least two
inline options. Cancel leaves the existing source untouched. Every emitter,
Preview evaluator, mutation, reference fingerprint, SA/MCP schema, and read
projection branches on the same discriminator.

The optional row filter is first-class authoring, not an opaque AST slot.
Absence offers every row. Presence evaluates once for each row of the selected
source table in an explicit `table-row` scope. A `table-column` term names the
active table UUID plus one of that table's current column UUIDs; columns from a
different table, deleted columns, and a matching UUID paired with the wrong
table all reject. The general `table-lookup` value-expression arm owns a fresh
row scope for its own `where`, so it is available on admitted non-row-filter
surfaces but cannot nest inside this already-active row scope. There is no
implicit current table, column wire-name fallback, lookup tag, or row-position
address.

Within a select's row filter, authors may compare the active row's columns with
fixed/calculated values, current-user/session values, and eligible answers from
the select's own form. A form-field term names the field UUID introduced by
Unit 1. The field must carry one answer, precede the receiving select in the
form's canonical depth-first `fieldOrder`, and be at form root or in the
receiving select's current or an enclosing repeat. The receiving field itself,
containers and other no-answer fields, later fields, foreign-form fields, and
answers in a child, sibling, or unrelated repeat are unavailable. Case
properties/relationships and Search-input terms are unavailable because choice
rows are built without a selected case or Search screen. These exclusions bind
all nested expression operands, not only the first comparison's visible terms.

One pure, document-aware admission oracle derives effective form order, repeat
ancestry, answer-bearing fields, the active table, and its exact column catalog.
The builder's term inventories, disabled reasons, and complete predicate seeds
use that oracle; the commit gate uses the same oracle against the fenced Project
lookup revision for builder, SA, MCP, imported, moved, and concurrently changed
documents. Moving a field or changing table schema therefore recomputes
admission rather than preserving a once-valid choice. Add-rule and kind/source
transitions commit only a complete predicate whose table/column and operand
types are already admitted—never placeholder identities, empty table scopes, or
a half-authored invalid tree. Direct callers receive the same keyed finding the
UI prevented.

**Observed:** an author creates a lookup table, pastes a CSV over it, points a
select at one of its columns, and is told plainly which apps a destructive change
would break before it happens.
