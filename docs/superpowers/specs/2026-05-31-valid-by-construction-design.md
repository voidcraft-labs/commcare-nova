# Valid by Construction — Design

## Overview

Today blueprint validity is enforced **after the fact, on one surface only**: the
Solutions Architect runs `validateApp` (a validate-then-fix loop) at the end of a
generation/edit turn. The builder UI runs no validation at all, and neither export
path (`.ccz` compile, HQ upload) validates before emitting. So `validateApp` is the
*only* validity net in the entire system — and the net we want to remove.

This spec commits to the opposite model: **every committed mutation leaves the doc
valid by construction**, identically for the SA and the builder UI, so invalid states
are unrepresentable rather than detected-and-repaired. It defines precisely what
"valid" means (the illegal/incomplete split, the transaction as the unit), maps the
current gap against the actual code, lays out the target architecture, and sequences
the migration into independently shippable PRs.

The validate-then-fix model is inherited from the pre-Nova "Forge" era (chat-only,
JSON-from-markdown, a Haiku fix-loop). It is the last structural leftover of that
mental model now that typed tools + fine-grained mutations + DOM-construction wire
emitters have replaced everything else. The "every mutation is valid" invariant was
imposed *after* that migration, as a UI requirement; this spec extends the same
invariant to the agent, on the principle that **if a user cannot reach an invalid
state through the interface, neither should the agent.**

## Goals

- Make **illegal** blueprint states unrepresentable at the mutation boundary, through
  one shared enforcement layer that both the SA and the builder UI inherit.
- Reframe **completeness** as a boundary check (export / "done"), not a per-mutation
  gate — so incremental building (scaffold a module, *then* populate it) stays
  possible without tripping "invalid" on every half-built step.
- Give every edit that can orphan a reference **one shared repair path** — rewrite on
  rename/move, and a single deliberate resolution on delete (a dialog for the UI, a
  structured choice for the SA).
- Collapse `validateApp` from a fix-loop into a thin completeness/exportability check,
  and demote deep reference/cycle validation to a **test-time oracle** once
  construction guarantees the refs can't dangle.
- Make the "always exportable, no CCHQ error gauntlet" product invariant **real**
  instead of aspirational.

## Non-goals

