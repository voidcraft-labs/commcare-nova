# Unit 2 — Project data tables workspace

**PR:** `Project data workspace: schema, rows, CSV import, and options sources`

**Depends on:** nothing outstanding. · **Blocks:** unit 3.

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

The one non-obvious semantic is that the source-mode switch is **asymmetric**,
because `optionsSource` precedence is presence-based at every consumer
(`lib/commcare/xform/builder.ts` branches on `optionsSource !== undefined`).
Inline → Table merely sets `optionsSource`, and the inline options stay as the
origin-compatible fallback. Table → Inline must emit an explicit
`optionsSource: null` clear; treating the two directions symmetrically ships a
Table → Inline switch that is observably inert, because the retained source keeps
winning.

**Observed:** an author creates a lookup table, pastes a CSV over it, points a
select at one of its columns, and is told plainly which apps a destructive change
would break before it happens.
