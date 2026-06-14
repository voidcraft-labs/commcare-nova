# Plan: VBC Stage 0 — Foundations

Implements Stage 0 of `docs/superpowers/specs/2026-06-09-valid-by-construction-program.md`.
No user-visible behavior change except two bug fixes (rename coverage, cross-depth
move re-anchoring). Tasks are SERIALIZED — one implementer at a time, no parallel
writers. Branch: `docs/valid-by-construction` (worktree
`.claude/worktrees/valid-by-construction/`).

## Task 1 — Reference slot registry

**Files:** `lib/domain/referenceSlots.ts` (new), `lib/domain/index.ts` (export),
`lib/domain/__tests__/referenceSlots.test.ts` (new).

One declarative, typed-total registry of every blueprint slot that can carry a
reference. Shape per entry: owning entity (`field` | `form` | `module`), slot key
path, surface kind (`xpath` | `prose` | `predicate-ast` | `field-id-ref` |
`entity-uuid`), and applicability (which field kinds / form types carry it).

Must cover (audit against the domain schemas, not this list alone):
- Field xpath: `relevant`, `calculate`, `default_value`, `validate`, `required`,
  `repeat_count`, `ids_query`.
- Field prose: `label`, `hint`, `help`, `validate_msg`, `options[].label`.
- Form: `close_condition.field` (field-id-ref), `form_links[].condition` (xpath),
  `form_links[].target` (entity-uuid), `case_preload` keys (field-id-ref),
  connect slots (`assessment.user_score`, `deliver_unit.entity_id`,
  `deliver_unit.entity_name` — xpath).
- Module: `caseListConfig.columns[].field` (case-property ref),
  `caseListConfig.filter` (predicate-ast), calculated column expressions
  (predicate-ast/value-expression), `caseSearchConfig` search-input predicates +
  `searchButtonDisplayCondition` (xpath) + prompt defaults.

Totality: key the registry so adding a new expression-bearing schema property
without classifying it fails a test — enumerate each entity's known keys and
assert every registry path resolves into the Zod schemas (no dead paths), plus a
snapshot-style audit test listing unclassified string-typed keys for human review.
The validator's `XPathSurface` / `ProseSurface` / `ConnectXPathSlot` unions in
`lib/commcare/validator/index.ts` must be derivable from (or asserted equal to)
the registry's projections — add that assertion test now; rewiring the validator
to consume the registry directly can come later.

**Acceptance:** `npm run test` green; the audit test fails if a known
expression-bearing key is missing from the registry (prove by test).

**SHIPPED** (`41d76ba6`) with four reviewed deviations: (a) surface-kind union
is 7, not 5 — `case-property-ref` + `case-type-ref` added (columns' `field`,
`case_property_on`, `module.caseType`); (b) `case_preload` is NOT a registry
slot — form case wiring is derived on demand by `deriveCaseConfig`, nothing
stored to rewrite, so **Task 3 has no case_preload work**; (c)
`searchButtonDisplayCondition` is `predicate-ast` (the schema is
`predicateSchema`), not xpath as written below; (d) plan-missed slots
registered: `formLinks[].datums[].xpath` (xpath),
`caseSearchConfig.excludedOwnerIds` (value-expression),
`searchInputs[].via` (relation-path). 30 slots total. Tasks 3/6/7 consume the
registry as shipped, not as sketched above.

## Task 2 — Matcher unification + multi-segment hashtag rewrites

**Files:** `lib/commcare/hashtagSegments.ts` (new shared segment definition),
`lib/commcare/proseHashtags.ts`, `lib/references/config.ts`,
`lib/preview/xpath/rewrite.ts`, `lib/doc/mutations/pathRewrite.ts`,
`lib/doc/mutations/fields.ts` (moveField arm + `MoveFieldResult`),
`lib/doc/mutations/notify.ts` (toast copy), tests beside each.

1. One shared hashtag-segment source: a TS definition consumed by
   `BARE_HASHTAG_PATTERN` and `HASHTAG_REF_PATTERN` (build both regexes from it).
   The Lezer grammar can't import TS — lockstep is enforced by a divergence-corpus
   test (segments with `-`, `.`, digits, trailing sentence punctuation,
   markdown-adjacent text, multi-segment forms) asserting all three matchers agree
   on every corpus entry. Unified segment must NOT capture trailing sentence
   punctuation (the reason the patterns diverged). If the grammar itself needs a
   token change, rebuild via `npx tsx scripts/build-xpath-parser.ts` and commit
   the generated parser.
2. Multi-segment `#form/` support in both rewriters: rename rewrites the leaf
   segment of nested hashtags (`#form/group/old` → `#form/group/new`); move
   re-anchors across depth (`#form/old` → `#form/group/old`, and the reverse) on
   BOTH xpath and prose surfaces. `droppedCrossDepthRefs` is eliminated —
   `MoveFieldResult` loses the field (or pins it to 0 during a deprecation
   window — pick eliminate; update `notifyMoveRename` and any consumer).
3. The references resolver/linter/autocomplete (`lib/references/`,
   `lib/codemirror/xpath-*`) must resolve multi-segment `#form/` refs (they
   already parse path segments — verify and extend where single-segment is
   assumed).

**Acceptance:** new tests — rename of a field inside a group updates
`#form/group/old` refs; cross-depth move re-anchors refs on xpath AND prose
surfaces and nothing dangles; divergence corpus green; emitter expansion of
multi-segment hashtags already works (`hashtags.ts::resolveFlatHashtag`) — add a
round-trip test re-anchored-ref → emit → expected `/data/...` path.

