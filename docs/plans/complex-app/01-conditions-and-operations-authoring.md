# Unit 1 — Conditions and operations authoring

**PR:** `Author display conditions and case operations in the builder`

**Depends on:** nothing outstanding. · **Blocks:** unit 3.

> Read [the binding contracts](00-contracts.md) first, and
> [what is built](../complex-app-plan.md#what-is-built) for the vocabulary this
> unit exposes — display conditions and case operations already validate, emit,
> and preview.

Build URL-owned, responsive authoring surfaces for the display-condition and
case-operation vocabulary that already validates, emits, and previews. The
operations stress case is 20 items on one form: default to a list-plus-editor
master/detail model with keyboard reorder and dependency-aware review states. A
configuration URL's global Preview action runs its owning form.

These surfaces live in the existing builder chrome, not a new workspace: the
inspector rail owns per-item settings and the centre canvas owns the full
condition editor, matching where the case workspace already puts a search-button
condition. A `Predicate` is entered through the structured builder; the
`lib/codemirror` XPath editor stays the escape hatch for reading, not the primary
authoring path.

Unit 1's mutation inputs carry no options-source vocabulary — that belongs to
unit 2 — and no SA or MCP surface, which unit 3 owns. Neither is an ordering
constraint: the three units are independent until unit 3 needs both.

**Observed:** an author writes a module or form display condition and a form's
case operations without touching chat, sees the condition's effect in the running
preview, and reorders operations from the keyboard.
