# Valid by Construction — Program Spec (v3)

Supersedes `2026-05-31-valid-by-construction-design.md` and the v2 revision of
this file. Provenance, recorded deliberately: v2's review was contaminated (the
author's draft decisions rode into reviewer prompts as locked axioms). v3 is a
synthesis of two uncontaminated streams produced 2026-06-09 — a clean-room plan
derived from the codebase by an agent with no access to prior artifacts, and a
blind A/B architecture evaluation (two requirement-only derivations, symmetric
attack/steelman, three independent judges, unanimous verdict) — plus the v2
ground-truth facts, which were independently fact-checked against main and
held. Owner decisions approved 2026-06-09: introduced-error gate semantics, the
completeness ratchet, MCP `draft` status, the SA schema deltas named below, and
proof-based retirement of `validateApp`. Delivery model (owner decision
2026-06-10): the program ships as ONE continuous build on this branch — the
stages below are BUILD ORDER (real dependency sequencing), not shipping
boundaries; no per-stage PRs, no transitional coexistence machinery whose
only purpose is to make an intermediate merge production-coherent. The
branch stays suite-green at every commit; user-runnable verification lines
are checkpoints, not ship gates. (This worktree is behind
main — rebase before implementation starts.)

## Goal

**Every committed mutation batch leaves the blueprint valid, identically for
the builder UI, the chat SA, and MCP, so invalid states are never persisted.**
The after-the-fact `validateApp` fix loop — today the only validity net in the
system — is deleted once the construction-guarantee proof covers everything it caught. What
survives at the boundaries is small and fix-free: the media-state export gate,
a completeness check at transaction boundaries, an index-backed ingest gate for
docs that bypassed the guarded paths, and the wire oracles (already CI/fuzz
tripwires, never authoring gates — untouched).

The program has three layers, built in dependency order:

1. **The validity gate** — valid-at-every-commit, enforced now, with the
   machinery the codebase already has (scoped validation walks). Correctness
   does not wait for new infrastructure.
2. **The reference index** — the requirement that reference operations in the
   write path (rename/move/delete cascades, every future reference-aware
   operation) never perform document-wide searches; cost proportional to the
   references actually involved. Lands underneath the gate and swaps its
   verdict implementations from walks to queries.
3. **Canonical structured expressions** — XPath surfaces migrate to typed ASTs
   whose reference leaves carry stable identity, making form-local renames
   rewrite nothing and killing the string-rewrite machinery at the root.

## Definitions

### Five validity classes, five enforcement points

