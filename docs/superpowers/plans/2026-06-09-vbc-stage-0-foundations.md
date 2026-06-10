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