**SHIPPED** (`f328d294`) with four deviations: (a) the shared segment source
is `lib/domain/hashtagSegments.ts`, NOT `lib/commcare/hashtagSegments.ts` —
`lib/references` is not an allowlisted consumer of the `@/lib/commcare`
boundary (`biome.json::noRestrictedImports`), and both packages may import
`lib/domain`; the provider's `NAMESPACE_RE` is rebuilt from the same source.
(b) The grammar DID need a change, but not a token-charset one: whitespace
skipping applied inside `HashtagRef` (`# form/x` parsed as a ref), an
open-ended skipless rule is inexpressible in LR ("inconsistent skip sets"),
so contiguity rides on zero-width adjacency guards from a new external
tokenizer `lib/commcare/xpath/hashtagGuard.ts` (lookahead-keyed so a guard
never wins a shift the next token would fail); parser regenerated and
committed; hashtag segments are ASCII on every matcher while `NameTest`
keeps Unicode. Blast radius: zero — full suite green, no wire-emitter test
changed. (c) `HASHTAG_REF_PATTERN` narrowed/widened to the unified segment:
dots no longer captured (trailing sentence punctuation fixed), hyphens now
admitted. (d) `notifyMoveRename` copy needed NO change — it never surfaced
the dropped count; its "N references updated" stays accurate (the count now
includes re-anchors). Resolver/linter/autocomplete already resolved
multi-segment refs (nested `formEntries` paths; `extractPathRefs` maps
`#form/a/b` → `/data/a/b`) — pinned by new tests rather than extended.

## Task 3 — Rewriter coverage closure (registry-driven)

**Files:** `lib/doc/mutations/fields.ts` (XPATH_FIELDS/DISPLAY_FIELDS replaced by
registry projections; option-label traversal; delete the stale `required`
comment), `lib/doc/mutations/forms.ts` + `modules.ts` (form/module-level slot
rewrites on rename cascade), `lib/domain/predicate/` (PropertyRef rewrite walk —
new pure helper), tests.

The rename cascade (form-local pass AND case-property cascade) must cover every
registry slot: `required`, `repeat_count`, `ids_query`, `help`, `validate_msg`,
`options[].label`, `close_condition.field`, `form_links[].condition`, connect
xpath slots, case-list/search predicate-AST `PropertyRef`s (case-property cascade
only: rewrite `property` on matching `(caseType, prop)` terms — structural walk
via the existing `walkTerms`/`walkPropertyRefs` pattern, never string surgery),
and `case_preload` keys. Lists derive from the Task-1 registry — the hand-rolled
`XPATH_FIELDS`/`DISPLAY_FIELDS` constants die.

**Acceptance:** per-slot rename tests (each registry slot: create ref → rename →
ref followed); the two live bugs reproduce as failing tests first
(`required` ref breaks on rename today; `help`/`validate_msg`/option-label
hashtags never rewrite today) then pass.

**SHIPPED** (`6498b4fa`) with these deviations/decisions:

- (a) The form/module-level rewrites live in a NEW
  `lib/doc/mutations/referenceRewrites.ts` consumed by the `renameField` /
  `moveField` arms — `mutations/forms.ts` + `modules.ts` are untouched (the
  cascade is a side effect of the renameField reducer, not of form/module
  mutations; the plan's file list was a sketch). Walkers are exhaustive
  switches over the registry's slot-id unions: a new registry slot without a
  rewrite decision is a compile error. A value-level walker for the
  registry's path grammar (`rewriteSlotStrings` — `.` steps, `[]` fan-out,
  total over shape mismatches) was added to `lib/domain/referenceSlots.ts`.
