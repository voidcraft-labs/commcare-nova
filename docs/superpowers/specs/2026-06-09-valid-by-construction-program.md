# Valid by Construction — Program Spec

Supersedes `2026-05-31-valid-by-construction-design.md` (same program, same goal;
this revision adds the reference-index architecture, the canonical-representation
end state, and re-sequences the work into seven tranches). Ground-truth claims
were verified against main and the CommCare checkouts on 2026-06-09, and the
full draft was adversarially reviewed against the codebase; design decisions
below record what survived. (This worktree is behind main — rebase before
implementation starts so Tranche 0 diffs apply against current source.)

## Goal

**Every committed mutation batch leaves the blueprint valid, identically for the
SA and the builder UI, so invalid states are unrepresentable rather than
detected-and-repaired.** The user-facing `validateApp` fix loop — today the
*only* validity net in the system — is removed, because there is nothing left
for it to fix. What survives at the boundaries is small and fix-free:

- the **media-state export gate** (asset readiness is external Firestore/GCS
  state, not a doc property — permanently a boundary check),
- a **completeness checklist** at export ("is it finished", not "is it broken"),
- an **index-backed ingest gate** for docs that never rode the guarded write
  paths (recovery scripts, legacy docs, hand-built MCP payloads),
- the **wire oracles** (XForm / suite / HQ-JSON / binding-resolution), which are
  already CI/fuzz-only totality proofs and never user gates — they stay forever
  and need no work.

The validate-then-fix model is the last structural leftover of the pre-Nova
"Forge" era. The "every mutation is valid" invariant already exists as a UI
principle; this program extends it to the agent, on the principle that if a user
cannot reach an invalid state through the interface, neither should the agent.

## Definitions

Three validity categories — the load-bearing distinction is the **enforcement
response**, not the taxonomy label:

- **Illegal** — malformed id, unparseable expression, dangling reference,
  dependency cycle. Never allowed. Response: **reject** (or auto-correct) at the
  commit boundary, or **rewrite/resolve** when the edit itself is legal but
  would break references (rename rewrites; delete demands a resolution).
- **Incomplete** — module with no columns yet, registration form with no
  case-name field yet, child case type no module lists yet. Normal
  work-in-progress states; response: **defer to the export/"done" boundary**.
  Enforcing these per-mutation would make incremental building impossible: a
  just-created form IS empty, generation tools stream fields in after the form
  exists, and building the parent module's child-creating fields before
  scaffolding the child module is the natural build order.
- **Emergent** — cross-entity integrity: who references whom, what a rename
  cascades to, what a delete orphans, whether an edit closes a cycle. Shares the
  commit-boundary verdict *mechanism* with illegal states; differs in the state
  consulted (cross-entity, via the reference index).