| Class | Definition | Enforcement |
|---|---|---|
| **Shape** | Wrong structure (kind-mismatched property, malformed doc) | Already unrepresentable (Zod schemas, reducers' `safeParse`, strict per-kind tool arms) — keep |
| **Soundness** | A wrong thing *exists*: bad XPath, dangling reference, duplicate id, type error, dependency cycle, reserved name, contradictory config | **Every commit, every surface** — rejected before persistence |
| **Completeness** | Construction not *finished*: `NO_MODULES`, `EMPTY_FORM`, `MISSING_CASE_LIST_COLUMNS`, `NO_CASE_NAME_FIELD`, `REGISTRATION_NO_CASE_PROPS`, `CHILD_CASE_NO_NAME_FIELD`, `MISSING_CHILD_CASE_MODULE`, `CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE`, the Connect missing-block family | **Ratchet on every commit** (an edit may never take a complete entity incomplete) + **zero-tolerance at transaction boundaries** (build completion, export, upload) |
| **Environment** | Media asset existence/readiness/kind vs external Firestore/GCS state | Attach-time checks for what's knowable (exists / owner / kind); readiness stays an export-boundary gate |
| **Oracle** | `XFORM_*` / `SUITE_*` / `HQJSON_*` / `BINDING_RESOLUTION_*` — generator-bug tripwires | CI/fuzz primary; at boundaries they are Sentry-reported *infrastructure* errors, never SA-fixable authoring states |

Completeness is deferred during construction because building takes time — a
scaffolded-but-unfilled form is unfinished, not wrong, and the codebase already
models the build window (`status: "generating"`; "app-exists stays false during
initial generation"). Forcing completeness at every write would require
mega-atomic whole-app tool calls, which the staged tool design deliberately
rejects.

### Introduced-error semantics

A commit is accepted iff `errors(nextDoc) ⊆ errors(prevDoc)` under stable error
identity (code + location uuids + surface key). Transaction boundaries require
the empty set. Consequences, each load-bearing:

- **Monotone**: apps only get better; no edit can add a soundness error, and
  no edit can take a complete entity incomplete.
- **Legacy-safe with zero migration**: pre-existing invalid Firestore apps stay
  editable — edits to untouched-broken regions pass; the broken region itself
  can only improve. No ingest rejection, no repair migration required to ship.
- **Build-coherent**: a fresh build is born at zero soundness errors (under
  deferred completeness) and the per-call gate keeps it there by induction, so
  the terminal check can only fail on completeness — work not yet done, never
  damage to repair.

### Unit of validity and enforcement placement

The **persisted mutation batch** is the unit — one `applyMany` / one
`recordMutations` call. Co-dependent mutations ride one batch; tools that stage
multiple batches (`editField`'s convert→rename→patch) must make each stage
independently valid, reporting the committed prefix on a mid-call rejection.

Both surfaces apply through the single reducer
(`lib/doc/mutations/index.ts::applyMutations`; client via
`lib/doc/store.ts::applyMany`, server via
`lib/agent/tools/common.ts::applyToDoc`). **Gate verdicts run at the commit
boundary** — the UI dispatch/commit layer and the shared SA/MCP tool layer —
via one shared verdict module (the connect-slug pattern: one function, every
caller). **Reducers stay total** with their existing warn-and-skip semantics,
so historical event-log replay never blocks on a degenerate event. The
rejection channel is the verdict's typed return: the UI renders it inline and
never dispatches; the tool layer maps it to the standard `{ error }` envelope
with the already-SA-tuned humanized messages. `MutationResult[]` stays what it
is (post-apply toast metadata), not a rejection path.

## Ground truth (verified 2026-06-09 against main)

The facts the design rests on; each was independently verified, most twice.

**Validity is owned by `lib/commcare/validator/`** — ~190 codes in
`errors.ts`; domain rules walk the doc once (`runner.ts::runValidation`);
deep XPath validation (`validator/index.ts::validateBlueprintDeep`) covers
syntax/function/arity/refs/case-refs/cycles/types over every XPath and prose
surface; post-expansion oracles prove emitter totality. The fix loop
(`lib/agent/validationLoop.ts::validateAndFix`) applies `FIX_REGISTRY` (13
codes) in `fix:attempt-N` batches with a 3-consecutive-identical-signature
stuck check; the chat-side success arm (`lib/agent/solutionsArchitect.ts`)
awaits `materializeCaseStoreSchemas`, emits `data-done`, fires `completeApp` —
chat-only; MCP builds never run them.

**None of the four commit surfaces enforces semantic validity.** UI edits
persist via auto-save through a PUT that checks only the Zod shape parse. SA
tools persist fire-and-forget per call — invalid intermediates are durable
throughout builds and edits; a run that dies mid-way leaves the invalid state
as the final state. MCP tools persist per call with nothing forcing an external
client to ever validate — and `lib/mcp/tools/createApp.ts` mints an empty app
with `status: "complete"`, violating `NO_MODULES` from birth. **Neither export
path validates the blueprint** — compile and HQ-upload run only the media
validator. A semantically broken app exports and uploads today.

**Validity-by-construction already exists in patches — the pattern to
extend:** per-kind field shape (reducer `safeParse` + strict tool arms);
sibling-id dedup on move; the rename XPath cascade; the UI `XPathField`
refusing to commit unparseable expressions; connect-id enforcement at every
source with the validator as backstop; media deletion's reference guard; the
total, fuzz-proven wire emitters.

**The reference machinery is partial, asymmetric, and already drifting:**

- Three layers disagree on which surfaces carry references. The rename/move
  rewriters cover `relevant`/`calculate`/`default_value`/`validate` +
  `label`/`hint`; emit and the deep validator cover ~15 surfaces.
  **Live bugs**: `required` is excluded from the rewrite list under a stale
  comment, so renames silently break `required` expressions; the prose scanner
  declares `help`/`validate_msg`/option-label as hashtag carriers but the
  cascade rewrites only `label`/`hint` — those refs silently never rewrite.
- A cross-depth `moveField` **drops** `#form/` hashtag refs
  (`MoveFieldResult.droppedCrossDepthRefs` — no consumer reads it). The
  limitation is the rewriters', not the syntax's: the grammar, prose pattern,
  emitter expansion, preview resolver, and Vellum's canonical `#form/group/q`
  all handle multi-segment hashtags; only the rewriters are single-segment.
- `removeField`/`removeForm`/`removeModule` are pure cascades — no reference
  scan; every inbound reference orphans silently. `moveForm`,
  `updateModule({caseType})`, `updateForm({type})`, and `setCaseTypes`
  re-scope what refs resolve to with zero string changes.
- The rename cascade's app-wide scans live inside the reducer
  (`fields.ts::cascadeCasePropertyRename` scans `Object.entries(doc.fields)`
  and walks every module × form × field); a duplicate of the peer scan exists
  client-side in `lib/doc/hooks/useBlueprintMutations.ts`.
- `addField` has no sibling-id uniqueness check; the SA rename path has no
  conflict guard (only the UI hook pre-checks); field-id legality is
  validate-time + autofix.
- The case-type catalog (`doc.caseTypes`) is written wholesale
  (`setCaseTypes`) and by the rename cascade only — `addFields` introducing a
  new case property never extends it, so case-ref validation
  (`caseRefAcceptMap` reads the catalog) can lag live writers.
- No expression references anything by stable identity; uuid refs exist only
  at the entity level (`form_links` targets, media `AssetId`s). The store
  itself is uuid-normalized.

**Write-path topology facts (decisive for the index design):**
`applyMutations` is the real chokepoint — five non-test wrappers (client
store, server tool path, two validation-loop sites, replay chapters); there is
no single "dispatch layer" above it. The streamed-mutations contract: the SA
streams bare `Mutation[]`; the client feeds them straight into `applyMany`; the
event log replays one-mutation batches through *current* reducers; reducer
side effects must therefore reproduce identically from the bare mutation.
zundo snapshots whole store state (limit 100, no partialize) in one `set()`
per batch; `moveField`'s sibling dedup happens mid-batch on the live draft, so
no pre-dispatch expander can know its outcome. The only derived-index
precedent (`fieldParent`) lives inside `applyMutations`; its batch-end timing
is documented as legal *only because no reducer reads it* — a reference index
read by reducers mid-batch must be maintained per-mutation.

**Structural scope facts:** the builder UI has no module/form create/delete
affordances (structural mutation is SA/MCP-only), which shrinks the UI gating
surface. The app lifecycle already encodes build-as-transaction for chat
(`generating` → `completeApp`, stale-`generating` reaper); MCP bypasses it
entirely.

**Platform facts (verified in the Dimagi checkouts):** intra-form triggerable
cycles are form-load fatal
(`commcare-core .../FormDef.java::finalizeTriggerables` throws). Form-link
cycles are platform-legal (HQ validates only link-target existence) —
rejecting them is a Nova product rule. Parent-select-chain and
root-module-chain cycles are the platform-required classes, stubbed until
those features are modeled. HQ has no rule requiring a created child case type
to be listed by a module — `MISSING_CHILD_CASE_MODULE` is stricter than the
platform and is a completeness check, not a soundness one. A case type is
usable only through a case-list detail (HQ `'no case detail'`;
`SessionDatumParser.java:60` — the detail IS the selection UI).

## Architecture

### Layer 1 — the validity gate

```
lib/commcare/validator/gate.ts        (new)
  classifyError(code)  → shape | soundness | completeness | environment | oracle
  errorIdentity(err)   → stable key (code + location uuids + surface key)
  diffIntroduced(prev, next) → ValidationError[]
  evaluateCommit({ prevDoc, nextDoc, scope, phase })
      → { ok: true } | { ok: false, introduced: ValidationError[] }
      phase: "building" (completeness deferred) | "complete" (ratchet)
  evaluateBoundary(doc, manifest) → ValidationError[]   // zero-tolerance, full run
```

The classification table is typed `Record<ValidationErrorCode, Class>` so a new
code without a class fails compile. `evaluateCommit` runs **scoped
validation**: the runner gains a `{ formUuids?, moduleUuids? }` filter, scope
derived from the batch's mutations (`scopeOfMutations`, widening to all
modules of a case type for case-property-touching mutations). Scoped-equals-
full-filtered is property-tested. Boundaries and saves run the full doc — the
current loop already runs full validation several times per build, so this is
not a regression; a perf-guard test on a large fixture keeps it measurable.

Phase derivation: `generating` (chat builds) and `draft` (MCP builds, new) are
`building`; everything else is `complete`.

Call sites: a `guardedMutate` wrapper in `lib/agent/tools/common.ts` (one
change covers chat + MCP — both run the same tool bodies); the UI dispatch
layer (`useBlueprintMutations`) at-source; `app/api/apps/[id]/route.ts::PUT`
as the server backstop for the UI (rejections are Sentry-visible client-gate
bugs, not expected UX); the export/upload/compile routes and MCP tools plus
the new `completeBuild` tool as boundaries. Agent-originated client applies
and replay bypass the client gate — the server already gated them.

### Layer 2 — the reference index

Unanimous judge verdict (B-modified), independently converged on by both blind
derivations: **the index lives inside the write path and reducers read it.**

- **Placement**: derived state on `BlueprintDoc`, maintained **per-mutation**
  inside `applyMutations`/`dispatchMutation` — index state is a deterministic
  function of (initial doc, mutation prefix), identical in every consumer of
  the one shared reducer. Server/client byte-identity, streamed-mutation
  replication, and event-log replay are preserved *by construction* because
  there is no second code path.
- **Shape** (plain JSON records — no Map/Set; zundo snapshots whole state):
  `refs.in: Record<TargetKey, Record<CarrierKey, true>>` — TargetKey is
  `u:<fieldUuid>` (form-local) or `c:<caseType>/<propName>` (case property);
  CarrierKey is `<ownerUuid>:<slot>`. Plus `refs.decl`: the **declarations
  index** `(caseType, propName) → declaring field uuids` — without it,
  case-property peer discovery remains the full-doc scan and the no-search
  requirement is unmet for that operation class.
- **No stored spans.** Edges name *where* (carrier entity + slot); the rewrite
  re-derives *what* inside that one entity with the existing single-entity
  rewriters (Lezer/regex today, structural leaf replacement post-migration).
  This structurally kills the stale-span-splices-garbage failure mode and
  keeps doc bytes derived from doc truth.
- **Maintenance**: one **generic hook** at the `dispatchMutation` chokepoint —
  un-index the named entity's old edges, re-extract from its post-reducer
  state (cost: that entity's own refs) — never hand-written per-reducer
  bookkeeping across ~26 mutation kinds. Reducer silent no-ops need no
  mirroring: re-extraction of an unchanged entity is a no-op by construction.
- **Extraction** from **one slot registry** of reference-bearing slots per
  entity kind, derived from and audited against the `lib/domain` schemas —
  closing the verified live gaps (`required`; `help`/`validate_msg`/
  option-label prose; case-list columns/filter; search-input predicates;
  connect slots; `closeCondition.field`; form-link conditions; predicate-AST
  `PropertyRef`s). The registry is shared by the extractor, the rewrite walks,
  the commit guards, and `buildReferenceIndex` — one enumeration, four
  consumers, no drift surface.
- **Prose edges** run the chip resolve gate (`classifyNamespace` +
  resolution), never the bare permissive regex — plain text that merely looks
  like a hashtag never enters the index.
- **Boundaries**: never persisted — `toPersistableDoc` extends to strip it
  (and the three hand-rolled inline `fieldParent` destructures centralize
  while touching this). Rebuilt at every hydration site, enumerated:
  `store.load()`, the `data-done` full-doc reconciliation (bypasses the
  mutation stream), replay seeding, MCP `loadAppBlueprint`, chat-route doc
  materialization. Consumers reach it only through a narrow query API
  (edges-of-target, declarers-of, edges-of-owner) behind a Biome
  `noRestrictedImports` ban — no consumer can iterate the raw index.
- **Correctness discipline** (the emitter-oracle pattern; no runtime prod
  validation): `buildReferenceIndex(doc)` is simultaneously the hydration
  builder and the fuzz oracle. Dev-mode batch-end assertion
  (incremental ≡ rebuild) plus CI fuzz over mutation-sequence generators whose
  alphabet includes multi-mutation batches with intra-batch reference
  dependencies and malformed-XPath strings.

What the index makes index-driven: the rename cascade (peers from
`refs.decl`, carriers from `refs.in` — replacing both reducer scans and the
duplicated client-side peer scan), move re-anchoring, delete-impact verdicts
with carrier lists, cycle DFS over `u:` edges, find-references, and the lint/
autocomplete/chip read paths (which become projections of the index instead of
parallel derivations).

### Layer 3 — canonical structured expressions

XPath surfaces migrate, surface-by-surface, to a typed AST following the
`Predicate`/`ValueExpression` pattern: built *from* the Lezer parse, carrying
inter-token trivia, with a printer obeying a fuzz-pinned round-trip law —
`print(parse(s)) === s` byte-exactly for every parse-clean `s`. Reference
leaves carry identity: **uuid leaves** for form-local refs, **`(caseType,
propName)` leaves** for case refs (no depth structure needed — depth is
uniquely derivable per form at emit, registration narrowing included;
unreachable leaves re-project as verbatim `#<type>/<prop>` text), named leaves
for `#user/<prop>`. `.`/`..` are structural context nodes, never uuid leaves.

Strings at the edges: wire emission projects text; the expression editor
round-trips text ↔ AST at commit; the SA surface stays string-typed (parsing
inside the tool handler); every read edge goes through one accessor
(`expressionSource(field, key)`) introduced in Stage 0 so migration swaps the
implementation, not the call sites. **Prose stays markdown strings
permanently** — prose refs are indexed, never restructured, and the prose
hashtag rewriter is permanent.

Replay compatibility is solved by one-time data migration, not permanent
machinery: when a surface migrates, one-off scripts (scan read-only; migrate
dry-run default, `--apply`; deleted after the run — the established pattern)
convert stored docs AND stored event-log mutation payloads to the AST format,
so replay reads already-migrated events through current reducers — no frozen
legacy reducers, no event-log epochs, no permanent replay shim. The
string→AST converter is permanent only at the live commit boundary (the SA
writes strings forever); recovery scripts route through it too. Conversion is
round-trip-gated: an expression converts only when `print(parse(s)) === s`;
otherwise it stays a string, the scan reports it, and reducers degrade per
D10.

Under this representation a form-local rename rewrites *nothing* on migrated
surfaces (leaves hold the uuid); a case-property rename remains a cascade
(peers co-own the name) executed as a structural leaf-walk on exactly the
indexed carriers.

## Design decisions (locked)

- **D1 — Introduced-error gate semantics** (owner-approved): monotone
  `errors(next) ⊆ errors(prev)`; empty set at boundaries; identity =
  code + location uuids + surface.
- **D2 — Completeness ratchet** (owner-approved): deferred while `building`,
  ratcheted while `complete`; zero-tolerance only at transaction boundaries.
- **D3 — Per-call gating for the SA, never run-level buffering**: buffering
  breaks fail-closed persistence, live streaming, and crash recovery — all
  load-bearing. Per-call rejection converts the end-of-run error dump into
  immediate local feedback.
- **D4 — Index inside the write path, per-mutation, reducer-readable**
  (judge-unanimous; supersedes v2's batch-end/no-reducer-reads rule, which
  made the no-search requirement unmeetable). Mid-batch currency is required:
  a batch that adds a referencing expression then renames its target must see
  the new edge.
- **D5 — Carrier-keyed edges, no stored spans** — re-derive edits inside the
  named carrier; never trust positional data across mutations.
- **D6 — One slot registry**, typed total over entity kinds, shared by
  extractor/rewriters/guards/oracle-builder.
- **D7 — Declarations index** alongside reference edges — peer discovery must
  be a lookup, not a scan.
- **D8 — Reducers stay total** (warn-and-skip); rejection lives at the commit
  boundary via shared verdict functions; the verdict's typed return is the
  rejection channel.
- **D9 — Oracle discipline, no runtime self-validation**: `buildReferenceIndex`
  doubles as hydration builder and fuzz oracle; dev assertion + CI fuzz; a
  failure is a maintenance bug, never a new runtime check.
- **D10 — Unparseable expressions degrade**: zero edges, owner marked opaque,
  existing syntax diagnostic as the signal; loads never fail; guards downgrade
  to warnings on opaque-bearing forms.
- **D11 — Acyclicity per edge class**: intra-form triggerables
  (platform-fatal) and form links (Nova product rule, kept) reject at commit;
  `setCaseTypes` rejects `parent_type` cycles (grounded in the depth-keyed
  `#<type>/` vocabulary, not platform fidelity); parent-select/root-module
  classes stubbed; cross-form case-property cycles are legal — global
  acyclicity would reject valid apps. Preview's break-edge tolerance stays as
  defense in depth.
- **D12 — MCP builds get `draft` status** (owner-approved): reaper-exempt,
  list-visible, `building`-phase; `complete_build` flips it. Complete-at-birth
  dies.
- **D13 — Atomic structural creation in edit mode** (owner-approved SA schema
  delta): `createForm` requires `fields` (registration units must include a
  case-name writer); `createModule` requires `forms` + case-list `columns`
  when case-managing. Tool use is not grammar-constrained, so the large inputs
  are legal; `scripts/test-schema.ts` proves acceptance. Build mode keeps the
  staged scaffold flow under the `building` window.
- **D14 — Proof-based retirement of `validateApp`** (owner decision
  2026-06-10, superseding the earlier measured-retirement plan): no
  production observation window, no safety-net coexistence period — the
  validate-fix loop is deleted in the same continuous build once the
  construction-guarantee proof covers everything it caught: the
  mutation-sequence fuzz (random batches through `applyMutations` never
  trip a demoted code) plus per-re-scoping-mutation-kind guard coverage
  (`moveForm`, `updateModule({caseType})`, `updateForm({type})`,
  `setCaseTypes`), not just per-code coverage. Proof by construction
  replaces monitoring.
- **D15 — The 13 auto-fixes dissolve into construction defaults at their
  sources** (required `case_type` at module creation; `options: min(1)` +
  UI-seeded options; XML-name checks at rename/add boundaries; connect
  defaults derived at `updateForm`/scaffold/UI-toggle time; reserved-property
  rejection at the boundary) — each fix deleted as its source enforcement
  lands.

## Resolved decisions (owner, 2026-06-09)

1. **Case properties stay name-keyed namespaces.** "Field id = case property
   name" remains the domain invariant — it is load-bearing across the
   emitters, HQ's FormActions contract, and the SA vocabulary, and the indexed
   leaf-walk makes property renames cheap without new identity. Revisit only
   if a concrete feature needs a property name decoupled from its writers'
   ids.
2. **`duplicateField` copies reference leaves verbatim** — clones keep
   pointing at the original targets, preserving today's behavior and
   migrate∘duplicate commutativity.
3. **Historical event logs are migrated in place, not shimmed.** Per-surface
   scan + migrate scripts (read-only scan; migrate dry-run default,
   `--apply`; user-run; deleted after the run) convert stored event-log
   payloads alongside the doc migration. No permanent replay-ingress
   converter. Non-round-tripping legacy payloads stay strings and degrade per
   D10.

## Stages

Stages are build order, not shipping boundaries — dependencies are real
(registry before index, identifier guards before index, gates before loop
removal, index before migration), the merge is one PR at the end. Docs
(CLAUDE.md + the public docs site) move with the work that changes behavior.

### Stage 0 — Foundations (no behavior change)

1. `gate.ts`: classification table (typed-total over all ~190 codes; the
   class assignments above are the seed — the task audits every domain code
   file-by-file against its rule implementation), `errorIdentity`,
   `diffIntroduced`, `evaluateCommit`, `evaluateBoundary`.
2. Scoped runner: `{ formUuids?, moduleUuids? }` filter on `runValidation` +
   `validateBlueprintDeep`; `scopeOfMutations` beside the gate.
3. **Slot registry** (D6) + closure of the rewriter coverage gaps it exposes:
   `required`, `help`/`validate_msg`/option-label prose, `repeat_count`,
   `ids_query`, `closeCondition.field`, form-link conditions, connect slots,
   predicate-AST `PropertyRef` rewrite pass. Load-bearing for the gate: once
   introduced-error rejection lands, an un-rewritten ref would make legitimate
   renames *reject* — coverage must close first.
4. **Multi-segment hashtag rewrites** in both rewriters + resolver/linter/
   autocomplete: cross-depth moves re-anchor `#form/foo` → `#form/group/foo`
   (one mechanism, XPath and prose; absolute-path conversion is
   prose-destroying and is not used). Same load-bearing argument: post-gate, a
   ref-dropping move would reject.
5. Identifier guards at source: sibling-id uniqueness on `addField`; shared
   rename-conflict verdict (replacing the UI-only check and covering the SA
   path); XML-name legality at rename/add.
6. Matcher unification: one shared hashtag-segment definition feeding the
   grammar, `BARE_HASHTAG_PATTERN`, and `HASHTAG_REF_PATTERN`; divergence-
   corpus test.
7. Catalog sync at source: `addFields`/`editField` mutation builders append
   new `(case_type, property)` pairs to `doc.caseTypes` (what the rename
   cascade already maintains).
8. Read-side accessor `expressionSource(field, key)`; convert every expression
   reader.
9. Tests: classification totality; identity stability under unrelated edits;
   scoped ≡ full-filtered (property-tested); perf guard on a large fixture.

**Verification:** `npm run test && npm run build` green. Behavior identical —
user runs dev, edits, exports, sees no change — *except* two fixed bugs: rename
a field referenced in another field's `required` expression → the reference
follows (silently broke before); move a field into a group when a hashtag
references it → the ref re-anchors as a nested hashtag and still renders
(dangled before).

### Stage 1 — Close the export hole (boundaries)

1. `prepareCompileRequest.ts`, the HQ-upload route, MCP `compile_app` +
   `upload_app_to_hq`: replace the media-only gate with `evaluateBoundary`
   (soundness + completeness + media); 422 / `invalid_input` envelope with
   humanized errors; docs + plugin notes flag the MCP contract change (plugin
   version bump on merge).
2. Export/upload UI affordances surface the error list (extend the existing
   media-error path).
3. Boundary oracle throws → Sentry-tagged infrastructure errors, generic
   user message.
4. `scripts/scan-app-validity.ts` (read-only, re-runnable): sizes legacy
   exposure per code — the early warning if a rule misfires on real data.
   Any repair migration is a separate user-invoked decision (dry-run default,
   `--apply`).

**Verification:** user runs dev, makes a soundness-breaking edit (still
possible pre-Stage-3), clicks export `.ccz` → actionable error naming the form
and rule instead of a download; reverts → export succeeds.

### Stage 2 — SA per-call soundness gate (chat + MCP, one change)

1. `guardedMutate` in `lib/agent/tools/common.ts`: compute `nextDoc`, run
   `evaluateCommit` (phase from app status), on introduction return the
   `{ error }` envelope (humanized, with the existing did-you-mean
   suggestions) and persist nothing. Wire through every mutating tool.
2. Construction defaults replacing fixes (D15), each fix deleted as its
   source lands.
3. Ratchet for destructive SA ops while `complete`: `removeField`/`removeForm`
   /`removeModule`/`editField`-clears reject with referent-naming errors;
   case-list columns/search-inputs whose `field` names the deleted field
   auto-cascade in the same batch (the cleanup `renameField` already performs
   for renames).
4. `validateApp` is not retired here only because its deletion rides the
   lifecycle rework (Stage 4) — no observation window, per D14.
5. Tests: per-tool rejection tests; property test — generator-driven tool-call
   sequences through `guardedMutate` assert every accepted intermediate doc is
   soundness-clean.

**Verification:** user builds an app via chat, then asks for an edit with a
deliberate error ("set the age field's display condition to `if(`") → the
transcript shows the SA hitting the rejection and correcting in the same turn;
the run log shows no fix chapter; the app exports cleanly.

### Stage 3 — Builder UI commit gating (at-source + server backstop)

1. Case-list / case-search workspaces: draft-until-valid commits using the
   existing `useValidityPropagator` verdicts; invalid drafts stay local with
   the existing error styling. The `property: ""` transient-commit affordance
   tightens out of the schema as the *last* step, after every commit path is
   gated.
2. `FieldHeader.tsx::validateRename` extends with XML-name validity +
   case-property length (same shake + notice chrome) — now backed by the
   shared Stage-0 verdict.
3. Field picker seeds two default options on select kinds.
4. Destructive delete guard: `useDeleteSelectedField` checks referents
   (XPath refs, columns, search inputs, preloads, form links — the existing
   reference scan until Stage 5 swaps in the index); confirm dialog lists
   them, auto-cascades columns/search-inputs in the same `applyMany` batch,
   blocks with click-to-navigate referents for XPath refs.
5. Server backstop: PUT runs `evaluateCommit`; 422 with codes; `useAutoSave`
   gets a distinct "rejected" state (vs network error) and fires
   `reportClientError` — a PUT rejection is by definition a client-gate bug.
6. Form-settings panels audit (close condition, form links, post-submit,
   connect): commit-on-valid everywhere; close gaps found.

**Verification:** user blanks a case-list column's property → red card,
"Saved" never errors, reload shows last valid config; renames a field to
`1bad id` → inline rejection; deletes a referenced field → dialog names the
referents, columns clean up in the same undo step.

### Stage 4 — Lifecycle + loop removal — SHIPPED

Entry criterion (D14): the mutation-sequence fuzz is green and guard
coverage for the four re-scoping mutation kinds is proven — both are tests
in this branch, not production observations.

Landed as specified, with these deltas vs the text below:
- The proof landed wider than the four named kinds: guard coverage is a
  `satisfies`-total table over EVERY mutation kind
  (`lib/doc/__tests__/rescopingGuardCoverage.test.ts`), and the sequence
  fuzz drives the real tools (`constructionFuzz.test.ts`), not bare
  `applyMutations` batches.
- `completeBuild`'s side-effect order is materialize → `completeApp`
  (both awaited, in the shared body — MCP gets them too) → `data-done`
  (chat wrapper). The status flip is awaited rather than
  fire-and-forget: a flip that can't persist is an infrastructure
  failure, surfaced via the preserved infra arm instead of parked on
  the staleness reaper.
- `createForm`/`createModule` widened in the SHARED schemas (both
  modes, not edit-only): `fields` required on createForm; `forms` +
  `case_list_columns` optional-but-gate-enforced on createModule; an
  all-skipped fields list refuses rather than landing an empty form.
- Draft apps additionally open in the browser builder under the
  `building` gate phase (page passes `commitPhaseForAppStatus` into
  `BuilderCommitPhaseBridge`).
- The plugin skill text/version bump is the nova-plugin repo's follow-up,
  not in this tree.

Round-3 review hardening (same stage, post-ship):
- The completion write is basis-guarded on both surfaces
  (`completeAppGuardedByBasis`): the token captured with the evaluated
  snapshot is compared in the write transaction and rotated on commit; a
  mismatch bounces as an ordinary run-again result. The rotated token
  rides `data-done` so the driving tab's auto-save basis stays current.
- `createForm`/`createModule` accept the per-form `connect` block (shared
  `connectFormConfigSchema`, extracted from the scaffold schema) so
  complete Connect apps can grow structure atomically.
- `completeBuild` is build-only on the chat surface (edit mode has
  nothing to complete) and its infrastructure arm never demotes a
  complete app; `get_agent_prompt` keys build-vs-edit on app status so
  resumed drafts get the completion guidance.
- A build-mode retry of an `error` app flips `error → generating`
  (awaited, fresh `updated_at`, before the concurrency check) so the
  reaper/refund/concurrency machinery covers retries.
- Exports gate on findings, not status — docs say so; a content-complete
  draft exports without `complete_build`.
- The fuzz routes inputs through the tools' own Zod schemas, covers a
  media kind, pins EMPTY_FORM under the ratchet, runs a Connect-app
  property, and its generators were probe-rebalanced so every op type
  lands real commits.

Round-4 review hardening (same stage, post-ship):
- Connect ids are enforced at the creation source: `createForm` /
  `createModule` run `enforceConnectIds` before the batch is built (one
  threaded id set per `createModule` call), matching `updateForm` /
  `generateScaffold`. `deriveConnectDefaults` is deleted (its last
  production caller went with the validation loop); the validator gains
  `CONNECT_ID_MISSING` (soundness) so an id-less block in a stored doc is
  a boundary finding, never the emit resolver's throw surfacing as a 500.
- The fuzz's "every op type lands real commits" is an ENFORCED floor, not
  a probe result: per-property commit tallies under pinned fast-check
  seeds, plus Connect-specific floors (connect-carrying and omitted-id
  creations commit) and `CONNECT_FORM_MISSING_BLOCK` /
  `CONNECT_ID_MISSING` pinned kept-out on the Connect property. The
  floor's first run exposed two starved ops, fixed structurally (fixture
  close forms; an `__own__` case-binding marker resolved per target
  module).
- The retry revival is a transaction flipping ONLY `error → generating`
  (`GenerationRetryConflictError` → route 429): same-app contenders share
  one row that `hasActiveGeneration` excludes as their own, so the
  compare-and-flip is the arbitration between them.
- A chat-side stale-basis completion bounce reloads the stored doc into
  the run's working state before advising the re-run (`staleBasis` on the
  shared result; MCP wire shape unchanged) — the retry evaluates a doc
  that includes the concurrent edit instead of committing the stale
  working doc over it.
- The run's intermediate saves chain, and `getCompletionBasis` drains the
  chain before its token read — a run's own in-flight save can no longer
  land after the guarded completion and clobber the completed snapshot.

1. Atomic edit-mode creation (D13): widened `createForm`/`createModule`
   schemas (verified via `scripts/test-schema.ts`); edit-mode per-call
   completeness goes zero-tolerance; build mode unchanged.
2. `completeBuild` shared tool replaces `validateApp`: one deterministic
   `evaluateBoundary` → on clean: materialize (current infra-error arm
   preserved verbatim) → `data-done` → `completeApp`; on completeness residue:
   return the list — no fixes, no loop, nothing to "fix", only work not yet
   done, which the SA finishes with its normal tools and calls again. Replaces
   the tool in `solutionsArchitect.ts`, `SHARED_TOOLS`
   (`validate_app` → `complete_build`), and the prompts (build step 5; edit
   preamble's "call validateApp when done" deleted). MCP-driven builds now
   run materialization (closing the chat-only asymmetry, deliberately).
3. MCP lifecycle (D12): `create_app` writes `status: "draft"`; reaper-exempt;
   list/search badges; edit-vs-build derivation treats draft as building;
   `complete_build` flips it. `get_agent_prompt` + plugin skill text updated;
   plugin version bump.
4. Delete: `validator/fixes.ts` + `FIX_REGISTRY`, the loop/stuck-signature
   machinery in `validationLoop.ts`, `validateApp.ts`, `validation-attempt`
   *emission* (type retained so historical runs still render), validate-
   specific tool-summary rendering for new runs. Chat-route edit turns log
   (warn) if a run ends incomplete — unreachable except via bugs; the log is
   the tripwire.

**Verification:** user builds end-to-end via chat → completion fires, app
exports; `/nova:autobuild` via MCP → app shows Draft mid-build, Complete
after; `/nova:edit` "delete the visit form" where it's the module's only
form → the agent relays the refusal naming the consequence;
`git grep validateAndFix FIX_REGISTRY` returns nothing.

### Stage 4.5 — The always-valid collapse — SHIPPED

Owner-confirmed end state (2026-06-10), superseding Stage 4's phase/draft
machinery. Evidence: a replay of all 313 prod apps' event streams through
the strict rule showed the only material cost was the empty-shell scaffold
pattern, which this stage deletes.

- ONE rule on every surface: `evaluateCommit` lost its phase — a commit may
  never INTRODUCE a shape/soundness/completeness finding, in any app state.
  Deleted: `CommitPhase`, `commitPhaseForAppStatus`,
  `ToolExecutionContext.commitPhase`, the chat route's + MCP adapter's
  phase plumbing, `commitPhaseContext.tsx` + `BuilderCommitPhaseBridge`.
  The introduced-error identity diff is the grandfather clause; birth
  findings (nameless, moduleless) only ever shrink. `evaluateBoundary`
  (zero-tolerance at export) unchanged.
- The draft lifecycle is gone: MCP `create_app` births `complete` (an
  empty app is at rest and valid; status never feeds gating), the `draft`
  status left the schema and every list/badge surface, and
  `complete_build` / the shared `completeBuild` tool / the chat wrapper —
  with the completion-basis machinery (`getCompletionBasis`,
  `completeAppGuardedByBasis`, the stale-basis bounce + reload) — are
  deleted. What survives untouched: the auto-save PUT's `blueprint_token`
  basis, the MCP transactional guarded commits, the save chaining, and
  `markAppGenerating`'s transactional retry flip (those guard concurrent
  WRITERS, not phases). `error` survives as pure run-liveness.
- Chat build finalization moved to the route's drain end: drain the save
  chain → `materializeCaseStoreSchemas` → `completeApp`
  (`generating → complete`, STATUS-ONLY so it can't blind-overwrite a
  concurrent editor's blueprint) → `data-done` (doc snapshot, no basis
  token — nothing rotates). Edit runs also materialize at drain end
  (log-only failure). On MCP, materialize rides every case-type-touching
  guarded commit via the cross-store saga — no completion event needed.
- Planning survives; the empty-shell COMMIT pattern dissolved.
  `generateSchema` is a PURE planning tool (same describe-rich schema,
  zero mutations); `planAppDesign` replaced `generateScaffold` carrying
  everything scaffold's input carried. Execution: `updateApp` (name +
  connect type — new shared tool, also the SA/MCP carrier for the
  app-level Connect flip) then one `createModule` per planned module.
