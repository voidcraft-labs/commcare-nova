# Unit 1 — Case-operation authoring

**PR:** `Author a form's case operations in the builder`

**Depends on:** nothing outstanding. · **Blocks:** unit 3.

> Read [the binding contracts](00-contracts.md) first, and
> [what is built](../complex-app-plan.md#case-operations) for the vocabulary this
> unit exposes — case operations already validate, emit, and preview, and
> [display conditions](../complex-app-plan.md#display-conditions) already carry
> the condition-authoring idiom this unit reuses.

Build the URL-owned, responsive authoring surface for a form's ordered case
operations. The stress case is 20 operations on one form: default to a
list-plus-editor master/detail model with keyboard reorder and dependency-aware
review states. A configuration URL's global Preview action runs its owning form.

These surfaces live in the existing builder chrome, not a new workspace: the
inspector rail owns per-operation settings and the centre canvas owns the list
plus the full editor for any `Predicate` slot, matching where display conditions
already put a module's or a form's condition. A `Predicate` is entered through
the structured builder (`PredicateWorkbench` + `ConditionSlotSetting`); the
`lib/codemirror` XPath editor stays the escape hatch for reading, not the primary
authoring path.

`lib/doc/caseOperationMutations.ts` already holds the semantic add / update /
remove / move planners, and `lib/doc/caseOperationOrder.ts` the dependency and
conditional-guard analysis. **The reorder and delete affordances must surface
what those planners already refuse, before the gesture rather than after it** — a
keyboard reorder that silently bounces off the commit gate is a failure of this
unit. Remove refuses while any target, link, expression, or predicate holds an
`id-of` edge to the operation; move refuses dependency inversion, target-type
transition inversion, possible-runtime-alias inversion, and multiplicity-scope
inversion. Every refusal reads person-to-person and names the operation it is
about.

Operations ride `updateForm.caseOperationChange`. Do not mint a new discriminator.

Unit 1's mutation inputs carry no options-source vocabulary — that belongs to
unit 2 — and no SA or MCP surface, which unit 3 owns. Neither is an ordering
constraint: the three units are independent until unit 3 needs both.

**Observed:** an author writes a form's case operations without touching chat,
reorders them from the keyboard, is told why a move or a removal is refused
before it happens, and submits the form in the running preview to see the
operations execute against real case rows.
