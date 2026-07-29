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

**Observed:** an author creates a lookup table, pastes a CSV over it, points a
select at one of its columns, and is told plainly which apps a destructive change
would break before it happens.