- Case-type records commit WITH their module: `createModule` gained
  `case_type_record` (name must equal `case_type`; re-declaring an
  existing record rejects; the call's own field assembly sees the record
  for catalog defaulting), making the replay's batch-0
  `MISSING_CHILD_CASE_MODULE` bounce structurally unreachable.
  `updateModule` gained a `case_list_columns` seed (applied only when the
  module has none) so the case-type flip's obligations are satisfiable in
  the same call.
- Connect atomicity — the last bypass died: `switchConnectMode` runs the
  shared verdict and commits `setConnectType` + every form's block as ONE
  batch (stash restores + the blocks `ConnectEnableDialog` collects from
  the user up front; all incoming blocks dedup ids under one accumulating
  scope). Disable stays always-valid. The per-form Connect toggle's OFF
  direction renders explained-disabled on Connect apps.
- The proof is the strongest available invariant: the construction fuzz
  grows docs from BIRTH through the real tools (preludes included) and
  asserts ZERO findings once the first module lands — subsuming the
  registry-code pins; the phase-split properties and RATCHETED sets are
  gone. The deterministic per-op acceptance floors and Connect floors
  stay exactly as landed. `rescopingGuardCoverage` stays total over all
  mutation kinds.
- No mutation kind was deleted: historical event logs (`setCaseTypes`,
  empty-`addForm`, scaffold-era batches) replay forever; only the tool
  surface stopped emitting the retired shapes, and historical thread
  rendering keeps its labels (`toolSummary`).