- (b) No `case_preload` work, per Task 1's SHIPPED (derived, never stored).
- (c) Form-link scoping VERIFIED before coding: CCHQ's end-of-form navigation
  installs `link.xpath` verbatim as the SOURCE form's stack-frame condition
  and evaluates manual datum values in the same post-submit context
  (`commcare-hq/.../suite_xml/post_process/workflow.py::
  EndOfFormNavigationWorkflow._get_link_frame`), so `formLinks[].condition` +
  `formLinks[].datums[].xpath` rewrite on the form that OWNS the links —
  never on forms that link INTO the renamed field's form. `datums[].name` is
  the target entry's session-variable wire token; not rewritten.
  `formLinks[].target` is entity-uuid — stable under rename. Connect slots
  rewrite form-locally (the deep validator checks them against the owning
  form's `validPaths`).
- (d) `closeCondition.field` (bare leaf-id ref) follows the rename only when
  the renamed field was the UNIQUE holder of the old id in its form — with a
  cousin still answering to the name, the ref is ambiguous
  (`formActions.ts::findField` takes the first walk-order match) and a
  rewrite would silently retarget it. Consequence: a move-with-dedup never
  rewrites it (the colliding destination sibling still holds the old id).
- (e) PropertyRef matching is on the relation walk's DESTINATION type: origin
  `caseType` for absent/`self` via, the LAST ancestor step's
  `throughCaseType`, `ofCaseType` for subcase/any-relation. Walks WITHOUT an
  explicit destination hint are deliberately skipped — the AST doesn't
  encode where they land, and a guessed rewrite corrupts silently while a
  stale name is at least validator-visible. Helper:
  `lib/domain/predicate/rewrite.ts` (in-place via `walkTerms`, same purity
  contract as `walk.ts`). `searchInputs[].via` itself carries no property
  names (relation ids + case-TYPE hints) — nothing to rewrite on a property
  rename. Simple-input `property` matches on
  `relationDestinationCaseType(via, module.caseType)`.
- (f) `FieldRenameMeta` gains `formWiringRewritten` (DISTINCT forms whose
  wiring slots changed — per-form so cross-pass touches dedupe) and
  `moduleRefsRewritten` (AST `PropertyRef` nodes + simple-input property
  slots); both documented on the type, the latter forces
  `cascadedAcrossForms` (module-level state); form-wiring changes feed
  `affectedForms` so only NON-primary-form wiring flips the flag.
  `xpathFieldsRewritten`'s meaning is unchanged (rename: distinct fields;
  move: per-slot, now also counting the form's wiring slots), so
  `lib/doc/CLAUDE.md`'s contract line and `notifyMoveRename` copy stand.
- (g) The per-kind registry projection exposed schema-unfaithful test
  fixtures (`calculate` parked on text-kind fields — the registry scopes
  `calculate` to hidden only). Twelve fixture sites across three existing
  test files were converted to faithful shapes (hidden for pure calculates;
  `relevant` where one field needs prose + XPath surfaces) rather than
  widening the projection to off-schema keys.
- Slots covered by the cascade now: every registry slot except the
  deliberate non-rewrites — `case_property_on` / `module.caseType`
  (case-TYPE refs; no mutation renames a type), `form_link_target`
  (entity-uuid), `search_input_via` (no property names). Tests: 26 new
  coverage tests + 13 predicate-rewrite tests + 3 path-walker tests;
  failing-first confirmed (22 of 26 failed pre-implementation; the 4
  passing were the negative shapes).

## Task 4 — Identifier guards at source

**Files:** `lib/doc/identifierVerdicts.ts` (new shared verdict module; pure),
`components/builder/editor/FieldHeader.tsx` (consume shared verdict, add
XML-name + length checks to the existing sibling check),
`lib/agent/tools/addFields.ts` + `editField.ts` (or their shared helpers) —
pre-dispatch rejection via the same verdicts, Elm-style messages,
tests beside each.

Verdicts: sibling-id uniqueness (for add + rename), XML element-name legality
(reuse the existing identifier rules in `lib/commcare` — import via the barrel
if allowlisted, else mirror the regex in `lib/domain` and assert-equal test
against the commcare source), reserved `__nova_` prefix, case-property length.
Reducers stay total — no reducer changes in this task.

**Acceptance:** SA `addFields` with a duplicate sibling id fails the call naming
the conflict (test through the tool handler); UI rename to an XML-illegal id
rejects inline (state-model test of the verdict, not RTL); `DUPLICATE_FIELD_ID`
validator rule still passes as backstop.

**SHIPPED** (`01704a03`) with these deviations/decisions:

- (a) Boundary: `lib/doc/identifierVerdicts.ts` imports the identifier
  rules from the `@/lib/commcare` barrel via a new one-file biome
  allowlist entry — the exact `lib/doc/connectConfig.ts` precedent, so
  the "mirror the regex in `lib/domain` + assert-equal test" fallback was
  not needed. Both `noRestrictedImports` message strings updated.
- (b) The case-property length cap is **255** (`MAX_CASE_PROPERTY_LENGTH`,
  CommCare Core's CaseXmlParser constraint, backstopped by
  `CASE_PROPERTY_TOO_LONG`), not the 50 the task sketch carried — 50 is
  the connect-slug `varchar(50)` limit. Boundary tests pin 255-passes /
  256-fails per the real constant.
- (c) The SA/MCP seam is the tool bodies themselves
  (`addFieldsTool.execute` / `editFieldTool.execute`) — the MCP adapter
  (`registerSharedTool`) calls the same `execute`, so one guard covers
  both surfaces; proven by tests driving both `GenerationContext` and
  `McpContext` plus one through the adapter harness. `editField` checks
  the rename verdict BEFORE the convert stage (sibling scope and format
  don't depend on kind), so a rejected rename persists NOTHING — the
  spec's committed-prefix allowance never has to fire for this class.
- (d) The UI add path needed NO verdict wiring (verified):
  `FieldTypePicker` mints `new_<kind>` ids deduped against every field
  id doc-wide (a superset of sibling scope, always XML-legal, never
  `__nova_`-prefixed), and `duplicateField` dedupes sibling ids inside
  the reducer.
- (e) The rename verdict is peer-aware: it scans the destination parent
  of every `(id, case_property_on)` peer the reducer's cascade will
  rename in lockstep, and a cross-form collision names the peer's form
  in the message. `useBlueprintMutations.renameField`'s inline peer scan
  (the client-side duplicate the spec's drift list called out) was
  REPLACED by the shared `findRenameSiblingConflict` — one
  implementation, hook semantics unchanged. `classifyRenameOutcome`
  reshaped from post-dispatch conflict-flag classification to
  pre-dispatch verdict classification (`conflict` arm → `rejected`);
  FieldHeader dispatches only on a clean verdict, chrome unchanged.
- (f) `addFields` fails the WHOLE call when any item's id is rejected —
  the `{ error }` envelope lists EVERY failing item (id + verdict
  message); in-batch sibling collisions are caught via a per-parent
  `pendingSiblingIds` scope threaded through the shared verdict.
  Assembly-failure skips keep their existing skip-and-report semantics.
- Tests: 19 verdict unit tests (each failure class + 255/256 boundary +
  cousins-share + self-rename + peer-cascade cases), 7 `addFields` and
  5 `editField` tool-handler tests (failing-first confirmed: 9 of the
  rejection tests failed pre-implementation), 1 adapter-path test, 4
  reshaped `classifyRenameOutcome` tests. Full suite 5732 passed / 0
  failed; `scripts/test-schema.ts` 21/21 PASS (no schema shape change).

## Task 5 — Catalog sync at source

**Files:** `lib/doc/mutations/fields.ts` (addField/updateField/convertField
arms), tests.

When a field lands with (or gains) a non-empty `case_property_on`, the reducer
appends the `(case_type, property)` pair to `doc.caseTypes[].properties` iff
absent — mirroring what `cascadeCasePropertyRename` already maintains on rename.
Reducer-side so server/client/replay stay byte-identical. Removal does NOT prune
the catalog (declared properties outlive writers by design — the catalog is
authoritative).

**Acceptance:** test — `addFields` introducing a new property makes a subsequent
`#<type>/<prop>` ref validate clean without `setCaseTypes`; existing
catalog-dependent tests unchanged.

**SHIPPED** (`bd25b170`) with these deviations/decisions:

- (a) Arms covered beyond the file-list sketch: `addField`, `updateField`
  (one ensure off the merged parse result covers BOTH `case_property_on`
  patches and `id` patches — patches can carry `id`, only `uuid`/`kind`
  are immutable), `convertField`, **`duplicateField`** (the suffixed root
  clone introduces a new pair; descendant clones re-assert their source
  pairs idempotently), and **`moveField`'s dedup-rename** — verified it
  does NOT ride the rename cascade (`fields.ts` moveField arm writes
  `field.id = deduped` directly, never calling
  `cascadeCasePropertyRename`), so it syncs explicitly. `renameField`
  deliberately unchanged: the cascade already renames the catalog entry
  in place, and post-Task-5 every pair exists at introduction, so the
  rename always finds its entry.
- (b) Undeclared case type → the reducer CREATES a bare
  `{ name, properties }` entry. Evidence for matching the admission
  model: `lib/domain/caseTypes.ts::reachableCaseTypes` already admits an
  undeclared module type's namespace at depth 0 ("recognized even before
  properties exist"), and the case-list rules already admit
  writer-derived properties as real
  (`validator/rules/case-list/shared.ts::augmentCaseType`, priority 3) —
  types come into existence by being named, properties by being written.
  The acceptance criterion ("WITHOUT `setCaseTypes`") is only satisfiable
  this way. Ancestry (`parent_type` / `relationship`) is never invented —
  that stays a `setCaseTypes`-level declaration.
- (c) The kind→`data_type` mapping was RELOCATED, not allowlist-imported:
  the validator rule's module-private `expectedDataType` switch moved to
  `lib/domain/caseTypes.ts::caseDataTypeForFieldKind` (both ends of the
  mapping are `lib/domain` types, so it isn't wire vocabulary) and
  `fieldKindMatchesPropertyType.ts` now consumes it via a thin alias —
  one table, no `@/lib/commcare` boundary widening for `lib/doc`.
- (d) New entries carry `label: name` (the `casePropertySchema` requires
  `label`; same shape `augmentCaseType` gives writer-derived entries) and
  the kind-derived `data_type`; `hidden` writers land an UNTYPED entry
  (the calculate's output type isn't pinned by the kind), read as `text`
  everywhere via the `effectiveDataType` convention. Declared entries are
  never clobbered (no duplicate, no `data_type`/`label` overwrite) and
  removal never prunes.
- Tests: 18 new in `lib/doc/__tests__/mutations-fields-catalog.test.ts`,
  failing-first confirmed (13 of 18 failed pre-implementation; the 5
  passing were the negative shapes — no-pointer add, declared-entry
  no-clobber, move-without-rename, the gap-is-real proof). The acceptance
  pair drives the real `validateBlueprintDeep`: `#patient/age` on a
  followup form is `INVALID_CASE_REF` before the `addField` writer lands
  and clean after, with `caseTypes` starting `null`. Full suite 5750
  passed / 0 failed.

## Task 6 — `expressionSource` accessor

**Files:** `lib/domain/expressionSource.ts` (new), conversions in
`lib/commcare/validator/index.ts` (deep-validation scans),
`lib/preview/engine/triggerDag.ts` + `formEngine.ts` (expression reads),
`lib/doc/searchBlueprint.ts`, `lib/commcare/fieldProps.ts::readFieldString`
(delegates or is replaced), tests.

One read accessor for expression-bearing slots so Stage 6's representation
migration swaps an implementation, not call sites. Mechanical; no behavior
change. Skip surfaces that read non-expression strings.

**Acceptance:** `npm run test` green; grep shows no remaining direct
`(field as ...).calculate`-style expression reads outside the accessor + the
registry (allow the emitters' `readFieldString` if it delegates).

**SHIPPED** (`f53ac063`) with these deviations/decisions:

- (a) Accessor surface (all registry-driven; no second key list):
  `expressionSource(field, scalarSlot)` — TOTAL scalar read (returns the
  stored string, `""` included, `undefined` otherwise; no applicability
  gating — off-schema docs behave exactly like the direct reads it
  replaced); `expressionSourceEntries(field, slot)` — fan-out-aware
  (`option_label` yields one entry per option with pairing `indices`);
  `expressionSurfaceReads(field, "xpath" | "prose")` — the
  applicability-gated per-kind projection (narrowed by `repeat_mode`),
  in registry order; `formExpressionSource(form, scalarSlot)` +
  `CONNECT_XPATH_SLOT_IDS` for the Connect bindings. Form-level slots
  included because the deep validator reads them; module-level slots
  deliberately absent — every module slot is predicate-AST or a bare
  name ref, no expression source text exists.
- (b) Path resolution shared, nothing relocated: Task 3's walker already
  lives in `lib/domain/referenceSlots.ts`, so `readSlotStrings` joins
  `rewriteSlotStrings` there on one private `walkSlotStrings` traversal.
  Reads report empty strings (callers own blank policy — the validator's
  trim-skip on `repeat_count`/`ids_query` vs plain-empty on flat slots is
  preserved at its call site); the rewriter keeps its skip-empty
  write-back contract.
- (c) `readFieldString` STAYS and delegates: its consumers also read the
  non-expression `case_property_on` (`deriveCaseConfig`,
  `rules/form.ts`), so it splits on `isScalarFieldExpressionSlotId` —
  expression keys route through `expressionSource` (which also resolves
  the nested `ids_query` path), everything else stays a plain property
  lookup. The emitters' flat-slot reads ride the delegation unchanged.
- (d) Registry field-slot ORDER changed: `validate` now precedes
  `calculate`, restoring the validator's long-standing
  relevant → validate → calculate → default_value → required surface
  order — entry order became observable through the registry-driven scan
  (`text` carries both `validate` and `default_value`, so relative order
  shows in error output). No kind carries both `validate` and
  `calculate`, so that pair's swap is unobservable; the per-kind
  projection assertions in `referenceSlots.test.ts` were unaffected.
- (e) The validator's `XPathSurface` / `ProseSurface` / `ConnectXPathSlot`
  unions became ALIASES of the registry projections (the "rewiring the
  validator can come later" Task 1 left open) — `XPATH_FIELDS`,
  `PROSE_SURFACES`, `readXPath`, `readProse`, and the hand-narrowed
  repeat/option scan branches are gone; `referenceSlotUnions.test.ts`
  still pins both directions.
- (f) Sites intentionally left direct (the acceptance grep's allowance
  list), each with its reason:
  - `lib/commcare/validator/rules/field.ts` + `rules/form.ts`
    (`caseHashtagOnCreateForm`'s repeat arms) — kind/mode-narrowed rule
    code where the schema types the slot as REQUIRED on the narrowed
    variant and the rule's subject is the stored slot itself
    (emptiness, banned functions); their generic flat-slot reads route
    through `readFieldString` → accessor.
  - `lib/commcare/xform/builder.ts` repeat emission — same narrowing
    (mode-required slots); flat slots already flow through
    `readFieldString`.
  - `lib/preview/engine/engineController.ts` — representation-identity
    diff between two snapshots of the same field (change detection),
    not expression consumption.
  - `lib/doc/connectConfig.ts::findScoreField` — narrowed to
    `HiddenField` where `calculate` is a typed property; seeds a
    Connect default.
  - `components/preview/form/fields/HiddenField.tsx` — display of the
    stored expression text on the field card (display read).
  - `components/builder/editor/fields/XPathEditor.tsx` + the field
    editor surface — the editing surface owns the stored
    representation (read-back of what it writes).
  - Label/hint display reads everywhere (`lib/references/provider.ts`,
    `lib/agent/summarizeBlueprint.ts`, builder/preview components) —
    label-as-display-text, non-expression reads.
  - `lib/preview/engine/formEngine.ts` `case_property_on` reads —
    `case-type-ref` slot, not an expression surface.
- Tests: 132 new in `lib/domain/__tests__/expressionSource.test.ts` —
  every xpath/prose registry slot resolved on a schema-valid fixture of
  EVERY kind (and repeat mode) it claims, nested + fan-out paths
  included; total-read vs gated-projection split pinned (a `calculate`
  parked off-schema on a text field is visible to `expressionSource`,
  invisible to `expressionSurfaceReads`); Connect form slots; slot-id
  narrowing for the delegation. No failing-first phase — no behavior to
  assert against (mechanical indirection); the full suite is the
  no-change oracle: 5882 passed / 0 failed (single run).

## Task 7 — The gate + scoped runner

**Files:** `lib/commcare/validator/gate.ts` (new),
`lib/commcare/validator/runner.ts` (scope filter),
`lib/commcare/validator/index.ts` (`validateBlueprintDeep` scope filter),
`lib/commcare/validator/scopeOfMutations.ts` (new — beside the gate; takes
`Mutation[]` + prev doc, returns scope; case-property-touching mutations widen
to all modules of that case type; unmapped kinds → full),
`lib/commcare/validator/__tests__/gate.test.ts`, perf fixture test.

- `classifyError`: `Record<ValidationErrorCode, Class>` — typed-total (compile
  error on a new unclassified code). Seed classes from the spec's table; audit
  every domain code file-by-file against its rule implementation; oracles are
  class `oracle`; media `environment`; the ~11 completeness codes per the spec
  list; everything else `soundness` (shape codes that can't fire post-Zod still
  get a class).
- `errorIdentity(err)`: code + location uuids + surface key — stable under
  unrelated edits (test: error identity unchanged when a different form is
  edited).
- `diffIntroduced(prev, next)`, `evaluateCommit({prevDoc, nextDoc, scope,
  phase})` (building defers completeness; complete ratchets),
  `evaluateBoundary(doc, manifest)` (zero-tolerance full run).
- Scoped ≡ full-filtered property test (`blueprintDocArbitrary`-driven): scoped
  run over the derived scope equals the full run filtered to that scope, for
  random docs + random mutation batches.
- Perf guard: full `evaluateBoundary` on a large fixture under a generous
  budget; fails on order-of-magnitude regressions, not noise.

NOTHING consumes the gate yet (Stage 1+ wires it). Pure lib + tests.

**Acceptance:** totality compiles; all gate tests green; perf guard green.

**SHIPPED** (`f833ce36`) with these deviations/decisions:

- (a) Classification (190 codes, not the spec's "~190"): 11 completeness
  (exactly the spec's list — NO_MODULES, EMPTY_FORM,
  MISSING_CASE_LIST_COLUMNS, NO_CASE_NAME_FIELD, REGISTRATION_NO_CASE_PROPS,
  CHILD_CASE_NO_NAME_FIELD, MISSING_CHILD_CASE_MODULE,
  CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE, CONNECT_FORM_MISSING_BLOCK
  [retired by the spec's Connect participation relaxation stage —
  replaced by the app-level CONNECT_NO_PARTICIPATING_FORMS],
  CONNECT_MISSING_LEARN, CONNECT_MISSING_DELIVER), 4 environment (the three
  asset-context rules + MEDIA_EXPORT_TOO_LARGE — external-state-dependent,
  boundary-only, never producible by a commit-path run), 95 oracle (XFORM 28
  / SUITE 35 / HQJSON 15 / BINDING_RESOLUTION 4 / MEDIA_SUITE 3 + the
  10-code media-suite resource family), 6 shape (schema-verified backstops:
  REQUIRED_ON_HIDDEN, CALCULATE_ON_VISIBLE_INPUT,
  VALIDATION_ON_NON_INPUT_KIND, INVALID_POST_SUBMIT — Zod enum,
  SELECT_NO_OPTIONS — `options.min(2)`, MEDIA_CASE_PROPERTY — media kinds
  carry no `case_property_on`), 74 soundness. Judgment calls:
  NO_FORMS_OR_CASE_LIST reads "unfinished" by the definition but is NOT on
  the spec's closed list, so it stays soundness — under the Stage-2 gate a
  batch creating a module without its forms will reject even while
  `building`; flagged for Stage-2 review rather than reclassified here.
- (b) `errorIdentity` default = code + location uuids + `location.field`;
  exceptions decided per rule source: value-keyed dedup findings drop their
  flip-prone location anchor (DUPLICATE_MODULE_NAME → name,
  RESERVED_CASE_TYPE_NAME / MISSING_CHILD_CASE_MODULE → caseType,
  CONNECT_ID_DUPLICATE → connectId, FORM_LINK_CIRCULAR → code only);
  case-list shapes add the stable sub-entity uuid or value key from
  `details` (columnUuid / inputUuid / inputName / priority / image-map
  value / slot+property); form-scope property findings add the property /
  connectId / surface+hashtag / caseType. Positional indices, AST paths,
  prose, and mutable semantic ids NEVER enter identity — every collapse is
  permissive (a second same-key finding passes), never a churn that rejects
  a strict improvement.
- (c) `evaluateCommit` runs BOTH docs under the batch's scope; the
  documented equivalence with the full-run diff rests on (1) scope
  soundness by `scopeOfMutations` construction, (2) every identity embeds
  the uuid that decides its scope membership (or is scope-exempt), so the
  in/out-of-scope partition is identical for prev and next, (3) the
  property-tested scoped ≡ full-filtered runner law.
- (d) Runner attribution rides per-CODE, not on `err.scope`:
  `fieldKindMatchesPropertyType` is an APP rule emitting field-located
  errors, so `SCOPE_EXEMPT_CODES` (app rules + manifest-gated media rules +
  MEDIA_EXPORT_TOO_LARGE) anchors the law's filter side
  (`errorWithinScope`, exported). Scope restricts which entities are
  WALKED — no post-filtering.
- (e) `scopeOfMutations` beyond the sketch: removeForm / removeModule →
  full (form-link targets + vanishing case-property writers are
  cross-entity); addForm / addModule → containing module; moveModule →
  EMPTY scope (app rules only — order feeds no module/form rule);
  moveField scopes both endpoint forms + subtree case-type widening
  (cross-level dedup-rename can rename a writer); remove/duplicate widen by
  every case type in the prevDoc subtree; intra-batch adds resolve through
  an overlay (addModule+addForm+addField stays scoped); unresolvable
  targets → full; exhaustive switch + runtime `default` → full.
- (f) Property test restructured to a DAMAGE batch + EDIT batch after
  measuring that the single-batch shape never exercised the filter side
  (docs are valid by construction and sound scopes contain their own
  damage — 0/200 samples had out-of-scope findings; two-batch shape: 77/100
  comparison-reaching samples carry findings, 8/100 filter findings out).
  Asserts the runner law on next AND prev, the deep-walk law directly, and
  scope soundness (edit-introduced findings all in scope); 200 runs, seed
  pinned.
- (g) Perf guard: deterministic 3,000-field fixture (30 modules × 4 forms ×
  25 fields, expression-bearing) under a 20s budget; measured ~100ms — the
  budget trips only on an order-of-magnitude regression.
- Tests: 22 gate + 13 scopeOfMutations + 1 property + 1 perf = 37 new.
  Full suite: 5919 passed / 0 failed (30 pre-existing skips; single
  observed run — a first launch wedged at vitest startup having executed
  zero tests and was killed unread).

## Sequencing & protocol

T1 → T2 → T3 → T4 → T5 → T6 → T7, strictly serialized. Each task: implement →
`npm run test` (once) + `npm run lint` → commit (foreground hooks). After T7:
full suite + `npx tsx scripts/test-schema.ts` (T4 touches tool schemas... it
does not change schema SHAPE — run anyway as backstop), then the stage-level
adversarial review (`/code-review xhigh`), fix findings, commit, docs sweep
(`lib/doc/CLAUDE.md` rewriter-coverage paragraph, `lib/commcare/CLAUDE.md` if
matcher source moved).

## Final verification (user-runnable)

User runs `npm run dev`, opens an app in the builder:
1. Create field `age`; create field `adult` with calculate referencing
   `#form/age`; set a third field's `required` expression to reference
   `#form/age`. Rename `age` → `years`. BOTH the calculate and the required
   expression now reference `#form/years` (the required one silently broke
   before this stage).
2. Put `#form/years` in another field's hint text, then drag `years` into a
   group. The hint ref reads `#form/<group>/years` and still renders as a chip;
   preview still resolves it (it dangled silently before).
3. `npm run test` green; export `.ccz` of an unchanged app byte-identical to
   pre-stage export (no wire change).

## Post-review fixes (SHIPPED — d2d8a0b2)

The stage-level adversarial review confirmed 15 findings collapsing to 8
root causes; all fixed failing-test-first in one commit (`d2d8a0b2`):

1. **Gate scope holes** (scopeOfMutations) — T7's "widen to every module
   of the written caseType" was unsound: the rename cascade renames peers
   app-wide by `(id, case_property_on)` (child-case writers live in
   modules of OTHER types), and relation-walk readers (search-input `via`
   configs, predicate-AST `PropertyRef` leaves, ancestor-chain `#<type>/`
   refs) read the written type from modules of any caseType. Every
   case-property-writer/catalog-touching field mutation (add, remove,
   duplicate, move, rename, convert, re-target/re-id via updateField) now
   derives `"full"`; `widenToCaseType` is gone. Non-case field mutations
   stay form-scoped. Both staleness shapes (cross-module peer
   DUPLICATE_FIELD_ID; UNKNOWN_PROPERTY → MODE_MISMATCH flip in a
   relation-walking module) are pinned end-to-end in gate.test.ts.
2. **Container descendant hashtag refs** — `#form/` walks in
   `rewriteXPathRefs` / `rewriteXPathOnMove` match by segment PREFIX, so
   renaming/moving a group re-anchors `#form/grp/inner` like the
   absolute spelling always did. T2's "nothing dangles" acceptance now
   holds for same-form moves; cross-form is documented as inherent
   form-scoping, not a rewrite gap.
3. **Hashtag segment Unicode divergence** — segments now ride a dedicated
   ASCII `hashtagName` token in the grammar (parser regenerated), so all
   three matchers agree on extents over Unicode continuation chars;
   divergence corpus extended with Unicode entries.
4. **moveField cross-form** — the rewrite pass walks the SOURCE form +
   moved subtree on a cross-form move (pre-move resolution is
   form-scoped); the destination form's own same-path refs are never
   retargeted.
5. **Catalog rename merge** — `cascadeCasePropertyRename` no longer mints
   a duplicate entry when renaming onto an existing property name (the
   declared entry wins; the old entry drops).
6. **errorIdentity totality** — lone UTF-16 surrogates in authored
   discriminators no longer throw out of `evaluateCommit`
   (`toWellFormed` before `encodeURIComponent`; well-formed identities
   unchanged).
7. **encodeTupleKey** — JSON-encoded pair keys, collision-free over the
   arbitrary docs `runValidation` is total over.
8. **caseDataTypeForFieldKind** — the defensive never-arm returns
   `undefined` instead of the raw unknown kind string.

Full suite after fixes: 5971 passed / 0 failed (30 pre-existing skips),
lint + tsc clean.

### Round 2 (SHIPPED — 10d0d9fa)

A cold re-review of `d2d8a0b2` surfaced 7 surviving findings, 4 root
causes — all fixed failing-test-first in one commit (`10d0d9fa`):

1. **Cross-form moveField → warn-and-skip** — round 1 gave an undesigned
   operation half-designed semantics (the dedup name, chosen against
   DESTINATION siblings, could capture an unrelated source-form field
   when spliced into source expressions; the moved subtree's outbound
   refs silently retargeted to same-named destination fields). The
   reducer now skips any `moveField` whose `toParentUuid` resolves to a
   different form (warn logged, doc unchanged, empty result — the
   total-reducer skip convention); the round-1 source+subtree rewrite is
   deleted and the doc blocks state same-form scope plainly. Designing
   cross-form moves is future work that must pick outbound-ref semantics
   first. Same-form cross-parent moves keep full re-anchoring.
2. **updateField kind patch** — the reducer accepts a `kind` patch
   (convertField in another spelling), so a kind patch on a case-bound
   field now derives scope `"full"`, mirroring convertField.
3. **toWellFormed → regex sanitizer** — ES2024's method is unpolyfilled
   (Firefox ≤118 / Safari ≤16.3), so identity parts now run a
   lookbehind-free pair-or-lone regex pass replacing lone surrogates
   with U+FFFD; byte-identity with the native method is test-pinned.
4. **Walker consolidation** — `pathRewrite.ts` imports the `#form/`
   prefix walker, segment collector, `applyEdits`, and `SourceEdit` from
   `lib/preview/xpath/rewrite.ts` (the byte-identical copies and the
   false "stands alone" justification are gone — `fields.ts` already
   imported the preview rewriters).

Full suite after fixes: 5975 passed / 0 failed (30 pre-existing skips),
lint + tsc clean.

### Round 3 (`e1762eb9`)

7 survivors from the round-2 delta review, 4 root causes: (1) the kind-patch
spelling resolved by REMOVING it — updateField strips `kind` pre-merge to
match the wire (partialOf already omits it; replay ≡ in-process restored;
convertField stays the only kind-change path; the round-2 scope arm deleted
as dead); (2) cross-form moveField skip polarity flipped to fail-closed
(proceed only when both forms resolve and match); (3) reducer skip warns on
the established console convention; (4) the applyEdits/SourceEdit variants
in hashtags.ts + transpiler.ts resolved as DOCUMENTED DIVERGENCE, not
consolidation — each stays local under a contract-bearing name (hashtags.ts
`applyPresortedEdits` leans on document-order pre-sorting and never sorts;
transpiler.ts `applyEditsRejectingOverlaps` copies, sorts, and THROWS on
overlap as the oracle posture), each with a doc comment on why it is
deliberately not the rewriters' self-sorting `applyEdits`
(`lib/preview/xpath/rewrite.ts`). [Corrected in round 4 — this entry
originally recorded a consolidation that never shipped.]

### Startup-wedge root cause (`2777f1d8`, discovered during round-3 verification)

The recurring silent suite hang was rolldown's native config bundler
deadlocking pre-banner (vite 8 default `bundle` loader; all rolldown-worker
threads in pthread_cond_wait). Interim fix pinned `--configLoader runner`;
the root fix landed next: vite bumped to 8.0.16 (rolldown 1.0.3 stable, past
the racy rc.16), flags removed so every invocation shape — npm scripts, bare
npx, IDE — rides the fixed default loader. vitest.config.ts stays
strict-ESM-clean (loads identically under all three loaders).

### Round 4 (`d154d2e7`)

7 findings from the round-3 delta review, 4 code root causes plus two
doc corrections:

1. **Console convention completed** — round 3 converted only the two
   named warns; three reducer sites (convertField's convertibility
   gate + reconcile failure, setFieldMedia's slot mismatch) and the
   client hook's `warnUnresolved` still hit the structured logger,
   whose production path writes to `process.stdout` — undefined in
   Next's browser process shim, so each was a production-client THROW
   on its degraded path. All four now `console.warn`. A source-scan
   test (`lib/doc/__tests__/mutations-no-structured-logger.test.ts`)
   bans `@/lib/logger` from `lib/doc/mutations/` + `lib/doc/hooks/` —
   a runtime assertion can't see the crash because vitest.setup.ts
   mocks the logger globally, which is how the regression shipped.
2. **Self-subtree moveField guard** — a `toParentUuid` inside the
   moved subtree (including the moved uuid itself) passed the
   fail-closed cross-form guard (both ends resolve to the same form
   PRE-move) and spliced the subtree into its own `fieldOrder`,
   silently detaching it from every walk. The guard now walks the
   destination's ancestry and warn-and-skips when it crosses the
   moved uuid; pinned by two skip tests (self, descendant).
3. **editField.ts kind-change comment** — rewritten to the post-strip
   truth: the updateField reducer drops `kind`/`uuid` and applies the
   REST of the patch (a kind-bearing patch is NOT a whole-patch
   no-op); convertField stays the single kind-change path.
4. **Gate coverage restored in its live spelling** — the round-3
   deletion of the kind-PATCH writers-disagree test removed the only
   evaluateCommit-level proof that a kind change introducing
   FIELD_KIND_WRITERS_DISAGREE is caught. Restored through
   convertField (int → decimal writers of one case property across
   two modules): full scope derived, verdict rejects, one finding per
   writer.
5. **Round-3 entry corrected above** — item (4) recorded a
   consolidation; the shipped resolution was documented divergence
   with contract-bearing renames.
6. **Credit-system plan's vitest steps** — the archived plan's
   executable `npx vitest run` step lines briefly carried the interim
   loader flag; the flag was removed everywhere once the vite 8.0.16 /
   rolldown 1.0.3 bump made the default loader safe (see the
   startup-wedge entry above).

Full suite after fixes: 5980 passed / 0 failed (30 pre-existing
skips), lint + tsc clean.

### Round 5 (`05a64111`) — loop closed

One survivor: the logger-ban source scan wasn't recursive (flat-today blind
spot). Fixed red-first with a planted nested offender + a non-empty-walk
assertion. Review loop converged 15 → 7 → 7 → 7 → 1 → 0 across five cold
rounds; Stage 0 is review-complete.
