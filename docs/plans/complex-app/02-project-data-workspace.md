# Unit 2 — Lookup-row filter authoring

**PR:** `Author a lookup-backed select's row filter`

**Depends on:** unit 1's `field`-term authoring. · **Blocks:** unit 3.

> Read [the binding contracts](00-contracts.md) first, and
> [what is built](../complex-app-plan.md#the-project-data-workspace) for the
> workspace this completes — the tables, rows, CSV import, conflict handling,
> confirmations, and the options-source binding all ship there.

`LookupOptionsSource.filter` is the last unauthored slot of the lookup
vocabulary. A saved filter already renders read-only in the select's editor,
with a plain explanation of what it narrows and a way to remove it; what
remains is editing one.

## Why it is a separate release

The filter's evaluation scope is a lookup-table ROW, not a case row, and
`lib/commcare/validator/rules/lookupOptionsSource.ts` fixes its admissible
leaves: `table-column` terms of the source table, literals, session and
current-user values, and `field` terms naming an **earlier** form answer in
effective `(order, uuid)` DFS within the current or an enclosing repeat. Case
data and Search answers reject.

Two of those leaves are not authorable in the shared expression editor by
default, and one of them is unit 1's to unlock:

- `table-column` renders as a read-only carrier
  (`components/builder/shared/cards/expression/TermCard.tsx`), and reaching the
  generic term editor with one throws.
- `field` terms become authorable through the optional `formFields` slot unit 1
  adds to the edit context, narrowed by the mounting surface to what the gate
  accepts. Absent means not authorable, so this surface sees the narrowed
  vocabulary until it deliberately opts in.

The editor also has no table awareness yet: `PredicateEditContext` carries
`caseTypes` / `currentCaseType` / `knownInputs` / `caseDataScope`, and
`useResolvedType` builds a `TypeContext` with no `lookupTables`, no
`tableScope`, and no `formFields`.

## What this unit adds

A table-row scope for the shared expression editor — a peer of `CaseDataScope`'s
values, composed the way `PredicateEditProvider` already composes an admission
oracle in front of any caller oracle, so no surface can offer a read the commit
gate would reject. It threads `lookupTables`, `tableScope`, and `formFields`
through the edit context and `useResolvedType`, and makes `table-column` an
authorable value source alongside unit 1's `field` terms.

Build on unit 1's extension point rather than a parallel mechanism.

**Observed:** an author narrows a question's choices to the rows that match an
earlier answer — a district picked on one question filtering the facilities
offered on the next.