**Verification:** full suite green; `npx tsx scripts/test-schema.ts`
passes for `generateSchema`, `planAppDesign`, `updateApp`, and the
extended `createModule`; user builds end-to-end via chat → the route's
drain-end finalize fires `data-done` and the app exports; `/nova:autobuild`
via MCP → app is usable the moment its last commit lands (no finishing
call); enabling Connect in App Settings on an app with forms opens the
staging dialog and commits one batch.

Round-5 review hardening (same stage, post-ship):
- EVERY chargeable build-mode POST claims the run window transactionally
  (`claimBuildRun` generalizes the error-retry compare-and-flip to
  `complete` and paused `generating`+`awaiting_input` rows; loser 429s) —
  a build run against an already-complete app now sits under the reaper's
  refund coverage and the concurrency arbitration like any other, and the
  pre-stream bail-outs restore exactly the shape the claim displaced (a
  rejected request can never strand a complete app at `error`).
- Retiring a case type's last owning module is satisfiable: the shared
  planner (`lib/doc/caseTypeRetirement.ts`) retires an orphaned,
  unreferenced record via an explicit `setCaseTypes` in the same gated
  batch, and rejects a still-referenced one listing every reference
  (parent_type declarations, `case_property_on` writers, `#type/…`
  hashtags via the Lezer grammar, predicate-AST leaves). Consumed by the
  SA/MCP `removeModule` + `updateModule` tools and the builder hook; the
  cascade is batch-layer mutations, never a reducer side effect, so
  historical replay is byte-stable.
