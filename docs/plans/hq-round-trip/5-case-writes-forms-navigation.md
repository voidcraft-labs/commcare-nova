# Step 5: Case writes, forms and navigation (outline)

Planned in full when step 4 exits. The design is the research's "Case writes",
"Questions" (query repeats and repeat counts), "Navigation and after-submit
links", "Case lists and search", and defects 21 to 30.

## What it builds

1. **Case writes as one concept** (defect 22). A form's case writes are its case
   operations; a field's `caseWrite` is that field's view of a write. `via` and
   `onlyIfChanged` belong to the write. A registration may close the case it
   creates, with open and close conditions.
2. **Placement.** Each operation has a placement: a basic form action slot, an
   advanced action and its tag, or a Save to Case block. A new operation takes
   the simplest placement that can express it. The publish that first carries an
   operation records its placement through a new `publish-placement` app change,
   which open builder tabs fold without a reload. Edits the held placement
   cannot express move it, as an identity edit the builder, SA and MCP state
   before it commits.
3. **Advanced modules.** Advanced-module emission for the placements and case
   selections that need it, the held advanced kind, and HQ's advanced-module
   rules enforced by the validator.
4. **Extension child cases** (defect 24) as case operations with an extension
   link; the inert basic subcase goes.
5. **Attachment mode removed** (defect 23); a capture reaches a case only as a
   link write.
6. **Query-repeat placement** (defect 25): model iteration or count repeat, held
   once published.
7. **Repeat counts as integers** (defect 30), with the integer type added to
   Nova's expression types.
8. **The search workflow setting** (defect 21): list first, search first, or skip
   to default results, with list first only in Android-only apps.
9. **Form links with CommCare's semantics** (defect 26): every matching
   destination runs, in the author's order, with "otherwise", self-links as
   "start this form again", and the validator refusing link targets HQ does not
   offer.
10. **`group.fieldList`** (defect 27).
11. **Explicit preloads and markdown** (defect 28).
12. **Renamed menu concepts** (defect 29): `Module.caseListRegistrationForm`,
    `Module.caseListMenuItem`, and the search workflow setting.

Advanced-module emission also makes defect 20's CommTrack `product_id` datum
reachable from a Nova export. Step 4's CommTrack confirmation already covers an
app with an advanced module whose case list menu item is on, so this step's
plan proves, under the harness's CommTrack seam, that publish asks for that
confirmation before such an app reaches a CommTrack project space.

Once a form may create a basic child case of its own menu's case type, this
step's plan also adds defect 12's `DONT_INDEX_SAME_CASETYPE` refusal at
publish, with the offered move to a Save to Case placement. No Nova document
can hold that shape before then, so step 2 has nothing to guard.

## Cutover and migration

One cutover, carrying every migration defects 21 to 30 name: field writes into
operations with their published placements (read from each deployment's drift
baseline), extension child cases, attachment-mode writes to link writes, query
repeat placements, counts, form-link guards to conditions and "otherwise",
field-list flags, explicit preloads, and the renamed concepts. The migration
names every app and entity it changes.

## Contracts

The contracts table's step 5 rows: the `__nova_` count container, `count_bound`,
`query_bound`, `__nova_subcases`, the `publish-placement` change kind (in
`lib/db/CLAUDE.md`, `contracts.md` twice, and the root `CLAUDE.md`), the
`caseWrite` sentence, the form-type sentence, `casePreload.ts`, the form
`entry` sentence, attachment display, markdown itext, and the exclusive-guard
sentence.

## Exit

Proofs 1 to 5 pass on every Nova export, including a republish after each
migration.