**The persisted mutation batch is the unit of validity** — one `applyMany` /
one `recordMutations` call. Every batch must commit valid; co-dependent
mutations must ride one batch. Intra-batch intermediate states may transiently
dangle; validity holds at the batch boundary. Tools that deliberately stage
multiple batches (`editField`'s convert→rename→patch split) must make each
stage independently valid — and on a mid-call rejection, report the committed
prefix in the tool result so the SA knows what landed.

**One enforcement layer, two surfaces.** The UI (`lib/doc/store.ts::applyMany`)
and the SA (`lib/agent/tools/common.ts::applyToDoc`) apply through the single
`lib/doc/mutations/index.ts::applyMutations` reducer, and server- and
client-derived docs are byte-identical from the same `Mutation[]`. Guards that
*reject* run **pre-dispatch** at the hook/tool layer via shared verdict
functions (the `lib/commcare/connectSlugs.ts` pattern: one function, both
callers, validator rule retained as backstop); reducers stay guard-free and
never throw.

**The rejection channel is the verdict function's typed return** — evaluated
pre-dispatch, before `applyMany` is ever called. The UI hook renders the
verdict inline and never dispatches; the SA/MCP tool layer maps the same
verdict to the existing structured `{ error }` tool-failure shape.
`MutationResult[]` (`FieldRenameMeta` / `MoveFieldResult`) remains what it is
today — post-apply side-effect metadata for toasts — and is *not* the rejection
path.

## Ground truth (verified 2026-06-09, against main)

What the investigation established, with the evidence:

**The validator, classified.** 190 distinct checks. ~95 are wire-oracle codes
already at the desired end state (CI/fuzz harnesses + `compileCcz` throws —
generator-bug detectors, never authoring gates). The ~95 live authoring-facing
codes decompose, after review, into:

- **~12 backstops** whose primary enforcement already lives at source (the
  connect-slug family et al.) — no work beyond keeping them;
- **16 killed outright by the reference index**: `INVALID_REF`,
  `INVALID_CASE_REF`, `CYCLE`, `FORM_LINK_TARGET_NOT_FOUND`,
  `FORM_LINK_SELF_REFERENCE`, `FORM_LINK_CIRCULAR`,
  `FIELD_KIND_PROPERTY_TYPE_MISMATCH`, `FIELD_KIND_WRITERS_DISAGREE`,
  `DUPLICATE_CASE_PROPERTY`, `CLOSE_CONDITION_FIELD_NOT_FOUND`,
  `CASE_LIST_COLUMN_UNKNOWN_FIELD`, `CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY`,
  `CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH`,
  `CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH`,
  `CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT`, `CASE_HASHTAG_ON_CREATE_FORM`;
- **~11 export-boundary completeness codes** (`NO_MODULES`, `EMPTY_FORM`,
  `NO_FORMS_OR_CASE_LIST`, `MISSING_CASE_LIST_COLUMNS`,
  `REGISTRATION_NO_CASE_PROPS`, `NO_CASE_NAME_FIELD`,
  `CHILD_CASE_NO_NAME_FIELD`, `MISSING_CHILD_CASE_MODULE`, the Connect
  missing-block family) — deferred, never construction-enforced.
  `MISSING_CHILD_CASE_MODULE` is deliberately here, not in the 16: HQ has no
  rule requiring a created child type to be listed (its requirement is
  case-detail-on-case-requiring-modules only), the rule is stricter than the
  platform, and "child type with no module yet" is the canonical mid-build
  state;
- **3 media-boundary codes** (readiness / kind / export budget — external
  state);
- **~53 needing a construction mechanism**: ~24 typed-schema tightenings, ~19
  commit guards (including parse-at-commit, which absorbs
  `FIXTURE_REFERENCE_NOT_MODELED` — a property of the expression text), ~10
  structured-expression/type checks at commit.

**Today's only net is SA-side.** The builder UI runs no validation anywhere
under `components/builder/`, and neither export path validates the blueprint —
`app/api/compile/route.ts` and `app/api/commcare/upload/route.ts` call the
emitters with no `runValidation` gate (the media validator gates media-ON
exports; nothing gates blueprint validity). A user can delete a field three
other fields reference and nothing warns; a broken app uploads and breaks at
CCHQ.

**The mutation layer's reference handling is partial and asymmetric.**

- `renameField` runs a two-phase cascade (`lib/doc/mutations/fields.ts`):
  form-local Lezer rewrites over `XPATH_FIELDS` + `DISPLAY_FIELDS`, then — when
  the field has `case_property_on` — an app-wide scan renaming peer fields,
  the case-type catalog entry, case-list columns, and `#case/` + `#<type>/`
  hashtags. It works, but its surface list is the narrowest of three.
- **Surface coverage disagrees across three layers.** The rename/move rewriters
  cover 6 surfaces (`relevant`, `calculate`, `default_value`, `validate` +
  `label`, `hint`); emit and the deep validator cover ~15 (adding `required`,
  `repeat_count`, `ids_query`, `help`, `validate_msg`, option labels, connect
  XPath slots, `closeCondition.field`, predicate-AST `PropertyRef`s, form-link
  conditions/datums). `required` is excluded from `XPATH_FIELDS` under a comment
  that is provably stale (`lib/domain/fields/base.ts` declares it as an XPath
  surface; the validator and fix loop treat it as one). **Renaming a field
  referenced in a `required` expression silently breaks it today.**
- `moveField` rewrites absolute paths through the Lezer walk, but a cross-depth
  move **drops** `#form/` hashtag refs — counted in
  `MoveFieldResult.droppedCrossDepthRefs`, which no consumer reads. The
  limitation is the *rewriters'*, not the syntax's: the Lezer grammar
  (`HashtagRef` is multi-segment), `BARE_HASHTAG_PATTERN`, the emitter's
  `resolveFlatHashtag`, the preview resolver, and Vellum's canonical
  `#form/group/q` shorthand all handle nested hashtags; only
  `rewriteXPathOnMove` restricts itself to single-segment rewrites.
- `removeField` / `removeForm` / `removeModule` are pure subtree cascades: **no
  reference scan of any kind**. Every inbound reference orphans silently.
- `moveForm` across modules, `updateModule({caseType})`, `updateForm({type})`,
  and `setCaseTypes` change what existing refs resolve to with **zero string
  changes** — no rewrite, no warning. (`updateForm({type})` to registration
  collapses the form's accept set to own-type `case_id` only; to survey, to
  nothing — instantly orphaning every other case ref in the form.) These are
  the mutations no string-keyed rewriter can even see.

**Identifier invariants are not construction-guaranteed.** The `addField`
reducer has no sibling-id uniqueness check (parent-existence + splice only); the
SA rename path (`lib/agent/blueprintHelpers.ts::renameFieldMutations`) dispatches
with no conflict guard — only the UI hook pre-checks; field-id legality is
validate-time + autofix. Reference resolution is path/name-scoped, so duplicate
sibling ids make resolution ambiguous: any index built before these guards land
indexes ambiguity.

**Three hashtag matchers disagree.** The Lezer `HashtagRef` grammar (XPath), the
wire-prose `BARE_HASHTAG_PATTERN` (`lib/commcare/proseHashtags.ts`, allows `-`
in segments), and the UI `HASHTAG_REF_PATTERN` (`lib/references/config.ts`,
allows `.` in paths) are kept in lockstep only by convention.

**No expression references anything by stable identity.** Every ref inside an
expression or prose string uses the semantic-id/name vocabulary; uuid references
exist only at the entity level (`form_links` targets store
`{moduleUuid, formUuid}` — the one rename-proof reference family — plus media
`AssetId`s). The doc store itself is uuid-normalized, so the infrastructure for
identity-keyed references exists one layer down.

**The structured-AST precedent cuts both ways.** Case-list filters and
calculated columns are already structured-canonical (`Predicate` /
`ValueExpression` in `lib/domain/predicate`) — representation-first is the
codebase's existing direction, not a novel bet. But the same precedent proves
structure alone doesn't fix staleness: `PropertyRef` stores case-type/property
*names*, and no mutation rewrites them today — the rename cascade skips
predicate ASTs entirely. Structure without identity resolution and a reverse
index just changes what goes stale.

**The preview engine's graph is real but not the answer.**
`lib/preview/engine/triggerDag.ts` is path-string-keyed (a rename re-keys its
whole world), per-form, full-rebuild-on-change, covers a subset of surfaces, and
silently breaks cycles at runtime (`detectAndBreakCycles`, console.warn). Its
pure pieces are already shared with the write side — the validator imports
`reportCycles` and `buildFieldTree`; the doc mutations import the
`lib/preview/xpath` rewriters — so the shareable primitives are proven; the
structure itself is the wrong shape to grow.

**The cross-form model is the case-flow structure, verified against the
platform.** Expression-dependency edges (recompute order, cycles — what
TriggerDag models) cannot cross a form boundary: `#<type>/<prop>` lowers to a
casedb read mediated by session selection, never a live edge into another form's
instance. Intra-form triggerable cycles are form-load fatal
(`~/code/commcare-core/.../javarosa/core/model/FormDef.java::finalizeTriggerables`
throws on cyclic graphs, invoked from `XFormParser`). A case type is *usable*
only through a case list: HQ requires a short detail on case-requiring modules
(`~/code/commcare-hq/corehq/apps/app_manager/helpers/validators.py:321,728-733`,
`'no case detail'`), and at runtime entity selection exists only through a
case-list detail (`~/code/commcare-core/.../xml/SessionDatumParser.java:60`
reads `detail-select` into `EntityDatum.shortDetail`). So the app-level layer of
the graph is the **case-flow model** — case-type nodes with parent edges,
module-lists-type edges, form-creates/updates/closes-type edges, and the
property namespace under each type — not a bare property-name index. Nova
already encodes fragments of it
(`lib/domain/caseTypes.ts::reachableCaseTypes`, `caseRefAcceptMap`).

**`validateApp` is load-bearing beyond validation.** The chat-side success arm
triggers `materializeCaseStoreSchemas` + `completeApp`
(`lib/agent/solutionsArchitect.ts` — chat-surface-only today; MCP builds never
run them). The fix loop (`lib/agent/validationLoop.ts`) carries a FIX_REGISTRY
(13 auto-fix codes) and a stuck check (3 consecutive identical error
signatures — there is no hard iteration cap). Retiring it means relocating
those side effects, not just deleting checks.

## End-state architecture

### Canonical structured expressions, strings at the edges

The destination representation: XPath expression surfaces persist as a typed
AST — **uuid leaves** for form-local references (`#form/...`, `/data/...`),
**`(case_type, property)` leaves** for case references, named leaves for
`#user/<prop>` — with strings *projected* at every edge that wants text.

The persistable AST is a new typed tree following the `Predicate` /
`ValueExpression` pattern, built *from* the Lezer parse and carrying
inter-token trivia, with a printer obeying a fuzz-pinned round-trip law:
`print(parse(s)) === s` byte-exactly for every parse-clean `s`. The editor
reopens to the user's exact text, the event log carries no formatting churn,
and projected wire bytes stay stable. The Lezer tree remains the parse front
end only — never the stored form.

The edges:

- **Wire emission** projects strings (the emitters are DOM construction; the
  predicate AST already compiles to XPath). A `(caseType, prop)` leaf needs no
  depth structure: emit derives depth from the form's reachable-type map
  (unique depth per type by construction), including the registration
  narrowing; an unreachable leaf re-projects as verbatim `#<type>/<prop>` text,
  preserving today's validator-quote behavior.
- **The expression editor** round-trips text ↔ AST at commit (the round-trip
  law makes this lossless).
- **The SA surface does not change shape.** Tool input schemas stay
  string-typed — the SA writes XPath text in both worlds. Parsing happens
  inside the tool handler; the SA-visible change is failure results on invalid
  input (the connect-slug precedent). Requires owner sign-off per the
  SA-surface rule; the change is handler-internal.
- **Every read edge goes through one accessor.** Tranche 0 introduces
  `expressionSource(field, key) → string` and converts every reader to it
  (`getField`/`getForm` tool reads, `searchBlueprint`, the preview engine's
  extraction/evaluation/change-detection, `connectConfig`, validator scans,
  `formActions`, the emitters) — so Tranche 5 changes the accessor's
  implementation, not its consumers.
- **Prose stays prose, permanently.** Labels/hints remain markdown strings with
  bare hashtags (locked: markdown swallows `#` under XPath parsing; the tiptap
  chip layer is editor-only by design). Prose refs are indexed, never
  restructured — which means **the prose hashtag rewriter is permanent**, and
  `renameField` remains a cascading reducer side effect for prose surfaces
  forever.

Under this representation, a form-local rename is a metadata no-op **on
migrated expression surfaces** — no parsing, no matcher lockstep. A
case-property rename remains a cascade (the property name is shared by peer
writers), executed as a structural leaf-walk inside the reducer.

### The reference index

A **derived, identity-keyed, never-persisted** index over the doc, maintained at
the mutation batch boundary. Its role is precisely scoped: it powers
**pre-dispatch verdicts** (conflict guards, orphan lists, affected-reference
previews, cycle checks) and **read paths** (find-references, lint, autocomplete,
readiness affordances). It never drives reducer behavior — see D4.

Shape — two layers plus entity edges, matching what the platform actually
couples:

- **Per-form expression graphs**: nodes are field uuids; edges are reference
  occurrences `{ownerUuid, surfaceKey, refShape, span}`. Recompute order and
  triggerable cycles live here.
- **App-wide case-flow graph**: case-type nodes (parent edges); property nodes
  keyed `(caseType, propName)` carrying provenance with the validator's
  admission *priority* — `declared > standard > writerDerived` — not a flat
  flag set (data-type resolution depends on the order); module-lists-type
  edges; form-creates/updates/closes-type edges; writer/reader edges from
  fields and case-list/search surfaces into property nodes. `writersOf`
  declares its scope explicitly: the admission-parity query mirrors
  `collectCaseProperties`' target ∪ declared-parent module scope, while the
  app-wide writer set is a separate query for the writers-disagree guard —
  the two existing consumers genuinely differ and the index must not blur them.
- **Entity-uuid edges**: form-link targets, media `AssetId`s — already stable,
  indexed directly.

A `#<type>/<prop>` ref denotes a property **namespace**, never a field — peer
fields across forms co-own it (`cascadeCasePropertyRename` models them as
co-equal authoritative declarations). Pointing property refs at a "primary
writer" field is wrong by construction.

`listersOf(caseType)`: a module lists type *t* when `module.caseType === t` and
it provides selection — form-entry case list, `caseListOnly` browse entry, or a
case-search module. Parent-select chains are HQ's other lister shape and a
named extension point for when that feature is modeled.

## Design decisions (locked for the program)

- **D1 — Strings stay canonical until their surface migrates.** The index is
  derived, never authoritative, never persisted. Stripped by a
  `toPersistableDoc`-style twin at every Firestore/SSE boundary, pinned by a
  test. (Persisting it would push the 1 MiB app-doc limit and create a drift
  channel for out-of-band writers.)
- **D2 — Node identity is uuid for entities, `(caseType, propName)` +
  prioritized provenance for properties.** Never semantic-id paths
  (TriggerDag's mistake: a rename re-keys the world). References are edge
  records; a rename rewrites edge payloads, never re-keys nodes.
- **D3 — The index lives on doc state** so zundo snapshots restore a graph
  consistent with its doc for free — maintained incrementally with
  structure-sharing partitions: per-form partitions for expression graphs,
  per-case-type partitions with per-`(caseType, propName)` node records for the
  case-flow layer, all updated in place through the same Immer draft. Layer-
  level clear-and-rebuild is forbidden outside `load()` and the D9 fallback
  (never `fieldParent`'s clear-and-rebuild-per-batch idiom: 100 history entries
  must share structure, not hold 100 copies).
- **D4 — Batch-end maintenance; reducers never read the index.** The index
  updates once at the end of each unbracketed `applyMutations` batch; the
  Biome `noRestrictedImports` boundary bans the sub-reducer modules
  (`fields`/`forms`/`modules`/`app`/`helpers`) from importing the index module;
  the batch dispatcher (and the store/`applyToDoc` callers) is the single
  maintenance site — mirroring how `rebuildFieldParent` wires today.
  **Consequence, stated explicitly: the rename/move reference cascade stays a
  reducer side effect computed from doc state alone** — the existing string
  rewriters while strings are canonical, a structural leaf-walk after
  migration. The bare `renameField` mutation keeps reproducing the full cascade
  on the client and in replay; `FieldRenameMeta` keeps its producer; the event
  log keeps recording one mutation per rename. The index informs the
  *pre-dispatch* verdict ("this rename touches N references", conflict
  detection) — it never drives the rewrite. The cascade's cost stays O(doc);
  what migration buys is *no parsing and no matcher lockstep*, not index-driven
  dispatch. Ref-proportional cost is a property of index *queries*
  (find-references, delete-impact, verdicts), not of cascade execution.
- **D5 — Guards run pre-dispatch via shared verdict functions** against settled
  state — the doc directly until Tranche 2, the index thereafter; one function,
  called from both the UI hook layer and the shared SA tool layer; the
  corresponding validator rule survives as a backstop. During the coexistence
  window, the SA fix loop's mutation batches run through the same verdict
  functions before `recordMutations` — a guard rejecting an autofix is a
  FIX_REGISTRY bug surfaced loudly, not silently.
- **D6 — Live streams maintain incrementally; only replay and load defer.**
  Agent-write streams do NOT bracket the index: the client maintains it
  incrementally per streamed `data-mutations` batch and the server per tool
  call (D4's normal operation) — guards must see current state mid-stream
  because the SA's second tool call may depend on its first. The
  defer-and-rebuild bracket is reserved for the replay loops (ReplayHydrator
  hydration, chapter scrubbing) and `load()`, where no guard can fire. Invariant:
  **an index-defer window must also be an undo-pause window**, and the settle
  rebuild commits before undo tracking resumes.
- **D7 — Incremental ≡ rebuild is fuzz-proven.** The from-scratch rebuild is the
  oracle; a property test applies random mutation batches and asserts the
  incrementally-maintained index equals the rebuild — same posture as the wire
  oracles. A dev-mode assertion compares the two after each unbracketed batch.
- **D8 — Unparseable expressions degrade, never fail.** An expression with Lezer
  error nodes contributes zero edges and marks its owner opaque; the existing
  syntax diagnostic stays the user-facing signal; loads never fail; index-backed
  guards downgrade to warnings on forms containing opaque expressions.
- **D9 — Invalidation scope is a function of (mutation, pre-state).** The core
  is derived, not hand-tabled: `update*`/`rename*`/`move*` compute scope as the
  maximum over touched keys' scoping declared in the Tranche-0 surface
  registry, plus one pre-state rule (a touched field with non-empty
  `case_property_on`, or a patch touching it, invalidates the case-flow layer).
  A static kind-keyed table survives only for genuinely fixed-scope kinds, and
  unmapped kinds default to full rebuild — omissions degrade to slowness, never
  staleness. The four zero-string-change re-scoping kinds (`moveForm`,
  `updateModule({caseType})`, `updateForm({type})`, `setCaseTypes`) are the
  canonical case-flow invalidators.
- **D10 — One index, typed extractors per ref family**: Lezer walks for XPath
  surfaces; the shared bare-hashtag matcher for prose (never Lezer on prose —
  markdown swallows the `#`); structural walks for predicate/value-expression
  ASTs (refs are first-class, no parsing); direct reads for entity-uuid refs.
  Every edge carries its surface kind so per-surface policy (strict vs lenient,
  rewrite vs flag) stays expressible. Index queries are **parse-forcing**: a
  query touching lazily-parsed edges completes the outstanding per-form parses
  (through the bounded cache) before answering, so guards always see a complete
  graph; first paint pays only the structural skeleton.
- **D11 — Acyclicity is enforced per edge class.** The only platform-fatal
  class is **intra-form expression dependencies**
  (`FormDef.java::finalizeTriggerables` throws at form load). Form-link cycle
  rejection is a **Nova product rule**, kept deliberately (it preserves today's
  `FORM_LINK_CIRCULAR` stance; the acknowledged cost is that conditional
  ping-pong workflows are platform-legal — HQ validates only link-target
  existence). Parent-select-chain and root-module-chain cycles are
  platform-required classes (`validators.py` `'parent cycle'` /
  `'circular case hierarchy'`), stubbed until those features are modeled.
  Cross-form case-property cycles are legal and common — a globally-acyclic
  graph would reject valid apps. Preview's break-edge runtime tolerance stays
  as defense in depth. `setCaseTypes` gains construction-time rejection of
  `parent_type` cycles — grounded in Nova's depth-keyed `#<type>/` vocabulary
  (a cyclic chain makes type→depth ambiguous; platform-legal self-parenting is
  deliberately unsupported because the vocabulary cannot disambiguate depths),
  not platform fidelity.

## Open decision (user-owned)

**Do case properties get first-class identity** (own uuids; field id and
property name become projections), **or stay name-keyed namespaces?**

Recommendation: **name-keyed**, with the structural leaf-walk cascade making
property renames cheap and safe. "Field id = case property name" is a
load-bearing domain invariant (the wire emitters, HQ's FormActions contract,
and the SA vocabulary all consume it), and no current feature needs a property
name decoupled from its writers' ids. Promote to first-class identity only when
a concrete feature requires the decoupling. **Decision deadline: before
Tranche 5 migrates the first case-ref-bearing surface** — it changes what the
migrated leaves store.

## Tranches

Each tranche is independently shippable and none is throwaway: the registry,
guards, boundary gates, index API, and consumers are permanent under the
end-state representation. The retirement list is honest and short: the
*XPath-surface* string rewriters leave the live commit path as their surfaces
migrate (the prose rewriter is permanent), and the index's string-parsing
extractors flip to leaf-walks per migrated surface (the resolution logic
relocates into the commit-time converter).

### Tranche 0 — Ground rules: one registry, sound identifiers, one matcher

The prerequisites everything else keys on.

- **Surface registry.** One declarative table — entity type → key path →
  surface kind (`xpath` | `prose` | `predicate-ast` | `entity-uuid`) → scoping —
  consumed by the rename/move rewriters, the deep validator's surface unions
  (`XPathSurface`/`ProseSurface`/`ConnectXPathSlot`), the emitter funnels, and
  (from Tranche 2) the index extractors and D9's scope derivation. Closing the
  rewriter coverage gaps is part of shipping it: `required` first, then
  `repeat_count`, `ids_query`, `help`, `validate_msg`, option labels,
  `closeCondition.field`, form-link conditions, connect slots, and a structural
  rewrite pass for predicate-AST `PropertyRef`s (closing the rename cascade's
  predicate gap).
- **Read-side accessor.** `expressionSource(field, key)` — every expression
  reader converts to it now, so Tranche 5 swaps the implementation, not the
  call sites.
- **Multi-segment hashtag rewrites.** Teach the two rewriters
  (`lib/preview/xpath/rewrite.ts`, `lib/doc/mutations/pathRewrite.ts`) and the
  reference resolver/linter/autocomplete multi-segment `#form/<path>` refs —
  the grammar, prose pattern, emitter expansion, preview resolver, and Vellum
  round-trip already support them; only the rewriters are single-segment.
- **Identifier guards at source.** Sibling-id uniqueness on `addField`; a rename
  conflict verdict shared by the UI hook and the SA tool layer; field-id
  legality at commit. Validator rules (`DUPLICATE_FIELD_ID`,
  `INVALID_FIELD_ID`) stay as backstops. These precede the index because
  reference resolution is path/name-scoped: duplicate siblings make resolution
  ambiguous, and an index over ambiguous identifiers is unsound.
- **Matcher unification.** One shared hashtag-segment definition feeding the
  Lezer grammar's `HashtagRef`, `BARE_HASHTAG_PATTERN`, and
  `HASHTAG_REF_PATTERN`, plus a divergence-corpus test (`-` and `.` segments,
  markdown-adjacent text, multi-segment forms).

**Verification:** run dev, open the builder, rename a field referenced in
another field's `required` expression — the reference follows the rename (it
silently breaks today). Ask the SA to rename a field to an id its sibling
already holds — the tool call fails with a message naming the conflict.

### Tranche 1 — Boundary gates: parse-at-commit and export readiness

Closes the two live product holes that don't need the index, and establishes the
permanent commit choke point.

- **Parse-at-commit.** Every expression-bearing write parses through the Lezer
  grammar at the commit boundary — the hook/tool layer that accepts the raw
  string, via a shared `validateExpressionContent` verdict (syntax,
  unknown-function, arity, unmodeled fixture refs; the `lib/commcare` parser is
  already importable there). Rejections are Elm-style, returned per the
  verdict-channel rule. Only the *changed* expressions are gated — an edit to
  an unrelated property of a field whose stored expression predates the gate
  must not block. This is the seam where Tranche 5's string→AST conversion
  later runs — the parse call doesn't move; we start keeping the tree.
- **Export readiness.** Extract the ~11 completeness codes into
  `checkExportReadiness(doc)`; gate `/api/compile`, `/api/compile/json`,
  `/api/commcare/upload`, and the MCP compile/upload tools on it (reject, no
  override), alongside the existing media gate. MCP failures use the
  `invalid_input` envelope carrying the readiness list; the docs site and
  plugin notes flag the contract change for existing MCP clients. The SA's
  end-of-turn check and a passive UI "what's left" affordance read the same
  function. An app may sit incomplete while building; it cannot *export*
  incomplete. **This is where "always exportable" becomes true** — today
  neither export path validates at all.
- **Legacy sweep.** A read-only scan script reporting stored expressions that
  fail the parse (dry-run only; migration is the user's call).

**Verification:** type `foo(bar` into a calculate in the builder — the commit is
rejected with a message naming the problem; the SA gets the same as a tool
failure. Hit `/api/compile` on a module with no case-list columns — 4xx listing
exactly what's missing; the builder shows the same list passively.

### Tranche 2 — The reference index

The structure from "End-state architecture", built to D1–D11. Lives in its own
`lib/doc`-adjacent package behind the Biome boundary; built from-scratch in
`load()` (structural skeleton eager, per-form expression parse lazy behind
parse-forcing queries with a bounded expression→result cache); maintained
incrementally at batch end through D9's scope derivation; deferred only across
replay/load (D6); fuzz-proven incremental ≡ rebuild (D7).

API shape (the permanent contract consumers code against):
`referencesOf(owner)`, `whoReferences(node)`, plus case-flow queries —
`writersOf(caseType, prop)` (admission-scoped and app-wide variants),
`reachableTypes(formUuid)`, `listersOf(caseType)`.

**Verification:** a NODE_ENV-gated overlay inside the builder (reading the same
store instance) renders index stats and D7's live incremental-vs-rebuild parity
assertion; edit the app while watching it — parity stays green. The fuzz oracle
is green in CI.

### Tranche 3 — Convert the reference class

The 16 codes flip to construction time; reference-breaking edits become
deliberate acts.

- **Delete** routes through the index pre-dispatch: the UI gets a resolution
  dialog ("N fields reference this — clear references / reassign / cancel");
  the SA gets a structured tool *failure* (the existing `{ error }` shape)
  carrying the orphan list and the legal strategy tokens, and re-issues with an
  explicit strategy. Same verdict engine, two renderings. Schema delta: an
  optional `strategy` enum on the remove-family tool inputs — **owner sign-off
  required** (SA-surface rule), named here so the permission is requested in
  the spec rather than discovered mid-implementation.
- **Move re-anchors instead of dropping**: a cross-depth move rewrites
  `#form/foo` → `#form/<group-path>/foo` — multi-segment hashtags, one
  mechanism that works identically on XPath and prose surfaces (absolute-path
  conversion is wrong for prose: `BARE_HASHTAG_PATTERN` can't match it, so the
  ref would silently die as literal text). `droppedCrossDepthRefs` is
  eliminated, not surfaced. Rides Tranche 0's multi-segment rewriter work; the
  rewrite itself remains a reducer side effect per D4.
- **Re-scope guards cover the full D9 set**: `moveForm`,
  `updateModule({caseType})`, `updateForm({type})`, and `setCaseTypes`
  (parent_type edits and case-type removals) all consult the case-flow graph
  pre-dispatch; an edit that re-scopes existing refs blocks with the
  affected-reference list — same dialog/structured-failure contract as delete.
- **Cycle rejection at commit** per D11's classes: per-form triggerables (the
  platform-fatal class), form links (Nova product rule), `parent_type` cycles
  in `setCaseTypes`.
- **Rename/move verdicts via index**: conflict detection and the "this will
  touch N references" preview run pre-dispatch on `whoReferences`; the cascade
  itself stays in-reducer (D4).
- **Read-path consolidation.** `ReferenceProvider`, the lint context, and the
  autocomplete universe become projections of the index (the index becomes the
  single opinion, not a fifth one). TriggerDag keeps its own per-form runtime
  build — evaluation semantics stay in the engine — but sources edge extraction
  from the same shared extractors.

**Verification:** delete a field that other fields reference — a dialog lists
every dependent and requires a choice (today it deletes silently). Move a field
into a group when a hashtag references it — the reference survives as a nested
hashtag and still renders/lowers everywhere (today it dangles silently). Create
a calculate cycle — the edit is rejected naming the cycle. Switch a followup
form to survey while it holds case refs — blocked with the affected-reference
list.

### Tranche 4 — Commit-guard the rest

The ~53 remaining authoring codes move to their named mechanisms, each riding
the verdict channel and, where cross-entity, the index (writer tuples, sibling
sets, link edges make them O(1) instead of full-doc scans): ~24 typed-schema
tightenings, ~19 commit guards (duplicate module names, case-type
format/length, reserved namespaces, select-with-no-options, connect rules
beyond the slug family, case-search compatibility rules), ~10 expression type
checks at commit (the `typeChecker` slice, fed by the index + catalog). The
completeness set explicitly does **not** move — it stays at the export boundary
by the category argument above.

**Verification:** each migrated rule has a repro: attempt the invalid edit in
the UI — blocked inline with the reason; ask the SA to do the same — the tool
call fails with the same reason. The corresponding validator codes never fire in
the full test suite's generated-app corpus.

### Tranche 5 — Representation migration, per surface

Surface-by-surface, in expression-density order: `calculate` → `relevant` →
`validate` / `default_value` / `required` → `repeat_count` / `ids_query` →
connect slots. Per surface:

- Persist the typed AST (uuid leaves for form-local refs; `(caseType, prop)`
  leaves per the open-decision outcome; `.`/`..` are structural context nodes,
  never uuid leaves); project strings through `expressionSource` and the wire
  emitters.
- **Conversion is round-trip-gated**: an expression converts only when
  `print(parse(s)) === s` byte-exactly; otherwise it stays a string and the
  scan reports it. No mixed semantics — a non-converting expression keeps full
  string behavior until cleaned up.
- **Replay and ingest ride the same converter** — the **upgrade shim**: the
  Tranche-1 commit-boundary string→AST converter runs at every non-commit
  ingress (ReplayHydrator dispatch, chapter scrubbing, the ingest parse,
  recovery scripts), converting string payloads at dispatch time (unparseable
  strings degrade per D8). Old event logs replay through *current* reducers
  with original semantics reproduced by projection — no frozen legacy reducers,
  no event-log epochs, no dual-format reducer arms, and no
  mixed-representation doc can exist.
- That surface's string rewriter leaves the live commit path (the in-reducer
  cascade becomes a structural leaf-walk for it). The prose rewriter is
  unaffected and permanent.
- `duplicateField` copies AST leaves **verbatim** through `cloneFieldSubtree`,
  preserving today's duplicate semantics (clone refs keep pointing at the
  original's targets exactly as copied strings re-resolve today) and
  migrate∘duplicate commutativity.
- One-time migration of existing docs: scan (read-only) + migrate (dry-run
  default, `--apply`) scripts; the user decides when each runs.

**Verification (per surface):** rename a field referenced by a migrated
surface — the stored doc's migrated payload contains no string representation
(representation-invariant test), the projected text is correct on every read
edge, and no Lezer parse executes during the rename of a fully-migrated form
(reducer-path assertion). The wire regression compares per-entry bytes of the
`.ccz` archives (deterministic id factory injected; zip container headers
ignored) — byte-identical entries pre/post migration across the corpus.

### Tranche 6 — Retire the user-facing validateApp

- The SA loses the validate-fix loop: the FIX_REGISTRY and the
  stuck-signature check are removed from `validationLoop.ts`; the end-of-turn
  call becomes `checkExportReadiness`, which **informs the SA's reply and the
  UI checklist but never gates run completion**.
- The success-arm side effects relocate from `solutionsArchitect.ts` to the
  shared run-completion path keyed off the drain's terminal state —
  `completeApp` + `materializeCaseStoreSchemas` run on every successful turn
  regardless of readiness, and MCP-driven builds gain materialization (closing
  today's accidental chat-only asymmetry).
- The MCP `validate_app` tool repurposes to the readiness checklist readout.
- The 16 reference-class codes demote to the fuzz harness as
  construction-guarantee oracles (a failure is a guard bug, never a fixable
  authoring state) — joining the wire oracles, which never change. **The
  demotion gate enumerates guard coverage per re-scoping mutation kind** (the
  D9 four), not just per validator code.
- **Ingest hardening is index-backed**: a doc that bypassed the guarded write
  paths gets `blueprintDocSchema` parse + index build + the reference-class
  verdict functions run against the fresh index, with failures routed through
  the same resolution contract guards use — ingest converges on the
  construction invariant instead of being schema-shape-only.
- Clean up the stale `validateAndFix` re-export comment in
  `lib/agent/index.ts` while touching it.

**Verification:** run a full SA build — the event log contains zero
validation-fix-stage mutation events (observable via `scripts/inspect-logs.ts`);
the built app exports clean. `/api/compile` on an app with a pending media
asset still blocks (the media gate is untouched). The fuzz suite — random
mutation sequences through `applyMutations` — never produces a doc that trips a
demoted oracle.

## Sequencing rationale

- **Registry before everything**: every later layer (extractors, rewriters,
  guards, scope derivation, the migration list) consumes the same enumeration;
  today's bug class *is* the enumeration drift.
- **Identifier guards before the index**: resolution soundness; an index over
  ambiguous identifiers indexes ambiguity.
- **Boundary gates early and independent**: ungated export is a live product
  hole today, and the verdict channel is shared plumbing every later guard
  rides.
- **Index before representation migration**: the predicate-AST lesson —
  structure without identity resolution and a reverse index mints stale refs;
  migrating surfaces first would re-create that bug class per surface. The
  index is also the migration's verification harness.
- **Migration before retirement**: rewriters leave the commit path
  surface-by-surface; `validateApp` retires when the guards cover everything it
  caught.

## Testing strategy

- **State-model tests** for every verdict function and guard (no UI mounting —
  test the reducer + index directly).
- **Incremental ≡ rebuild fuzz oracle** (D7) from Tranche 2 onward; dev-mode
  per-batch assertion on unbracketed batches.
- **Round-trip law fuzz** (Tranche 5): `print(parse(s)) === s` for every
  parse-clean expression the corpus and arbitraries produce.
- **Mutation-sequence fuzzing**: extend `blueprintDocArbitrary` to generate
  random mutation sequences through `applyMutations`, asserting committed docs
  never trip the demoted oracles — the construction-guarantee proof that gates
  Tranche 6.
- **Wire entry-byte regression** per migrated surface (Tranche 5), across the
  generated-app corpus, under a deterministic id factory.
- The existing wire-oracle fuzzers keep proving emitter totality, unchanged.

## Risks

- **A missed reference surface = a silent dangling ref with no backstop** (after
  Tranche 6). Mitigation: the registry is the single enumeration; demotion is
  gated on the mutation-sequence fuzz *and* per-mutation-kind guard coverage;
  validator backstops stay until their guard is proven.
- **Incremental-index drift** — the classic cache-invalidation bug class, and
  strictly worse than today's parse-everything-on-demand (which cannot drift).
  Mitigation: D7's oracle + dev assertion; D9's default-to-rebuild on unmapped
  kinds.
- **zundo memory amplification** if the index defeats structural sharing.
  Mitigation: D3's partition discipline; measure history memory on a large
  fixture before locking.
- **Replay/first-paint cost** of eager parsing. Mitigation: D6's replay
  bracket, parse-forcing lazy queries, bounded parse cache; measure on a
  realistic large blueprint.
- **Guard-placement bypass** — a guard only at the UI hook layer leaves the SA,
  MCP, fix-loop, and recovery paths unguarded. Mitigation: D5 — shared verdict
  functions at the shared tool layer, including the fix loop during the
  coexistence window.
- **Provenance ambiguity** — a property node that ignores the
  declared>standard>writerDerived priority or the writer-scope split drives
  guards that disagree with the rules they replace. Mitigation: priority and
  scope are pinned on the node/query design above.

## Non-goals

- Replicating CCHQ's validation UX or save/version gauntlet (locked: Nova apps
  are always export-ready; reject at construction).
- Persisting the index, in the app doc or a sidecar.
- Global acyclicity (D11 — it would reject valid apps).
- Preview-mode or runtime/case-store model changes (locked elsewhere).
- New CommCare authoring features — this program is about where and how validity
  is enforced.