- The unknown-tool-part strip runs on EVERY continuation (build included)
  so a build paused on `awaiting_input` across a deploy that retired
  tools resumes instead of failing `validateUIMessages` forever.
- `SchemaNotSyncedError` self-heals at the point of use: every
  case-data-binding action re-materializes from the persisted blueprint
  and retries once (`withSchemaHeal`); the edit-arm comments that claimed
  auto-save re-sync now state this real path.
- Builder Connect: the empty-app enable commits the bare type flip
  (the zero-module early-return died), and the per-form ON-toggle heal
  collects the block through the shared staging dialog instead of seeding
  fabricated content.
- The construction fuzz pool grew `removeModule` (cascade + NO_MODULES
  rejection) and the whole case-list-config family, each with acceptance
  floors; preludes grew standing targets (second column, search input,
  third registration writer, second module). Media tools stay out — an
  attach op writes an opaque asset id with no gate interplay to judge.
- Scan + migrate script pair for legacy `status: "draft"` rows
  (`--project`-pinned; migrate dry-run default, `--apply`). Dev-project
  scan found zero rows.

Round-6 review hardening (same stage, post-ship):
- The claim window's full charge contract: `claimBuildRun` SETTLES the
  displaced run's reservation marker in the claim transaction — for the
  `complete` arm's kept charge (round 7 narrowed the rule: a displaced
  PAUSED run's marker stays untouched, it is the live hold a failed
  resume refunds off; `error` is already settled; the stale arm settles
  via its own refund) — so a hard kill between the claim and the new
  run's `reserveCredits` can never refund a kept charge; a stale
  non-paused `generating` row is displaceable — the claim settles it
  exactly as `reapStaleGenerating` would (refund-first off the marker,
  `internal`) in the same transaction, ending the indefinite-429 dead
  end on a hard-killed app; the `error` arm of `ClaimedBuildRun`
  carries the displaced classification so a bail-out restore writes
  back why the build originally failed; and the free-continuation
  pause-flag clear runs only after every pre-stream bail-out gate.
  `claimWindow.test.ts` composes the real claim/reaper/credits
  functions over one in-memory store.