- The infra-error signal fix — shipped separately (PR #49). Independent: case-store
  schema materialization is a real side effect under any architecture, and labeling
  its failures infra-not-app stands regardless of `validateApp`'s fate.
- Any change to the runtime / case-store model (no preview mode, no in-memory store —
  those decisions are locked elsewhere).
- New CommCare authoring features. This is purely about *where and how* validity is
  enforced.

## Design properties — the quality bar

- **One enforcement layer, two surfaces.** Both the UI (`lib/doc/store.ts::applyMany`)
  and the SA (`lib/agent/tools/common.ts::applyToDoc`) apply through the single
  `lib/doc/mutations/index.ts::applyMutations` reducer. A guard added once to
  `applyFieldMutation` / `applyFormMutation` / `applyModuleMutation` protects both —
  this is the structural leverage the whole design rests on.
- **The transaction is the unit of validity** — a tool call or a UI commit — not the
  individual micro-mutation. Intra-transaction intermediate states may be transiently
  dangling; validity holds at the commit boundary. This is what lets co-referential
  shapes be expressed without an "asinine" 100-atomic-actions sequence.
- **Illegal ≠ incomplete.** A malformed id or a dangling XPath ref is illegal (never
  allowed). A case module with no columns yet is incomplete (a normal work-in-progress
  state). They get different mechanisms and must not be conflated.
- **Elm-style everywhere.** Rejections explain what was tried, what's expected, and
  what to look at. For the SA, an orphaning edit returns a *structured choice*, not
  prose to parse.
- **No silent reference drops.** The current cross-depth-move hashtag drop (counted in
  `MoveFieldResult.droppedCrossDepthRefs` but surfaced to no one) is a bug this design
  fixes, not a pattern it preserves.

## Current state — the gap

Both surfaces apply through the same reducer, but the reducer enforces only a subset
of validity. Mapping every `runValidation` check to where it could/should live:

| What | Enforced at construction today? | Category |
|---|---|---|
| Field-kind schema validity on patch (`applyFieldMutation`, via `fieldSchema.safeParse` + `pickFieldKeysForKind`) | ✅ yes | LOCAL |
| Sibling-id uniqueness on cross-level move + rename (`helpers.ts::dedupeSiblingId`) | ✅ yes | LOCAL |
| Form-local XPath rewrite on rename/move (`pathRewrite.ts::rewriteXPathOnMove`, `preview/xpath/rewrite.ts::rewriteXPathRefs`) | ✅ partial | EMERGENT |
| Cross-form `#case/` + case-list column rewrite on case-property rename (`fields.ts::cascadeCasePropertyRename`) | ✅ partial | EMERGENT |
| Parent existence on add/move; cascade delete | ✅ yes | LOCAL |
| Empty app name, duplicate module names, case-type format/length, invalid field id, reserved `__nova_` prefix, select-with-no-options, hidden-with-no-value, unquoted string literal, case-property format/length | ❌ validator-only | LOCAL |
| XPath expression **content** validity — syntax, unknown-function, wrong-arity (`validator/xpathValidator.ts::validateXPath` → codes `XPATH_SYNTAX` / `UNKNOWN_FUNCTION` / `WRONG_ARITY`), parsed against the Lezer grammar + the fixed `functionRegistry`. A property of the expression *text* alone — no other entity involved. | ❌ validator-only | **LOCAL** |
| Dangling XPath refs after **delete** — `INVALID_REF` / `INVALID_CASE_REF` (no rewrite, no block) | ❌ validator-only | EMERGENT |
| Search-input predicate refs on rename/move/delete (never rescanned) | ❌ validator-only | EMERGENT |
| Cross-depth move dropping hashtag refs (silently) | ❌ silent data loss | EMERGENT |
| Dependency cycles among calculated fields (`TriggerDag`) | ❌ validator-only | EMERGENT |
| Duplicate case-property mappings across forms; field-kind ↔ property-type compatibility | ❌ validator-only | EMERGENT |
| Case module with a case type but no columns / no forms; registration form with no case-name field; incomplete Connect block; empty form | ❌ validator-only | COMPLETENESS |

Two facts make the gap urgent:

- **The builder UI runs no validation** — no panel, no badges, no `runValidation` call
  anywhere under `components/builder/`. A user can delete a field three other fields
  reference and nothing stops or warns them.
- **Neither export path validates** — `app/api/compile/route.ts` and
  `app/api/commcare/upload/route.ts` call `expandDoc` and emit, with no `runValidation`
  gate. A broken app uploads and breaks at CCHQ.

So `validateApp` (SA-only) is currently the sole place *any* emergent or completeness
invariant is caught. **Removing it without first building construction guards would
leave zero enforcement** — both surfaces could ship broken apps and export would emit
them. The work is to *move* its checks, not delete them.

## Architecture

### Axis 1 — Local invariants → shared mutation-reducer guards

Push the single-entity rules (the LOCAL rows above that are validator-only) into the
shared reducers in `lib/doc/mutations/*`. Each becomes a reject-or-auto-correct at
apply time: a mutation that would produce a malformed entity either is corrected
(e.g. id-shape normalization, the existing auto-suffix pattern) or is refused with an
Elm-style reason the caller surfaces. Because the SA and UI share `applyMutations`,
every guard lands on both surfaces at once. Most of these are cheap and many are
already half-covered by `fieldSchema` parsing.

**XPath expression *content* validity belongs here too — this is the subtle one.**
Syntax / unknown-function / wrong-arity are properties of the expression *text* alone
(the Lezer parse + the fixed `functionRegistry`), so they are LOCAL: a mutation that
sets `calculate`/`relevant`/`validate`/`required`/repeat-XPath to malformed text is
rejected at commit, exactly as `fieldSchema.safeParse` rejects a malformed field
shape. This must be a **runtime commit guard**, not deferred to the Phase-4 oracle —
the oracle only ever runs on fuzzer-generated docs and never sees the user's or the
SA's actual hand-entered expression, so demoting syntax validation would let `foo(bar`
commit with no gate, slip past the completeness export check (it's not incomplete),
and break at CCHQ. Layering caveat: the XPath parser lives behind the `lib/commcare`
boundary (`@/lib/commcare` barrel: `parser`, `functionRegistry`,
`detectUnquotedStringLiteral`), which `lib/doc/mutations/*` does not currently import.
So the guard either sits at the **mutation-construction boundary** (the SA tool /
UI-commit layer that accepts the raw expression string, both already allowed to use
the XPath engine) via a shared `validateExpressionContent` helper, or `lib/doc` gains
an allowlisted dependency on the parser. Picking the seam is a Phase-1 design task —
but the *requirement* (reject malformed expression text at commit) is fixed.

### Axis 2 — Completeness → export / "done" boundary

Completeness rules (case module needs a column, registration form needs a case-name
field, Connect block must be whole, form needs ≥1 field) are **not** per-mutation
gates — enforcing them per mutation makes incremental building impossible (a freshly
scaffolded module is legitimately column-less for a moment). Instead:

- Extract the completeness subset of `runValidation` into a single
  `checkExportReadiness(doc)` function.
- Gate `app/api/compile/route.ts` and `app/api/commcare/upload/route.ts` on it —
  reject an incomplete app with Elm-style errors before emit. **This is where "always
  exportable" actually becomes true.**
- The SA's end-of-turn check and a passive UI "ready to export / what's left"
  affordance both read the *same* function. An app may sit incomplete while building;
  it simply cannot be *exported* incomplete.

### Axis 3 — Emergent cross-reference integrity → one shared reference layer

This is the genuinely missing machinery and the hard core. Build it once:

- **`findReferences(doc, target)`** — given a field (by id/path) or a case property,
  return every site that references it: XPath expression fields (`calculate`,
  `relevant`, `validate`, `required`, `default_value`, repeat count / ids-query),
  case-list columns, and search-input predicates. This generalizes and unifies the
  three partial rewriters that exist today (`rewriteXPathOnMove`, `rewriteXPathRefs`,
  `cascadeCasePropertyRename`) into one authority.
- **Rename / move** route through it to **auto-rewrite** every reference — extending
  the current partial coverage to search-input predicates and **fixing the silent
  cross-depth hashtag drop** (it becomes either a rewrite or an explicit surfaced
  consequence, never a silent loss).
- **Delete** routes through a **repair strategy**: the mutation refuses to commit a
  state with orphaned references and instead requires a resolution.
- **Cycle-creating edits are rejected at mutation time** — run the per-form
  `TriggerDag` cycle check on just the touched form synchronously inside the mutation;
  an edit that would close a calculated-field loop is refused. This is the one
  "validation-shaped" check that stays, but as a construction guard (reject the bad
  edit), not an after-the-fact pass.

#### The SA analog of the UI dialog

The UI resolves a delete that orphans references with a **dialog** ("17 fields
reference this — clear those references, reassign them, or cancel"). The SA can't get
a dialog, so the orphaning tool returns a **structured choice** instead of failing
opaquely:

```
{ status: "needs-resolution",
  orphans: [{ site, kind, expression }... ],
  strategies: ["cascade-clear", "rename-instead", "abort"] }
```

The SA re-issues the mutation with an explicit `strategy`. Same `findReferences`
engine, same set of resolutions — one rendered as UI, one as a tool-result contract.
This is the deterministic, in-band answer to "the dialog case is harder to model to
the SA."

### `validateApp` collapses

Once Axis 1 + Axis 3 guarantee no *illegal* state can be committed, and Axis 2 owns
*completeness* at the boundary, `validateApp`'s fix loop has nothing left to fix:

- It becomes (or is replaced by) `checkExportReadiness(doc)` — the same completeness
  function the export gate calls. No fix loop, no retries. The SA stops "validate and
  fix" and simply builds valid-by-construction, then confirms readiness.
- The deep validator **splits**, it does not wholesale-demote. `validateXPath`'s
  *content* checks (syntax / unknown-function / wrong-arity) stay as the Axis 1 commit
  guard above — the oracle never sees real hand-entered expressions, so these can
  never leave the runtime path. Only the *reference-resolution* checks
  (`INVALID_REF` / `INVALID_CASE_REF`) and the `TriggerDag` cycle check demote to a
  **test-time oracle**, joining the existing wire oracles (XForm / suite / HQ-JSON):
  those are the checks Axis 3 *guarantees by construction* (refs can't dangle, cycles
  can't commit), so the oracle's job is to prove that guarantee holds against fuzzed
  mutation sequences, not to gate users. A failing oracle becomes a guard bug, not a
  fixable authoring state — exactly the pattern those oracles already follow.
  (`TYPE_ERROR` straddles: the expression-text slice rides the Axis 1 content guard;
  the cross-property-type slice is emergent and demotes with the reference checks.)

## Authoring surfaces

- **Builder UI:** a reference-resolution dialog on delete (cascade-clear / reassign /
  cancel) reading `findReferences`; a passive "ready to export" / "what's left"
  affordance reading `checkExportReadiness`. No live full-validation panel — the point
  is that illegal states never exist, so there's nothing to surface continuously.
- **SA:** orphaning tools return the structured-choice contract; the end-of-turn
  `validateApp` is replaced by the readiness check. The Error Recovery prompt section
  already distinguishes infra errors (PR #49); it gains no new "fix the validation
  errors" loop because there are none.

## Migration / sequencing (each phase is one shippable PR)

1. **Reference-integrity layer.** Build `findReferences`; wire RENAME / MOVE / DELETE
   through it on the shared reducer (auto-rewrite for rename/move incl. search inputs;
   structured-choice/dialog for delete); add per-form cycle rejection; fix the silent
   cross-depth hashtag drop. Closes the single biggest correctness gap for **both**
   surfaces at once. Fuzz-proven before anything downstream relies on it.
2. **Completeness at the boundary.** Extract `checkExportReadiness`; gate
   `/api/compile` + `/api/commcare/upload`; add the SA end-of-turn check + the UI
   affordance.
3. **Local guards.** Migrate the remaining LOCAL validator rules into the mutation
   reducers (reject-or-correct), **including XPath expression content validation**
   (syntax / unknown-function / wrong-arity) at the mutation-construction boundary —
   the seam decision from Axis 1 is settled here. This phase also resolves the
   rejection-reporting channel (see Open decisions).
4. **Collapse `validateApp`.** Replace the fix loop with the readiness check; demote
   **only the reference-resolution (`INVALID_REF`/`INVALID_CASE_REF`) + cycle checks**
   to a test-time oracle in the fuzz harness (XPath content validation stays a runtime
   commit guard from Phase 3); remove the fix-registry paths that are now unreachable.

Order matters: Phase 4's demotion is safe only *after* Phase 1's layer is fuzz-proven,
because demotion removes `validateApp` as the dangling-ref backstop.

## Open decisions (user-owned)

- **Completeness handling.** Recommendation: pure boundary-gate (Axis 2). The
  alternative — auto-seeding cheap defaults (e.g. a `case_name` column on case-module
  creation) — conflicts with the locked "case list columns are fully LLM-controlled,
  no auto-prepend" decision, so revisit it only if real SA/UX friction shows up.
- **Delete default.** Recommendation: block-with-structured-choice (the SA must pick a
  strategy; the UI must dismiss a dialog) rather than silent auto-cascade-clear —
  deleting a field that 17 others depend on should be a deliberate act, not a quiet
  data change.
- **`validateApp` end state.** Recommendation: fully replace with `checkExportReadiness`
  rather than keeping a parallel runtime check in addition to the export gate — one
  function, called at the two places readiness matters (SA done, export).

## Known design tasks (settled in the Phase plans, not here)

- **Rejection-reporting channel.** Axis 1 guards that *reject* (rather than
  auto-correct) need a way to report the reason back. Today the reducers mostly
  **silently skip** an invalid mutation (the stale-patch case in `applyFieldMutation`
  logs a console warning and returns). A hard reject must instead propagate — to the
  SA as a structured-choice / error result, to the UI as a dialog or inline error —
  through `applyMany`'s existing `MutationResult[]` channel (`lib/doc/store.ts`,
  `lib/doc/types.ts`). The channel exists; wiring rejection reasons through it (and
  deciding reject-vs-silently-correct per guard) is a Phase-1/Phase-3 design task, not
  a silent assumption. Naming it here so it doesn't get lost.

## Testing strategy

- **State-model tests** for `findReferences` and each new mutation guard (per the
  no-RTL rule — test the reducer + the reference engine directly, mount nothing).
- **Fuzz the construction guarantee.** Extend the existing `blueprintDocArbitrary`
  fuzzers: generate random *mutation sequences*, apply them through `applyMutations`,
  and assert the committed doc never trips a (now-demoted) reference/cycle oracle. A
  failure is a guard gap, not a fixable state.
- The demoted deep-XPath/cycle oracle runs inside that fuzz harness as the totality
  proof, mirroring the XForm/suite/HQ-JSON oracle pattern.

## Risks and mitigations

- **The reference layer must be exhaustive.** A missed reference surface = a silent
  dangling ref with no `validateApp` backstop (since it's demoted in Phase 4).
  Mitigation: the fuzz + oracle proof is the gate on Phase 4; the layer ships and bakes
  in Phase 1 before demotion.
- **Per-mutation cost.** `findReferences` + cycle check run on edits. Mitigation: both
  are per-form / per-target, not whole-doc; measure on a large fixture before locking.
- **A confusing export rejection.** "You can't export — incomplete" could surprise a
  user who thinks they're done. Mitigation: Elm-style messages naming exactly what's
  missing, plus the passive UI affordance so incompleteness is visible *before* export.

## Scope shape (not effort)

Four PRs. Phase 1 (the reference-integrity layer) is the foundation and the bulk of
the genuinely new code; Phases 2–4 are extraction, relocation, and removal on top of
mechanisms that already exist.