- The schema heal moved DOWN to the individual case-store write
  (`schemaHealingCaseStore`): each store operation heals-and-retries
  just itself, so a followup/close submission's partial progress is
  resumed, not re-run — the dispatch-level wrapper duplicated child
  rows on the partial-sync shape the heal exists for.
- `collectModuleConfigReferences` iterates `MODULE_REFERENCE_SLOTS`
  with an exhaustive switch (the field/form scans' pattern) — a future
  module slot fails the retirement planner at compile time.
- The construction fuzz tallies the retirement arms and asserts each
  occurred under the pinned seed (≥1 retire-cascade commit, ≥1 blocked
  bounce, ≥1 NO_MODULES bounce) — the header previously claimed
  coverage the acceptance floor couldn't hold.
- Sub-toggle doctrine: the LearnConfig/DeliverConfig sub-toggles stage
  their block and collect names/descriptions from the user before
  anything commits (the enable dialog's pattern at sub-config scale);
  `assessment.user_score` joined the wire-default family
  (`DEFAULT_ASSESSMENT_USER_SCORE`, byte-identical to the previously
  seeded "100"), making the assessment toggle commit-immediate with
  its derived identifier alone.

Round-7 closing review (same stage, post-ship):
- The paused arm of `claimBuildRun` no longer settles the displaced
  marker — it is a LIVE hold the restored run's failed resume refunds
  off (the route's post-flush `refundReservation`); the unit suite pins
  the untouched marker and the composed suite drives claim → restore →
  failed-resume refund in full.
- `claimWindow.test.ts`'s fake enforces the server SDK's
  read-before-write transaction rule (a get after any write throws) and
  grew a composed stale-displacement arm, so the deferred-refund
  ordering is held by the harness, not just by review.
- The stale-displacement docblock records the inference ("treated as
  dead", the reaper's ten-minute premise) and the accepted consequence
  when it is wrong: a second SA loop on the same app, the old run's
  funnel touching the new run's marker.

### Stage 5 — The reference index

Layer 2 as specified. Implementation order inside the stage: index module +
generic maintenance hook + `buildReferenceIndex` + hydration sites +
`toPersistableDoc` strip → dev assertion + CI fuzz green → swap consumers:
rename cascade (peers via `refs.decl`, carriers via `refs.in`; the client-side
duplicate peer scan deletes), move re-anchoring, delete-impact verdicts,
cycle DFS, find-references/lint/autocomplete/chips as index projections.
TriggerDag keeps its per-form runtime build but sources extraction from the
shared registry extractors.

**Verification:** the NODE_ENV-gated builder overlay shows index stats and the
live incremental≡rebuild parity check staying green during editing; renaming a
heavily-referenced case property in a large app is visibly immediate; the
delete dialog's referent list is exact on a large fixture; CI fuzz green.

### Stage 6 — Representation migration, per surface

`calculate` → `relevant` → `validate`/`default_value`/`required` →
`repeat_count`/`ids_query` → connect slots. Per surface: persist the typed AST
(round-trip-gated conversion); `expressionSource` + emit project strings; the
index extractor flips string-parse → leaf-walk; the surface's string rewriter
leaves the commit path; one-time migration of stored docs AND event-log
payloads via scan + migrate scripts (read-only scan; migrate dry-run default,
`--apply` — user-invoked; scripts deleted after the run per resolved
decision 3).

**Verification (per surface):** rename a field referenced by a migrated
surface — the stored payload contains no string form (representation-invariant
test), projected text is correct on every read edge, and no Lezer parse
executes during the rename (reducer-path assertion). Wire regression: per-entry
bytes of the `.ccz` (deterministic id factory; zip container headers ignored)
identical pre/post migration across the corpus.

### Stage 7 — Residue

Index-backed ingest gate for out-of-band docs (schema parse + index build +
reference-class verdicts on load, failures routed through the same resolution
contract); rerun the validity scan on prod data (read-only; report); docs/
drift sweep; the stale `validateAndFix` re-export comment in
`lib/agent/index.ts` dies; oracle CI coverage confirmed unchanged.

**Verification:** docs at `docs.commcare.app` describe the new tool surface
and lifecycle; `npm run test:leaks` green before final push.

## Testing strategy

- State-model tests for every verdict function and guard (no UI mounting).
- Classification totality (compile-time) + identity stability + scoped ≡
  full-filtered property tests (Stage 0).
- Tool-call-sequence property test: accepted intermediates are
  soundness-clean (Stage 2).
- Index oracle: `buildReferenceIndex` ≡ incremental, dev assertion + CI fuzz
  with multi-mutation intra-batch-dependency alphabets (Stage 5).
- Round-trip law fuzz: `print(parse(s)) === s` (Stage 6).
- Wire entry-byte regression per migrated surface under a deterministic id
  factory (Stage 6).
- Perf guards on large fixtures (gate latency, index maintenance, history
  memory under zundo's 100-snapshot window).
- Existing wire-oracle fuzzers unchanged.

## Risks

- **Gate misfire on real data** → introduced-error semantics bound the blast
  radius to new edits; the Stage-1 scan sizes legacy exposure before any
  commit path tightens; PUT rejections are Sentry-loud.
- **SA call-failure churn** (per-call rejection vs batched fixes) → message
  quality is already SA-tuned; rejection-message tests drive the same repro
  scenarios the fix loop used to repair, asserting the SA-visible error
  names the correction.
- **Index drift** (the cache-invalidation bug class, now load-bearing for doc
  bytes) → D9's oracle discipline; carrier-keyed edges remove span trust;
  the generic re-extraction hook removes per-reducer bookkeeping drift.
- **Registry drift** (the highest-probability failure mode — it is the live
  bug class today) → one registry, four consumers, typed totality, audited
  against the domain schemas in Stage 0.
- **zundo memory amplification** → in-place Immer updates on carrier-keyed
  JSON records preserve structural sharing; measured on a large fixture
  before Stage 5 locks.
- **Mega-input creation tools** raising malformed-call rates →
  `scripts/test-schema.ts` proves acceptance; rejections name the exact bad
  item.
- **Two-writer races** (UI auto-save vs SA edit run) — unchanged by this
  program; both paths gate against their own `prevDoc`; existing
  last-write-wins is orthogonal and explicitly out of scope.

## What is deleted when the program lands

`validator/fixes.ts` (the 13-fix registry), the loop body of
`validationLoop.ts::validateAndFix` (stuck signatures, `fix:attempt-N`),
`lib/agent/tools/validateApp.ts`, the `validate_app` MCP registration, the
validate-loop prompt instructions, validate-time connect defaulting, the
media-only export gating (subsumed), the client-side duplicate peer scan, the
single-segment-only rewriter restrictions, and — per migrated surface — the
XPath string rewriters from the commit path. The validator rules, the oracles,
the fuzzers, and the humanized error vocabulary all remain: they become the
gate's engine instead of the loop's.

## Non-goals

- Replicating CCHQ's validation UX or save/version gauntlet (locked: Nova
  apps are always export-ready; reject at construction).
- Persisting the index.
- Global acyclicity (D11).
- Preview-mode or runtime/case-store model changes (locked elsewhere).
- New CommCare authoring features.
