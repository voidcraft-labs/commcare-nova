# Phase 7: Complete the Builder-Foundation Re-architecture

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Fresh implementer subagent per task, two-stage review after each (spec-compliance → code-quality). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every unmet success criterion from `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`. This is the last phase. Prior phases explicitly deferred the compile-pipeline rewrite, the wire-format shim deletion, and the vocabulary elimination to "Phase 7". That work lands here, fully — no adapters, no migration scripts preserved, no weak tests left in place, no phase-history clutter in documentation.

**Architecture:** `lib/commcare/` becomes a self-contained one-way emission boundary. It reads `BlueprintDoc` directly and writes CommCare HQ wire formats (XForm XML, `HqApplication` JSON, `.ccz` archives). There is no intermediate nested-tree wire shape inside the codebase — `AppBlueprint`, `toBlueprint`, `BlueprintForm`, and the legacy `Question` type cease to exist. The compile pipeline walks `doc.moduleOrder` / `doc.formOrder[m]` / `doc.fieldOrder[f]` natively. Every other `lib/` subpackage is a focused, single-responsibility module with accurate documentation.

**Tech Stack:** Next.js 16 · TypeScript strict · Vitest · Biome (warnings fail pre-commit) · `htmlparser2` + `dom-serializer` for XForm XML · Lezer XPath grammar · AdmZip for CCZ archives · Zustand + Immer + zundo for the doc store.

**Worktree:** `.worktrees/phase-7-final` on branch `refactor/phase-7-final`.

---

## Spec mapping

| # | Success criterion | Task(s) |
|---|---|---|
| 1 | Field type safety (already met in Phase 1) | verified in T27 |
| 2 | No inline selectors outside store-owning dirs (already met in Phase 6) | verified in T27 |
| 3 | `Question` / `question` / `case_property_on` nowhere outside `lib/commcare/` | T4, T5, T6, T7, T8, T10, T14, T15 |
| 4 | `AppBlueprint`, `toDoc`, `toBlueprint`, `normalizedState`, `replaceForm`, `notify*` don't exist | T6, T7, T8, T11, T12, T13 |
| 5 | `lib/services/` no longer exists | T4, T5, T6, T7, T8, T10, T16, T17, T18 |
| 6 | Top-level `/hooks/` (already met in Phase 6) | verified in T27 |
| 7 | `lib/log/replay.ts` ≤ 50 lines (already met in Phase 4) | verified in T27 |
| 8 | Component splits (already met in Phase 5) | verified in T27 |
| 9 | `npm run lint`, `npm run build`, `npx tsc --noEmit`, `npm test` clean | T27 |
| 10 | SA → doc → compile output matches today's CommCare output | T22 (test-strengthening covers this via behavior assertions, not snapshots) |
| 11 | Production app loads + compiles after migration | pre-deploy smoke test (out of scope — migration scripts are retired; criterion is historical) |
| 12 | Adding a new field kind is one file | T27 (declarative-registry drill) |

Every criterion the spec sets is either delivered by this plan or was delivered upstream and verified in T27.

---

## Architectural north star

Every implementer subagent reads this section before their task and writes against this bar:

1. **One shape per concept.** `Field` is the only field shape. `BlueprintDoc` is the only blueprint shape in memory and on disk. `HqApplication` is the only CommCare-HQ wire shape. There is no third-shape compat layer in production code.

2. **The CommCare boundary is one-way.** `lib/commcare/` imports freely from `lib/domain/`. Nothing outside `lib/commcare/` imports its internals except a tight allowlist: `app/api/compile/*`, `app/api/commcare/*`, `lib/agent/validationLoop`, `lib/codemirror/*` (for xpath + lint), `lib/preview/engine/*` (for xpath transpiler). Enforced by Biome.

3. **No migration scripts, no wire-format converters.** The migration has already run; `git` preserves the scripts for reference. Test fixtures are constructed as `BlueprintDoc` via the existing DSL at `lib/__tests__/docHelpers.ts` (`buildDoc` + `f`), never promoted from `AppBlueprint` shapes.

4. **Tests specify behavior, not implementation.** A test that runs a fixture through a pipeline and matches a serialized snapshot is not a behavior test — it's a freeze. Replace with specific invariants: "given a field with X, the output has Y". If you don't know what invariant a test proves, delete it or rewrite it.

5. **Documentation is current-state.** `CLAUDE.md` files describe the codebase AS IT IS, not how it got there. File headers describe WHAT the file does, not WHICH PHASE moved it here. No "Phase N did X" text survives in committed files after this phase.

6. **No defensive overengineering.** No null-checks against states that can't happen, no early-exit guards for impossible inputs, no `try/catch` around code that can't throw. "Maximally correct" does not mean "maximally defended" — it means the simplest expression of the domain with the invariants it actually has.

7. **Out-of-scope work that blocks the north star is in scope.** If the compile-pipeline rewrite uncovers a bad abstraction in `lib/doc/`, fix it. If the validator's existing tests were weak and you found a real bug while rewriting, add the missing case. "That's for another phase" is not a valid escape hatch — there is no other phase.

---

## Post-Phase-7 structure

After this phase ships, `lib/` looks like:

```
lib/
  admin/            # Admin dashboard types (moved from lib/types/admin.ts)
  agent/            # Solutions Architect + tool loop + mutation mapper + prompts
  auth/             # Better Auth wrappers + hooks
  chat/             # Thread persistence utilities
  codemirror/       # CodeMirror editor extensions (autocomplete, lint, format, chips, theme)
  commcare/         # ← THE CommCare wire boundary
    compiler.ts     #   HqApplication + BlueprintDoc → .ccz Buffer
    expander.ts     #   BlueprintDoc → HqApplication
    formActions.ts  #   FormActions + case_references_data from doc
    deriveCaseConfig.ts
    session.ts      #   post_submit + form_links emission
    hashtags.ts xml.ts constants.ts ids.ts hqShells.ts identifierValidation.ts
    types.ts        #   HqApplication, HqForm, HqModule — HQ's wire types
    client.ts encryption.ts   # HQ REST client + KMS encryption for stored creds
    xform/
      builder.ts    #   (doc, formUuid, opts) → XForm XML
    validator/
      index.ts runner.ts
      rules/{app,module,form,field}.ts
      xformValidator.ts xpathValidator.ts typeChecker.ts
      functionRegistry.ts errors.ts fixes.ts
    xpath/
      grammar.lezer.grammar parser.ts parser.terms.ts
      transpiler.ts typeInfer.ts passes/dateArithmetic.ts
  db/               # Firestore wrappers
  doc/              # Normalized blueprint store, provider, hooks, mutations
    fieldPath.ts    #   (moved from lib/services)
    resetBuilder.ts #   (moved from lib/services)
    connectConfig.ts#   (moved from lib/services)
    …existing files (store, provider, hooks/, mutations/, fieldParent, fieldWalk, etc.)
  domain/           # Field discriminated union + registry + editor schemas
  generation/       # Client-side SSE stream dispatcher
  log/              # Event log writer/reader/replay
  preview/          # Form preview engine (XPath evaluator, form engine, preview UI)
    hooks/
      useFormEngine.ts        # (activation)
      useEngineController.ts  # (controller getter)
      useEngineState.ts       # (per-field state selector)
  references/       # Hashtag reference parsing/rendering
  routing/          # URL + navigation hooks (History API)
  session/          # Ephemeral UI state + builder phase + replay
    builderTypes.ts #   (moved from lib/services/builder.ts — SelectedElement, EditScope, BuilderPhase)
  signalGrid/       # Signal-grid controller
  tiptap/           # Tiptap extensions
  ui/               # Shared UI primitives + shared stores
    toastStore.ts       # (moved from lib/services)
    keyboardManager.ts  # (moved from lib/services)
    hooks/
  …leaf modules: models.ts, platform.ts, logger.ts, styles.ts, markdown.tsx, etc.
```

Gone at root: `lib/services/`, `lib/schemas/`, `lib/types/`, `lib/transpiler/`.
Gone from `lib/codemirror/`: `xpath-parser.ts`, `xpath-parser.terms.ts`, `xpath.grammar` (moved to `lib/commcare/xpath/`); editor extensions (`xpath-autocomplete`, `xpath-format`, `xpath-lint`, `xpath-theme`, `xpath-chips`, `xpath-language`, `buildLintContext`) stay.
Gone from `lib/doc/`: `legacyBridge.ts`, `legacyTypes.ts`.
Gone from `scripts/`: `migrate-to-normalized-doc.ts`, `migrate-agent-tool-vocab.ts`, `migrate-users.ts`, and their tests + fixtures.

---

## Test strategy

Tests specify behavior. Three patterns are acceptable in this codebase:

1. **Unit tests** that assert specific outputs for specific inputs. "Given a `text` field with `required: 'true()'`, the generated bind element has `required="true()"`." These survive and expand.
2. **Integration tests** that exercise a pipeline end-to-end and assert specific observable properties. "Given a two-module doc with a repeat, the CCZ contains `modules/m1/forms/f0.xml` and the XML has one `<repeat>` element." These survive.
3. **Regression tests** for bugs that were hard to catch. "Field rename cascades across XPath references." These survive.

These patterns are not acceptable and get deleted or rewritten:

- **Snapshot tests** on serialized pipeline output (`toMatchSnapshot()` on large HqApplication JSON / full `.ccz` entry lists). They freeze the current implementation as the spec instead of asserting behavior.
- **Fixture-round-trip tests** that assert "same in, same out" without naming what invariant holds.

Each test file under `lib/commcare/__tests__/` is audited in T22 against these rules.

---

## Standing directives for implementer subagents

- **No `git restore` / `git checkout` / `git reset --hard` / `git clean -f` / `git branch -D` without explicit approval.** If code seems wrong, read it, understand why it's there, then fix at the root.
- **No fallbacks, no feature flags, no "stays as a safety net" code.** Delete the thing, or rewrite it fully.
- **When an out-of-scope problem blocks the north star, escalate to the controller (the leader running subagent-driven-development), not to a suppression comment.** The controller has standing authority to widen scope.
- **If a code-reviewer subagent says "this is fine", and a spec-compliance reviewer said the same, but you know the code is still below the north star bar** — say so. Re-review. The bar isn't "both reviewers approved"; it's "10/10 maximally correct".
- **No emojis.**

---

## Task index

Setup:
- **T1** — Worktree + baseline verification

Structural moves (code relocation, no semantics change):
- **T2** — XPath grammar + parser → `lib/commcare/xpath/`
- **T3** — XPath transpiler → `lib/commcare/xpath/`
- **T4** — `lib/services/commcare/*` (non-validator) → `lib/commcare/`
- **T5** — Validator → `lib/commcare/validator/`

Compile pipeline rewrite (semantics change: AppBlueprint → BlueprintDoc):
- **T6** — Confirm `buildDoc`/`f` at `lib/__tests__/docHelpers.ts` is the fixture DSL; delete the stray `makeDoc` artifact
- **T7** — Expander rewrite → `lib/commcare/expander.ts`; tests rewritten
- **T8** — XForm builder rewrite → `lib/commcare/xform/builder.ts`; tests rewritten
- **T9** — CczCompiler rewrite → `lib/commcare/compiler.ts`; tests rewritten
- **T10** — `formActions` + `deriveCaseConfig` rewrite → `lib/commcare/*`
- **T11** — Drop `toBlueprint` at remaining callers

Shim + migration deletion:
- **T12** — Delete `legacyBridge.ts` + `legacyTypes.ts`
- **T13** — Delete all migration scripts + their tests + fixtures

Vocabulary elimination:
- **T14** — Eliminate `AppBlueprint`, `BlueprintForm`, `BlueprintModule`, `Question` (legacy type), `toBlueprint`, `case_property_on` from every identifier in the repo
- **T15** — Eliminate "question" as a variable/function/comment/prose token anywhere outside literal wire-format strings

Services elimination:
- **T16** — UI singletons (`toastStore`, `keyboardManager`) → `lib/ui/`
- **T17** — Remaining helpers (`fieldPath`, `resetBuilder`, `connectConfig`, `builder.ts`) → domain homes
- **T18** — Delete `lib/services/`, `lib/transpiler/`, `lib/types/`, `lib/schemas/`; relocate `admin.ts`

Architectural hygiene:
- **T19** — Split `lib/preview/hooks/useFormEngine.ts` into single-responsibility files
- **T20** — Dead-code sweep

Boundary enforcement:
- **T21** — Biome boundary rule for `lib/commcare/*`; grep-based forbidden-identifier check

Test strengthening:
- **T22** — Test audit + rewrite — delete snapshot tests on pipeline output; rewrite weak tests as behavior assertions

Documentation:
- **T23** — Rewrite every `CLAUDE.md` to current-state truth
- **T24** — Review every file header comment; remove phase history and migration notes
- **T25** — Update root `README.md` + root `CLAUDE.md`
- **T26** — Close the spec document

Verification:
- **T27** — Full success-criteria walkthrough; PR summary

---

## Task 1: Worktree setup + baseline verification

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .worktrees/phase-7-final -b refactor/phase-7-final
cd .worktrees/phase-7-final
```

- [ ] **Step 2: Confirm the baseline is green**

```bash
npx tsc --noEmit && echo "tsc ✓"
npm run lint    && echo "lint ✓"
npm run build   && echo "build ✓"
npm test        && echo "test ✓"
```

All four must pass. If any fail on `main`, stop and fix on `main` first — Phase 7 does not begin on red.

- [ ] **Step 3: Snapshot the starting file count for the directories about to be emptied**

```bash
find lib/services -type f | wc -l   # non-zero — expect ~50
find lib/transpiler -type f | wc -l # non-zero — expect ~4
find lib/schemas -type f | wc -l    # 0 (only .DS_Store)
find lib/types -type f | wc -l      # 2 (admin.ts + dead index.ts)
rg -c "AppBlueprint|toBlueprint|legacyBridge" lib/ scripts/  # capture baseline count
```

Write the numbers in the PR description as the "before" column so T27 can show the "after" column as a clean zero.

No commit from this task — it's verification scaffolding only.

---

## Task 2: Move XPath grammar + parser into `lib/commcare/xpath/`

**Why:** Per spec §7, the XPath grammar and generated parser live inside the CommCare boundary — they're what CommCare's XPath dialect is, not generic editor infrastructure. The CodeMirror editor extensions at `lib/codemirror/` become consumers of the boundary, not co-owners of it.

**Files:**
- Move: `lib/codemirror/xpath.grammar` → `lib/commcare/xpath/grammar.lezer.grammar`
- Move: `lib/codemirror/xpath-parser.ts` → `lib/commcare/xpath/parser.ts`
- Move: `lib/codemirror/xpath-parser.terms.ts` → `lib/commcare/xpath/parser.terms.ts`
- Modify: `scripts/build-xpath-parser.ts` (input/output paths)
- Modify: every consumer — `rg -l "@/lib/codemirror/xpath-parser"` — update imports
- Create: `lib/commcare/xpath/index.ts` (barrel: `parser`, term constants)

- [ ] **Step 1: Move the files**

```bash
mkdir -p lib/commcare/xpath
git mv lib/codemirror/xpath.grammar         lib/commcare/xpath/grammar.lezer.grammar
git mv lib/codemirror/xpath-parser.ts       lib/commcare/xpath/parser.ts
git mv lib/codemirror/xpath-parser.terms.ts lib/commcare/xpath/parser.terms.ts
```

- [ ] **Step 2: Update the parser build script**

Open `scripts/build-xpath-parser.ts`. Change the grammar input path and the two output paths to point at `lib/commcare/xpath/`. Run:

```bash
npx tsx scripts/build-xpath-parser.ts
```

Expected: regenerates `parser.ts` and `parser.terms.ts`. If the grammar file is unchanged the regenerated content is byte-identical to what we just moved.

- [ ] **Step 3: Create the xpath barrel**

```ts
// lib/commcare/xpath/index.ts
//
// Public surface of the XPath subpackage. Grammar source is compiled
// ahead-of-time into parser.ts + parser.terms.ts (committed; regenerate
// via scripts/build-xpath-parser.ts when the grammar changes).
//
// Consumers outside lib/commcare/ import from this barrel only.

export { parser } from "./parser";
export * from "./parser.terms";
```

- [ ] **Step 4: Rewrite every import of the moved files**

Replace `@/lib/codemirror/xpath-parser` → `@/lib/commcare/xpath` (barrel).
Replace `@/lib/codemirror/xpath-parser.terms` → `@/lib/commcare/xpath` (barrel picks up term exports).

Consumers today: `lib/codemirror/xpath-autocomplete.ts`, `xpath-format.ts`, `xpath-lint.ts`, `buildLintContext.ts`, `xpath-chips.ts`, `xpath-language.ts`; `lib/services/hqJsonExpander.ts`; `lib/transpiler/*`; `lib/preview/engine/*`; tests. Run `rg -l "xpath-parser"` to find every hit and rewrite each.

- [ ] **Step 5: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): move xpath grammar + parser into lib/commcare/xpath/"
```

---

## Task 3: Move the XPath transpiler into `lib/commcare/xpath/`

**Why:** The transpiler runs at CommCare export time — it rewrites our XPath dialect into CommCare-safe XPath 1.0 (wrapping date arithmetic in `date()`, normalizing idioms). That's a CommCare boundary concern, not a general utility.

**Files:**
- Move: `lib/transpiler/index.ts` → `lib/commcare/xpath/transpiler.ts`
- Move: `lib/transpiler/typeInfer.ts` → `lib/commcare/xpath/typeInfer.ts`
- Move: `lib/transpiler/passes/` → `lib/commcare/xpath/passes/`
- Move: `lib/transpiler/__tests__/*` → `lib/commcare/xpath/__tests__/`
- Delete: `lib/transpiler/` (empty)
- Modify: every `@/lib/transpiler` import → `@/lib/commcare/xpath`

- [ ] **Step 1: Move the files, keeping each `git mv` explicit (so history tracks renames)**

```bash
mkdir -p lib/commcare/xpath/__tests__
git mv lib/transpiler/index.ts     lib/commcare/xpath/transpiler.ts
git mv lib/transpiler/typeInfer.ts lib/commcare/xpath/typeInfer.ts
git mv lib/transpiler/passes       lib/commcare/xpath/passes
for f in lib/transpiler/__tests__/*; do
  git mv "$f" "lib/commcare/xpath/__tests__/$(basename "$f")"
done
rmdir lib/transpiler/__tests__
rmdir lib/transpiler
```

- [ ] **Step 2: Fix internal imports inside the moved files**

Inside `lib/commcare/xpath/transpiler.ts` and its siblings, imports like `from "../codemirror/xpath-parser"` resolve nowhere after Task 2. Rewrite them to the sibling: `from "./parser"` (or `from "."` for the barrel).

- [ ] **Step 3: Re-export transpiler from the xpath barrel**

Append to `lib/commcare/xpath/index.ts`:

```ts
export { transpileXPath } from "./transpiler";
// typeInfer + passes are internal — not exported.
```

- [ ] **Step 4: Rewrite external imports**

`rg -l "@/lib/transpiler"` → update each hit to `@/lib/commcare/xpath`.

- [ ] **Step 5: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): move xpath transpiler into lib/commcare/xpath/"
```

---

## Task 4: Promote `lib/services/commcare/*` (non-validator) into `lib/commcare/`

**Why:** The de-facto commcare package has lived under `lib/services/commcare/` since the spec was written. Promote it to the real home.

**Files:**
- Move: `lib/services/commcare/constants.ts`   → `lib/commcare/constants.ts`
- Move: `lib/services/commcare/hashtags.ts`    → `lib/commcare/hashtags.ts`
- Move: `lib/services/commcare/hqShells.ts`    → `lib/commcare/hqShells.ts`
- Move: `lib/services/commcare/hqTypes.ts`     → `lib/commcare/types.ts`    (renamed per spec §7)
- Move: `lib/services/commcare/ids.ts`         → `lib/commcare/ids.ts`
- Move: `lib/services/commcare/session.ts`     → `lib/commcare/session.ts`
- Move: `lib/services/commcare/validate.ts`    → `lib/commcare/identifierValidation.ts` ("validate" is overloaded with the validator package — rename)
- Move: `lib/services/commcare/xml.ts`         → `lib/commcare/xml.ts`
- Delete: `lib/services/commcare/index.ts`      (replaced by new `lib/commcare/index.ts` barrel)
- Move: `lib/services/__tests__/commcare.test.ts` → `lib/commcare/__tests__/commcare.test.ts`
- Move: `lib/services/commcare/__tests__/*` (if any) → `lib/commcare/__tests__/`
- Modify: every consumer's import

- [ ] **Step 1: Move the files**

```bash
git mv lib/services/commcare/constants.ts  lib/commcare/constants.ts
git mv lib/services/commcare/hashtags.ts   lib/commcare/hashtags.ts
git mv lib/services/commcare/hqShells.ts   lib/commcare/hqShells.ts
git mv lib/services/commcare/hqTypes.ts    lib/commcare/types.ts
git mv lib/services/commcare/ids.ts        lib/commcare/ids.ts
git mv lib/services/commcare/session.ts    lib/commcare/session.ts
git mv lib/services/commcare/validate.ts   lib/commcare/identifierValidation.ts
git mv lib/services/commcare/xml.ts        lib/commcare/xml.ts
git rm lib/services/commcare/index.ts
mkdir -p lib/commcare/__tests__
git mv lib/services/__tests__/commcare.test.ts lib/commcare/__tests__/commcare.test.ts
if ls lib/services/commcare/__tests__ >/dev/null 2>&1; then
  for f in lib/services/commcare/__tests__/*; do
    git mv "$f" "lib/commcare/__tests__/$(basename "$f")"
  done
  rmdir lib/services/commcare/__tests__
fi
```

- [ ] **Step 2: Rewrite `lib/commcare/index.ts` as the real package barrel**

```ts
// lib/commcare/index.ts
//
// One-way emission boundary between the builder's domain (lib/domain,
// lib/doc) and CommCare HQ's wire formats. The only place in lib/ that
// speaks CommCare's vocabulary. Biome enforces the one-way import
// direction; nothing outside lib/commcare may reach in except at the
// allowlist documented in lib/commcare/CLAUDE.md.
//
// Public surface:
//   expandDoc(doc)          → HqApplication JSON
//   compileCcz(hqJson, doc) → .ccz Buffer
//   runValidation(doc)      → ValidationError[] (from ./validator)
//   parser / transpileXPath → (from ./xpath)
//   HQ API client           → (from ./client)

export * from "./constants";
export * from "./hashtags";
export * from "./hqShells";
export * from "./ids";
export * from "./identifierValidation";
export * from "./types";
export * from "./xml";
export * from "./session";
export * from "./expander";
export * from "./compiler";
export * from "./formActions";
export * from "./deriveCaseConfig";
export * from "./xform";

// validator + xpath + hq client are accessed via subpath imports:
//   @/lib/commcare/validator, @/lib/commcare/xpath, @/lib/commcare/client.
```

Several of those exported modules (`expander`, `compiler`, `formActions`, `deriveCaseConfig`, `xform`) don't exist yet — they're created in Tasks 7–10. Leaving the re-exports here means each later task slots in without barrel churn. TypeScript will error on the forward references until the files exist; tolerate that inside this task's commit by commenting out those lines until Task 7, or ship them all in a sequence where the typechecker stays green.

**Pragmatic choice:** at this task's commit, include only the lines for modules that exist. Uncomment the forward references as each later task lands.

Start with:

```ts
export * from "./constants";
export * from "./hashtags";
export * from "./hqShells";
export * from "./ids";
export * from "./identifierValidation";
export * from "./types";
export * from "./xml";
export * from "./session";
```

- [ ] **Step 3: Rewrite every internal `lib/services/commcare` import**

Inside `lib/services/*.ts` (still present — the compile pipeline hasn't moved yet), imports like:

```ts
import { HqApplication, escapeXml } from "./commcare";
import { toHqWorkflow } from "./commcare/session";
```

resolve nowhere after the move. Rewrite to absolute paths:

```ts
import { HqApplication, escapeXml } from "@/lib/commcare";
import { toHqWorkflow } from "@/lib/commcare/session";
```

Run `rg -l 'from "\.(/.*)?commcare'` inside `lib/services/` and rewrite every hit.

- [ ] **Step 4: Update external consumers**

`rg -l "@/lib/services/commcare"` → change to `@/lib/commcare`. Test files, validator internals, codemirror lint context — several consumers.

- [ ] **Step 5: Delete the empty `lib/services/commcare/` root**

```bash
# Only validate/ remains inside lib/services/commcare/ at this point.
# Task 5 moves it. Leave the directory; do not `rmdir` yet.
ls lib/services/commcare/  # should show: validate/
```

- [ ] **Step 6: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): promote lib/services/commcare/* into lib/commcare/"
```

---

## Task 5: Move validator into `lib/commcare/validator/`

**Files:**
- Move: `lib/services/commcare/validate/` → `lib/commcare/validator/` (whole tree)
- Modify: `lib/agent/validationLoop.ts`, `lib/codemirror/xpath-lint.ts`, `lib/codemirror/buildLintContext.ts`, `lib/services/*` (temporarily), tests — update imports

- [ ] **Step 1: Move the tree**

```bash
git mv lib/services/commcare/validate lib/commcare/validator
rmdir lib/services/commcare
```

- [ ] **Step 2: Fix cross-file imports inside the validator**

Relative paths like `../commcare` now resolve elsewhere. Rewrite to absolute:

```ts
// Before
import { escapeXml } from "../commcare";
// After
import { escapeXml } from "@/lib/commcare";
```

Also update any imports of sibling validator files from `../validate/*` → `./` (they're now siblings in `lib/commcare/validator/`).

- [ ] **Step 3: Rewrite external consumers**

`rg -l "@/lib/services/commcare/validate"` → `@/lib/commcare/validator`. Consumers: `lib/agent/validationLoop.ts`, `lib/codemirror/xpath-lint.ts`, `lib/codemirror/buildLintContext.ts`, plus any lingering references inside `lib/services/` that Task 4 missed, plus tests.

- [ ] **Step 4: Move + rewrite the validation-rule tests**

```bash
git mv lib/services/__tests__/validationRules.test.ts  lib/commcare/__tests__/validationRules.test.ts
git mv lib/services/__tests__/deepValidation.test.ts   lib/commcare/__tests__/deepValidation.test.ts
```

Update their imports.

- [ ] **Step 5: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): move validator into lib/commcare/validator/"
```

---

## Task 6: Adopt the existing fixture DSL; delete the stray `makeDoc` artifact

**Why:** Tasks 7–10 rewrite the compile pipeline to consume `BlueprintDoc`. The repo **already has** a `BlueprintDoc` fixture DSL at `lib/__tests__/docHelpers.ts` (`buildDoc` + `f`), used by ~15 tests under `lib/commcare/__tests__/`, `lib/doc/__tests__/`, `lib/session/__tests__/`, `lib/routing/__tests__/`, and `lib/services/__tests__/`. Earlier in Phase 7 an additional `makeDoc` helper landed at `lib/commcare/__tests__/fixtures/makeDoc.ts` — a duplicate of `buildDoc` justified by "deterministic seeding for snapshot tests", which Phase 7's T22 explicitly eliminates.

T6 corrects that mistake: the fixture DSL is `lib/__tests__/docHelpers.ts::buildDoc` + `f`. Period. No parallel helper.

**Files:**
- Delete: `lib/commcare/__tests__/fixtures/makeDoc.ts`
- Delete: `lib/commcare/__tests__/fixtures/makeDoc.test.ts`
- Delete: `lib/commcare/__tests__/fixtures/` (empty after deletion)

### Fixture DSL reference (so T7–T10 consumers know what to call)

`lib/__tests__/docHelpers.ts` exports:

- `buildDoc(spec?: DocSpec): BlueprintDoc` — builds a fully normalized `BlueprintDoc` from a concise nested spec. `moduleOrder`, `formOrder`, `fieldOrder`, `fieldParent` are all populated. Uuids are auto-assigned unless the spec provides them. `id` defaults to a snake-cased name; `label` defaults to `id` for non-hidden fields.
- `f(spec: FieldSpec): FieldSpec` — passes through a single field spec with optional `uuid`/`label`/`children`, with sensible defaults.
- `DocSpec`, `ModuleSpec`, `FormSpec`, `FieldSpec` — the nested input shapes. Containers (group/repeat) recurse via `children`.

Tests calling into the compile pipeline import from `@/lib/__tests__/docHelpers` directly:

```ts
import { buildDoc, f } from "@/lib/__tests__/docHelpers";

const doc = buildDoc({
  modules: [{
    name: "Registration",
    caseType: "patient",
    forms: [{ name: "Register", type: "registration", fields: [
      f({ kind: "text", id: "name", case_property: "patient", required: "true()" }),
    ]}],
  }],
});
```

Form uuids are read via `doc.formOrder[doc.moduleOrder[0]][0]` — two property accesses, no helper needed. If a test genuinely needs by-semantic-id lookup across many forms, add a minimal helper to `docHelpers.ts` as part of T7, but don't introduce one preemptively.

### Steps

- [ ] **Step 1: Delete the `makeDoc` files**

```bash
cd /Users/braxtonperry/work/personal/code/commcare-nova/.worktrees/phase-7-final
git rm lib/commcare/__tests__/fixtures/makeDoc.ts
git rm lib/commcare/__tests__/fixtures/makeDoc.test.ts
rmdir lib/commcare/__tests__/fixtures
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit && npm run lint && npm test -- --run
```

All three must pass. Test count drops by 10 (the `makeDoc.test.ts` tests go away) — expect `1449` passing tests in `101` files, matching the baseline from before the errant T6 commit.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "revert(phase-7): drop makeDoc — use existing lib/__tests__/docHelpers.ts"
```

Commit message body (one paragraph): the `buildDoc`/`f` DSL at `lib/__tests__/docHelpers.ts` already builds `BlueprintDoc` from a nested spec with ~15 consumers. The earlier `makeDoc` addition duplicated that for a snapshot-test use case T22 deletes. Source of truth is `docHelpers.ts`; T7–T10 rewrite their tests against it.

---

## Task 7: Rewrite the expander to consume `BlueprintDoc`

**Why:** The expander is the canonical `BlueprintDoc → HqApplication` transform. Today it reads `AppBlueprint` through the `toBlueprint` shim. After this task there is no shim. The expander walks `doc.moduleOrder` / `doc.formOrder[m]` / `doc.fieldOrder[parent]` directly.

> **This is a rewrite, not a port-with-asterisks.** The emission logic (XForm XML, HQ JSON keys, itext tables, bind ordering) is preserved because it encodes CommCare's wire contract. The input traversal is rewritten because the nested `Question[]` tree no longer exists. Where the old code had `form.questions.forEach(...)`, the new code has `for (const fieldUuid of doc.fieldOrder[formUuid]) { const field = doc.fields[fieldUuid]; ... }`. Preserve output bytes because tests assert specific strings; do not try to "improve" the emission format in this task.

**Files:**
- Create: `lib/commcare/expander.ts`
- Delete: `lib/services/hqJsonExpander.ts`
- Move + rewrite: `lib/services/__tests__/hqJsonExpander.test.ts` → `lib/commcare/__tests__/expander.test.ts`
- Rewrite tests: fixtures become `buildDoc()` calls from `@/lib/__tests__/docHelpers` instead of `AppBlueprint` literals

- [ ] **Step 1: Write failing tests for the new API**

Move `hqJsonExpander.test.ts` to `lib/commcare/__tests__/expander.test.ts` and rewrite every test to use `expandDoc` + `buildDoc` from `@/lib/__tests__/docHelpers`. Example:

```ts
// lib/commcare/__tests__/expander.test.ts
import { describe, expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";

describe("expandDoc — followup module", () => {
  it("emits a followup form with case_references.load built from the form's fields", () => {
    const doc = buildDoc({
      modules: [{
        name: "Follow-up", caseType: "patient",
        forms: [{ name: "Visit", type: "followup", fields: [
          f({ kind: "text", id: "notes", case_property: "patient" }),
        ]}],
      }],
    });

    const hq = expandDoc(doc);
    const form = hq.modules[0].forms[0];
    expect(form.case_references?.load).toBeDefined();
    // ...assertions on bind structure, xmlns, case actions, etc.
  });

  // ...one test per specific invariant the old test block asserted.
});
```

Rewrite every `const blueprint: AppBlueprint = { ... }` literal in the old test file as a `buildDoc({...})` call. Use `f(...)` for individual field specs; it sets sensible defaults (label = id, auto-uuid) while letting callers override any key.

Run the test — expect `expandDoc` to not exist:

```bash
npm test -- lib/commcare/__tests__/expander.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/commcare/expander'`.

- [ ] **Step 2: Create `lib/commcare/expander.ts`**

Walk `doc.moduleOrder`, then `doc.formOrder[m]`, then `doc.fieldOrder[f]` recursively. For every form call into `buildXForm(doc, formUuid, opts)` (which is Task 8 — stub it for now; or write an in-task placeholder that returns a `TODO`-marker string and replace in Task 8).

Actually cleaner sequencing: **land Tasks 7 + 8 in one commit** because the expander calls the builder and both change signature at once. Treat this as one atomic unit: the `lib/commcare/expander.ts` + `lib/commcare/xform/builder.ts` files arrive together, along with the deletion of `lib/services/hqJsonExpander.ts` + `lib/services/xformBuilder.ts`.

> **Revised sequencing decision:** merge Tasks 7 and 8 into a single atomic commit. The subheading below spans both files.

Key shape:

```ts
// lib/commcare/expander.ts
//
// BlueprintDoc → HqApplication. Single entry point for CommCare HQ
// import/export and CCZ compilation. Walks the normalized doc and
// emits shell + detail + form definitions. Calls buildXForm for each
// form's XForm XML body. No intermediate wire-format tree.
//
// Consumers: app/api/compile/*, app/api/commcare/upload,
// lib/agent/validationLoop.

import type { BlueprintDoc } from "@/lib/domain";
import { parser } from "@/lib/commcare/xpath";
import { NameTest } from "@/lib/commcare/xpath";
import {
  applicationShell, detailColumn, detailPair, formShell, genHexId, genShortId, moduleShell,
  type HqApplication,
} from "@/lib/commcare";
import { toHqWorkflow } from "@/lib/commcare/session";
import { buildCaseReferencesLoad, buildFormActions } from "@/lib/commcare/formActions";
import { buildXForm } from "@/lib/commcare/xform/builder";

export function detectUnquotedStringLiteral(expr: string): string | null {
  // Unchanged from the old hqJsonExpander; Lezer-based bare-NameTest detection.
}

export function expandDoc(doc: BlueprintDoc): HqApplication {
  const attachments: Record<string, string> = {};

  // Child case types are derived from case_types[].parent_type + matching
  // module case types. Same logic as before; different iteration.
  const childCaseParents = new Map<string, number>();
  if (doc.caseTypes) {
    for (const ct of doc.caseTypes) {
      if (!ct.parent_type) continue;
      const parentIdx = doc.moduleOrder.findIndex(
        (mUuid) => doc.modules[mUuid].caseType === ct.parent_type,
      );
      if (parentIdx !== -1) childCaseParents.set(ct.name, parentIdx);
    }
  }

  const modules = doc.moduleOrder.map((moduleUuid, mIdx) => {
    const mod = doc.modules[moduleUuid];
    const formUuids = doc.formOrder[moduleUuid] ?? [];
    const hasCases = mod.caseType
      && (mod.caseListOnly || formUuids.some((f) => doc.forms[f].type !== "survey"));
    const caseType = hasCases ? (mod.caseType ?? "") : "";

    const forms = formUuids.map((formUuid) => {
      const form = doc.forms[formUuid];
      const formUniqueId = genHexId();
      const xmlns = `http://openrosa.org/formdesigner/${genShortId()}`;
      // ... continue the walk using (doc, formUuid) for buildXForm,
      //     buildFormActions, buildCaseReferencesLoad, etc.
    });

    return { ...moduleShell(mod, mIdx), case_type: caseType, forms /* , + details, etc. */ };
  });

  return applicationShell({ modules, case_types: doc.caseTypes, /* ... */ });
}
```

Every call into `buildFormActions`, `buildCaseReferencesLoad`, `deriveCaseConfig` now takes `(doc, formUuid, ...)` instead of `(form, ...)`. These are rewritten in Task 10.

> **Dependency order for this task:** write the expander assuming the Task 10 signatures already exist. Temporarily stub `buildFormActions(doc, formUuid, mt, ct)` and `buildCaseReferencesLoad(doc, formUuid)` inline in `lib/commcare/formActions.ts` with a minimal implementation that delegates to the old `lib/services/formActions.ts` via `toBlueprint`-free walks you write as part of this task. Task 10 then consolidates.

Actually — reconsidering — sequencing these tightly coupled rewrites requires either one giant commit or temporary stubs. The cleanest is one commit that lands expander + xform/builder + formActions + deriveCaseConfig together, which is Tasks 7+8+10 atomic. Task 9 (CczCompiler) can follow separately because it doesn't call any of them.

> **Final sequencing:** Merge Tasks 7, 8, and 10 into a single implementer dispatch. The implementer delivers one commit containing `lib/commcare/expander.ts` + `lib/commcare/xform/builder.ts` + `lib/commcare/formActions.ts` + `lib/commcare/deriveCaseConfig.ts` and the deletion of their `lib/services/` counterparts, along with rewritten tests.

Below the section break, Task 8 and Task 10's checklists are consumed into Task 7's flow. They remain as informational anchors so the PR description can reference "Task 8 — xform/builder" by name.

- [ ] **Step 3: Delete the old files**

```bash
git rm lib/services/hqJsonExpander.ts
git rm lib/services/xformBuilder.ts
git rm lib/services/formActions.ts
git rm lib/services/deriveCaseConfig.ts
```

- [ ] **Step 4: Rewrite every test file that imported the old modules**

- `lib/services/__tests__/hqJsonExpander.test.ts` → `lib/commcare/__tests__/expander.test.ts` (rewritten to use `expandDoc` + `buildDoc`/`f` from `@/lib/__tests__/docHelpers`)
- `lib/services/__tests__/formBuilderAgent.test.ts` → `lib/commcare/__tests__/formBuilder.test.ts` (rewritten to use `buildXForm(doc, formUuid, opts)` + `buildDoc`/`f`)
- `lib/services/__tests__/postExpansionValidation.test.ts` → `lib/commcare/__tests__/postExpansionValidation.test.ts` (same pattern)
- `lib/services/__tests__/session.test.ts` → `lib/commcare/__tests__/session.test.ts`
- `lib/services/__tests__/connectConfig.test.ts` — stays at `lib/services/__tests__/` until Task 17 moves `connectConfig` — adjust imports to the new expander only
- Delete `lib/services/__tests__/wireFixtures.ts` (it holds `AppBlueprint`-shaped helpers; obsolete)

- [ ] **Step 5: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): rewrite expander + xform builder + form-action helpers to consume BlueprintDoc"
```

---

## Task 8: XForm builder rewrite (folded into Task 7)

*(This task is delivered as part of Task 7's atomic commit. Retained as a named anchor.)*

The rewritten `lib/commcare/xform/builder.ts` signature:

```ts
export function buildXForm(
  doc: BlueprintDoc,
  formUuid: Uuid,
  opts: {
    xmlns: string;
    connect?: ConnectConfig;
    caseTypes?: Array<{ name: string; parent_type: string | null }>;
    moduleCaseType?: string;
  },
): string;
```

Internal walkers read `doc.fieldOrder[parentUuid]` + `doc.fields[fieldUuid]` + `doc.fieldParent[fieldUuid]` for ancestry. The XML emission, itext table, bind list, and secondary-instance accumulators are unchanged — they operate on strings and primitives, not wire types.

---

## Task 9: CczCompiler rewrite

**Why:** The compiler takes the expanded `HqApplication` and the source `BlueprintDoc`, and produces a `.ccz` archive. Today it also takes a nested `blueprint: AppBlueprint` for one lookup (form-type at `cczCompiler.ts:129`). Change the signature to take `doc: BlueprintDoc` instead and resolve the lookup through `doc.moduleOrder[m]` + `doc.formOrder[...][f]`.

**Files:**
- Create: `lib/commcare/compiler.ts` (rewrite of `cczCompiler.ts`, no class wrapper — plain function `compileCcz(hqJson, appName, doc)`)
- Delete: `lib/services/cczCompiler.ts`
- Move + rewrite: `lib/services/__tests__/cczCompiler.test.ts` → `lib/commcare/__tests__/compiler.test.ts`

- [ ] **Step 1: Write the new compiler's tests first**

Rewrite `cczCompiler.test.ts` to use `compileCcz(hqJson, appName, doc)` where `doc` is built via `buildDoc`/`f` from `@/lib/__tests__/docHelpers`. Each test asserts a specific invariant about the archive contents — e.g. "archive includes `suite.xml` with a menu entry for module m0", "profile.ccpr has appName set", "case-block injection inserts a `<case>` element before `</data>` in form XML", etc. If a test was just `toMatchSnapshot()` on the archive, rewrite it as specific assertions.

Run:

```bash
npm test -- lib/commcare/__tests__/compiler.test.ts
```

Expected: FAIL — `compileCcz` doesn't exist.

- [ ] **Step 2: Write `lib/commcare/compiler.ts`**

Plain function signature. `HqApplication`'s module/form structure parallels `doc.moduleOrder` / `doc.formOrder[m]` — walk them together for any per-form metadata lookups that need the doc.

```ts
// lib/commcare/compiler.ts
//
// HqApplication + BlueprintDoc → .ccz Buffer.
//
// Generates suite.xml, profile.ccpr, app_strings.txt, media_suite.xml,
// and bundles every form's XForm XML with case-block injection.
// Validates each XForm post-injection; throws on structural issues.

import AdmZip from "adm-zip";
import type { BlueprintDoc } from "@/lib/domain";
import type { DetailColumn, HqApplication } from "@/lib/commcare";
import { validateCaseType, validatePropertyName, validateXFormPath } from "@/lib/commcare";
import { deriveEntryDefinition, fromHqWorkflow, renderEntryXml } from "@/lib/commcare/session";
import { errorToString } from "@/lib/commcare/validator";
import { validateXFormXml } from "@/lib/commcare/validator";

export async function compileCcz(
  hqJson: HqApplication,
  appName: string,
  doc: BlueprintDoc,
): Promise<Buffer> {
  // ... XForm emission walk: iterate hqJson.modules and doc.moduleOrder
  // in parallel (they're 1:1 by construction from expandDoc). Same for
  // forms.
}
```

The class-based `CczCompiler` goes away — nothing in the codebase needs it as a class. Plain function is simpler and clearer.

- [ ] **Step 3: Delete the old file + verify**

```bash
git rm lib/services/cczCompiler.ts
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): rewrite CczCompiler as compileCcz(hqJson, appName, doc)"
```

---

## Task 10: `formActions` + `deriveCaseConfig` — (folded into Task 7)

*(Delivered as part of Task 7's commit. Retained as anchor.)*

After Task 7:
- `lib/commcare/formActions.ts` exposes `buildFormActions(doc, formUuid, moduleCaseType, caseTypes): FormActions` and `buildCaseReferencesLoad(doc, formUuid): CaseReferencesLoad`.
- `lib/commcare/deriveCaseConfig.ts` exposes `deriveCaseConfig(doc, formUuid, moduleCaseType, formType): DerivedCaseConfig`. Its `CaseConfigQuestion` interface disappears — there are no "questions" here, only doc fields.

---

## Task 11: Drop `toBlueprint` at the remaining callers

**Files:**
- Modify: `lib/agent/validationLoop.ts` (four call sites)
- Modify: `app/api/compile/route.ts`
- Modify: `app/api/compile/json/route.ts`

- [ ] **Step 1: Rewrite `app/api/compile/route.ts`**

```ts
// Before
import { toBlueprint } from "@/lib/doc/legacyBridge";
import { CczCompiler } from "@/lib/services/cczCompiler";
import { expandBlueprint } from "@/lib/services/hqJsonExpander";
// ...
const blueprint = toBlueprint({ ...parsedDoc.data, fieldParent: {} });
const hqJson = expandBlueprint(blueprint);
const compiler = new CczCompiler();
const buffer = await compiler.compile(hqJson, parsedDoc.data.appName, blueprint);

// After
import { compileCcz, expandDoc } from "@/lib/commcare";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
// ...
const doc = { ...parsedDoc.data, fieldParent: {} as Record<Uuid, Uuid | null> };
rebuildFieldParent(doc);
const hqJson = expandDoc(doc);
const buffer = await compileCcz(hqJson, doc.appName, doc);
```

- [ ] **Step 2: Rewrite `app/api/compile/json/route.ts` analogously**

- [ ] **Step 3: Rewrite `lib/agent/validationLoop.ts`**

Four call sites — replace each `expandBlueprint(toBlueprint(workingDoc))` with `expandDoc(workingDoc)`. Drop the `toBlueprint` import.

- [ ] **Step 4: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): drop toBlueprint at compile + validation-loop entry points"
```

---

## Task 12: Delete `legacyBridge.ts` + `legacyTypes.ts`

**Why:** After Task 11 nothing in production code imports from either file. They are the wire-format shim — the whole point of this phase is that they cease to exist.

- [ ] **Step 1: Confirm zero production consumers**

```bash
rg -n "legacyBridge|legacyTypes|toBlueprint|\\bAppBlueprint\\b" lib/ app/ components/
```

Expected: matches only in the files about to be deleted. If a production file still references either, trace and fix.

- [ ] **Step 2: Delete**

```bash
git rm lib/doc/legacyBridge.ts
git rm lib/doc/legacyTypes.ts
```

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): delete legacyBridge + legacyTypes (wire-format shim gone)"
```

---

## Task 13: Delete all migration scripts + their tests + fixtures

**Why:** The migration has run. `git` preserves the scripts for reference. Keeping retired migration code in the tree accrues maintenance cost against a backfilled benefit — every future refactor has to check "does this still build", "do its tests still pass", "are its imports still valid".

**Files:**
- Delete: `scripts/migrate-to-normalized-doc.ts`
- Delete: `scripts/migrate-agent-tool-vocab.ts`
- Delete: `scripts/migrate-users.ts`
- Delete: `scripts/__tests__/migrate-to-normalized-doc.test.ts`
- Delete: `scripts/__tests__/fixtures/legacy-blueprint.json`
- Delete: `scripts/__tests__/fixtures/` (if empty after)
- Delete: `scripts/__tests__/` (if empty after)

- [ ] **Step 1: Delete**

```bash
git rm scripts/migrate-to-normalized-doc.ts
git rm scripts/migrate-agent-tool-vocab.ts
git rm scripts/migrate-users.ts
git rm scripts/__tests__/migrate-to-normalized-doc.test.ts
git rm scripts/__tests__/fixtures/legacy-blueprint.json
rmdir scripts/__tests__/fixtures 2>/dev/null
rmdir scripts/__tests__ 2>/dev/null
```

- [ ] **Step 2: Check `scripts/README.md`**

If it documents the deleted migrations, strip those sections and leave only what applies to `inspect-*`, `recover-app`, `check-reasoning`, `test-schema`, `build-xpath-parser`, `sync-knowledge`, etc.

- [ ] **Step 3: Sweep for residual references**

```bash
rg -n "legacyAppBlueprintToDoc|migrate-to-normalized-doc|migrate-agent-tool-vocab|migrate-users" \
   lib/ app/ components/ scripts/ docs/
```

Expected: zero outside historical spec/plan docs. Plan/spec doc references are OK (they're historical).

- [ ] **Step 4: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "chore(phase-7): remove retired migration scripts + fixtures"
```

---

## Task 14: Eliminate residual wire-format type identifiers

**Why:** Success criterion #4. After Tasks 7–13 the types + functions `AppBlueprint`, `BlueprintForm`, `BlueprintModule`, `Question` (legacy wire type), `toBlueprint`, `toDoc`, `case_property_on` should have zero identifier occurrences in the repo. They may still appear as **string literals** in strict CommCare-boundary code where the wire format encodes those names (XML attributes, JSON keys). They must not appear as TypeScript identifiers.

- [ ] **Step 1: Sweep**

```bash
rg -n "\\bAppBlueprint\\b|\\bBlueprintForm\\b|\\bBlueprintModule\\b|\\btoBlueprint\\b|\\btoDoc\\b" \
   lib/ app/ components/ scripts/
rg -n "case_property_on" lib/ app/ components/ scripts/
```

For each hit:
- If the file is inside `lib/commcare/` and the token is inside a quoted string emitted to CommCare wire format → leave it.
- If the file is inside `lib/commcare/` and the token is a TypeScript identifier (type name, variable name, function name) → rename to the domain equivalent (`BlueprintForm` → delete the type; `case_property_on` → `case_property` if a TS identifier). The wire emission keeps its quoted string.
- Anywhere else → rename or delete.

- [ ] **Step 2: Rename residual `Question` type occurrences**

```bash
rg -n "\\bQuestion\\b" lib/ app/ components/ scripts/
```

Filter out the user-facing `AskQuestionsCard.tsx` (UI copy). For the rest:
- If it's a type import from the deleted `legacyTypes.ts` → the import is already broken post-Task-12; delete it.
- If it's a local variable name → rename to `field`.
- If it's a comment → rewrite to say "field".

- [ ] **Step 3: Verify + commit**

```bash
rg -n "\\bAppBlueprint\\b|\\bBlueprintForm\\b|\\bBlueprintModule\\b|\\btoBlueprint\\b|\\btoDoc\\b|\\bQuestion\\b|case_property_on" \
   lib/ app/ components/ scripts/ \
   --glob '!docs/**' --glob '!components/chat/AskQuestionsCard.tsx'
```

Expected: every hit inside `lib/commcare/` is a quoted string literal for a wire attribute/key, verifiable by eye. Nothing outside `lib/commcare/`.

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): eliminate residual wire-format type identifiers"
```

---

## Task 15: Sweep "question" as a variable / comment / prose token

**Why:** Success criterion #3 sets the bar as spec §8's vocabulary rule: "everything internal is `Field`". The token `question` survives only in strict emission points inside `lib/commcare/` (e.g. `close_condition.question` as a wire JSON key, XForm `<question-type>` attribute string literals) and in user-facing UI copy.

**Files (verify + fix):**
- `lib/preview/engine/*.ts`
- `lib/preview/engine/fieldTree.ts`, `formEngine.ts`, `triggerDag.ts`, `provider.tsx`
- `lib/codemirror/buildLintContext.ts`, `xpath-lint.ts`
- `lib/doc/mutations/notify.ts`
- `lib/doc/navigation.ts` (if still present)
- `components/preview/form/**` (components + tests)
- `lib/doc/__tests__/hooks.test.tsx` (comment)
- Any remaining test fixture files

Allowlist (tokens stay):
- `lib/commcare/**` — but only as string literals inside emission calls, not as identifiers.
- `components/chat/AskQuestionsCard.tsx` and its consumers — user-visible "ask questions" feature naming.

- [ ] **Step 1: Sweep**

```bash
rg -n "\\bquestion[s]?\\b|\\bQuestion[s]?\\b" lib/ components/ app/ \
   --glob '!lib/commcare/**' \
   --glob '!components/chat/AskQuestionsCard.tsx' \
   --glob '!components/chat/*.tsx' \
   --glob '!docs/**'
```

Every hit → rename variable/function to `field`/`fields`/`Field`, rewrite comment to say "field".

- [ ] **Step 2: Sweep inside `lib/commcare/`**

```bash
rg -n "\\bquestion[s]?\\b|\\bQuestion[s]?\\b" lib/commcare/ --glob '!**/__tests__/**'
```

Every hit — classify:
- Quoted string inside an emission expression (`"question"` as a CommCare JSON key / XML attribute) → keep, add a comment if not obvious.
- TypeScript identifier or comment → rewrite.

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): sweep question/Question identifiers outside CommCare emission"
```

---

## Task 16: Relocate UI singletons to `lib/ui/`

**Files:**
- Move: `lib/services/toastStore.ts`     → `lib/ui/toastStore.ts`
- Move: `lib/services/keyboardManager.ts` → `lib/ui/keyboardManager.ts`
- Move: `lib/services/__tests__/keyboardManager.test.ts` → `lib/ui/__tests__/keyboardManager.test.ts`
- Modify: every consumer

- [ ] **Step 1: Move**

```bash
mkdir -p lib/ui/__tests__
git mv lib/services/toastStore.ts                       lib/ui/toastStore.ts
git mv lib/services/keyboardManager.ts                  lib/ui/keyboardManager.ts
git mv lib/services/__tests__/keyboardManager.test.ts   lib/ui/__tests__/keyboardManager.test.ts
```

- [ ] **Step 2: Rewrite imports**

`rg -l "@/lib/services/toastStore"` → `@/lib/ui/toastStore`.
`rg -l "@/lib/services/keyboardManager"` → `@/lib/ui/keyboardManager`.

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): move toastStore + keyboardManager into lib/ui/"
```

---

## Task 17: Relocate remaining `lib/services/` helpers

**Files:**
- Move: `lib/services/fieldPath.ts`     → `lib/doc/fieldPath.ts`
- Move: `lib/services/resetBuilder.ts`  → `lib/doc/resetBuilder.ts`
- Move: `lib/services/connectConfig.ts` → `lib/doc/connectConfig.ts`
- Move: `lib/services/builder.ts` → `lib/session/builderTypes.ts` (exports `BuilderPhase`, `SelectedElement`, `EditScope`)
- Move: `lib/services/__tests__/fieldPath.test.ts`      → `lib/doc/__tests__/fieldPath.test.ts`
- Move: `lib/services/__tests__/connectConfig.test.ts`  → `lib/doc/__tests__/connectConfig.test.ts`

**Rationale:**
- `fieldPath.ts` is a string primitive for doc-derived render identity → lives next to `lib/doc/navigation.ts`.
- `resetBuilder.ts` writes to the doc + session stores → `lib/doc/`.
- `connectConfig.ts` derives form-level Connect config from doc state → `lib/doc/`.
- `builder.ts` holds UI-shared types (`BuilderPhase`, `SelectedElement`, `EditScope`). Session already owns phase derivation — the types live there.

- [ ] **Step 1: Move**

```bash
git mv lib/services/fieldPath.ts                      lib/doc/fieldPath.ts
git mv lib/services/resetBuilder.ts                   lib/doc/resetBuilder.ts
git mv lib/services/connectConfig.ts                  lib/doc/connectConfig.ts
git mv lib/services/builder.ts                        lib/session/builderTypes.ts
git mv lib/services/__tests__/fieldPath.test.ts       lib/doc/__tests__/fieldPath.test.ts
git mv lib/services/__tests__/connectConfig.test.ts   lib/doc/__tests__/connectConfig.test.ts
```

- [ ] **Step 2: Rewrite imports**

```
@/lib/services/fieldPath     → @/lib/doc/fieldPath
@/lib/services/resetBuilder  → @/lib/doc/resetBuilder
@/lib/services/connectConfig → @/lib/doc/connectConfig
@/lib/services/builder       → @/lib/session/builderTypes
```

- [ ] **Step 3: Confirm `lib/services/` is empty**

```bash
ls lib/services/
# Expected: CLAUDE.md, maybe __tests__/
ls lib/services/__tests__/
# Any remaining test file corresponds to code already moved; relocate it.
```

- [ ] **Step 4: Delete `lib/services/CLAUDE.md`**

Its content is folded into `lib/commcare/CLAUDE.md` (Task 23) and, where relevant, into `lib/ui/CLAUDE.md` + `lib/doc/CLAUDE.md`. Do not carry it forward as a stub pointer.

```bash
git rm lib/services/CLAUDE.md
rmdir lib/services/__tests__ 2>/dev/null
rmdir lib/services
```

- [ ] **Step 5: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): relocate remaining services helpers; delete lib/services/"
```

---

## Task 18: Delete `lib/schemas/`, `lib/types/`, `lib/transpiler/`

**Files:**
- Move: `lib/types/admin.ts` → `lib/admin/types.ts`
- Delete: `lib/types/index.ts` (useless barrel)
- Delete: `lib/types/`
- Delete: `lib/schemas/` (contains only `.DS_Store`)
- Delete: `lib/transpiler/` (Task 3 should already have emptied it; this step confirms + removes)

- [ ] **Step 1: Relocate admin types**

```bash
mkdir -p lib/admin
git mv lib/types/admin.ts lib/admin/types.ts
```

Inside the moved file, rewrite `import type { AppSummary } from "../db/apps"` → `import type { AppSummary } from "@/lib/db/apps"`.

- [ ] **Step 2: Delete the empty directories**

```bash
git rm lib/types/index.ts
rmdir lib/types
rm -rf lib/schemas
test ! -d lib/transpiler && echo "transpiler gone"
```

- [ ] **Step 3: Rewrite admin consumers**

```
@/lib/types/admin → @/lib/admin/types
```

Consumers: `app/admin/user-table.tsx`, `app/admin/users/[id]/user-usage.tsx`, plus any API route.

- [ ] **Step 4: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): delete lib/types + lib/schemas + lib/transpiler; move admin types"
```

---

## Task 19: Split `lib/preview/hooks/useFormEngine.ts` into single-responsibility files

**Why:** The file today holds three unrelated hooks: `useFormEngine` (mount/unmount activator), `useEngineController` (controller getter), `useEngineState` (per-field state selector). The file name describes one of the three. Split so every file is one responsibility and one export.

**Files:**
- Split: `lib/preview/hooks/useFormEngine.ts` into:
  - `lib/preview/hooks/useFormEngine.ts` — just the activation hook
  - `lib/preview/hooks/useEngineController.ts` — just the controller getter
  - `lib/preview/hooks/useEngineState.ts` — just the per-field state selector
- Modify: consumers import from the specific file, not a grab-bag barrel

- [ ] **Step 1: Split**

Write three new files with the respective hook bodies. Each file's header describes only that hook. Preserve existing JSDoc where accurate; trim phase-history references.

- [ ] **Step 2: Update consumers**

```
components/preview/screens/FormScreen.tsx          → useFormEngine import unchanged (same path)
components/preview/form/InteractiveFormRenderer.tsx→ import from useEngineController
components/preview/form/virtual/rows/FieldRow.tsx  → import from useEngineState
components/preview/form/virtual/rows/GroupBracket.tsx → import from useEngineState
components/preview/form/fields/GroupField.tsx      → import from useEngineState
components/preview/form/fields/RepeatField.tsx     → import from useEngineState
```

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "refactor(phase-7): split preview hooks into single-responsibility files"
```

---

## Task 20: Dead-code sweep

**Goal:** After the reshuffles, identify and remove code that has zero production consumers.

- [ ] **Step 1: Find unused exports**

Use TypeScript to surface unused exports (tooling varies — `ts-prune` or `knip` or a manual grep of each barrel vs its consumers). If installed via npm, run it. If not, do a targeted grep of suspicious files:

```bash
# For each exported function in:
#   lib/doc/navigation.ts, lib/doc/predicates.ts, lib/doc/fieldWalk.ts,
#   lib/doc/searchBlueprint.ts, lib/commcare/*, lib/ui/hooks/*,
#   lib/preview/*
# — rg "<identifier>" lib/ components/ app/ and delete anything with
# zero non-self matches.
```

- [ ] **Step 2: Delete unused exports + their tests**

For each dead export found, delete the function + its tests. If deleting a function causes a file to become empty of exports, delete the file.

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add -A
git commit -m "chore(phase-7): dead-code sweep"
```

If the sweep surfaces nothing removable, commit is empty — skip this step. Do not commit a placeholder.

---

## Task 21: Boundary enforcement — Biome rule + forbidden-identifier check

**Files:**
- Modify: `biome.json` — new override block restricting `@/lib/commcare/*` imports outside the allowlist
- Create: `scripts/check-forbidden-identifiers.ts` — CI-runnable script that greps for banned identifiers
- Modify: `lefthook.yml` — wire the script into pre-commit

- [ ] **Step 1: Add the Biome boundary rule**

Append to `biome.json`'s `overrides[]`:

```json
{
  "includes": [
    "components/**",
    "app/**",
    "lib/**",
    "!**/__tests__/**",
    "!app/api/compile/**",
    "!app/api/commcare/**",
    "!lib/agent/validationLoop.ts",
    "!lib/codemirror/**",
    "!lib/preview/engine/**",
    "!lib/commcare/**"
  ],
  "linter": {
    "rules": {
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "paths": {
              "@/lib/commcare": "lib/commcare is the one-way CommCare emission boundary. Allowed consumers: app/api/compile, app/api/commcare, lib/agent/validationLoop, lib/codemirror, lib/preview/engine.",
              "@/lib/commcare/expander": "See @/lib/commcare restriction.",
              "@/lib/commcare/compiler": "See @/lib/commcare restriction.",
              "@/lib/commcare/formActions": "See @/lib/commcare restriction.",
              "@/lib/commcare/deriveCaseConfig": "See @/lib/commcare restriction.",
              "@/lib/commcare/validator": "See @/lib/commcare restriction.",
              "@/lib/commcare/xform/builder": "See @/lib/commcare restriction.",
              "@/lib/commcare/xpath": "See @/lib/commcare restriction.",
              "@/lib/commcare/session": "See @/lib/commcare restriction.",
              "@/lib/commcare/types": "See @/lib/commcare restriction."
            }
          }
        }
      }
    }
  }
}
```

Run `npm run lint`. Expected: every violation points at a file not in the allowlist but importing from `@/lib/commcare/*`. If there's a legitimate violation, update the allowlist; if it's illegitimate, fix the import.

- [ ] **Step 2: Write the forbidden-identifier check**

```ts
// scripts/check-forbidden-identifiers.ts
//
// CI gate: fail if forbidden identifiers creep back into the repo.
// Runs against lib/, app/, components/, scripts/ — everything that
// should have migrated off the pre-Phase-7 vocabulary.

import { execSync } from "node:child_process";

const FORBIDDEN = [
  "\\bAppBlueprint\\b",
  "\\bBlueprintForm\\b",
  "\\bBlueprintModule\\b",
  "\\btoBlueprint\\b",
  "\\btoDoc\\b",
  "\\blegacyAppBlueprintToDoc\\b",
  "case_property_on",
];

const SCAN = ["lib", "app", "components", "scripts"];
const EXCLUDE = [
  "--glob", "!**/__tests__/**",
  "--glob", "!docs/**",
  "--glob", "!**/*.md",
  "--glob", "!components/chat/AskQuestionsCard.tsx",
];

let failed = false;
for (const pattern of FORBIDDEN) {
  const cmd = ["rg", "-n", pattern, ...SCAN, ...EXCLUDE].map((x) => JSON.stringify(x)).join(" ");
  try {
    const out = execSync(cmd, { encoding: "utf8" });
    if (out.trim()) {
      console.error(`✗ forbidden identifier /${pattern}/ matches:\n${out}`);
      failed = true;
    }
  } catch {
    // rg exits 1 when no matches — that's success.
  }
}

// Additionally, the bare word "Question" is forbidden outside allowlisted
// files. Keep this check separate so its message is specific.
// (Same pattern as above; iterate /\bQuestion\b/ with extra globs.)

if (failed) process.exit(1);
console.log("✓ no forbidden identifiers");
```

- [ ] **Step 3: Wire into `lefthook.yml` pre-commit**

Add a job that runs `npx tsx scripts/check-forbidden-identifiers.ts`. Fail the commit if it exits non-zero.

- [ ] **Step 4: Verify + commit**

```bash
npx tsc --noEmit && npm run lint && npm test
npx tsx scripts/check-forbidden-identifiers.ts   # should pass
git add -A
git commit -m "chore(phase-7): enforce CommCare boundary + forbidden identifiers via lint"
```

---

## Task 22: Test audit + strengthening

**Why:** Spec criterion #10 asks that SA output remain valid CommCare against today's output. Our guarantee for that is the test suite — so the test suite must actually specify what's correct. Fixture-round-trip and snapshot-output tests don't.

- [ ] **Step 1: Audit every test file under `lib/commcare/__tests__/`**

For each test file, read it and classify every `it(...)` block:

- (A) Asserts specific behaviors — "given input X, output Y has property Z". KEEP.
- (B) Fixture-round-trip — "pass blueprint, expect HqApplication to match fixture output". REWRITE into (A): assert specific properties of the output.
- (C) Snapshot — `toMatchSnapshot()` or `toMatchInlineSnapshot()` on pipeline output. REWRITE into (A) or DELETE if redundant.

Write the classification as PR-description notes so the reviewer can see what changed.

- [ ] **Step 2: Strengthen weak tests**

For each (B) or (C) test, rewrite it as specific assertions. Examples:

```ts
// Before (weak — freezes implementation)
it("expands fixture to expected hqJson", () => {
  expect(expandDoc(doc)).toEqual(EXPECTED_HQ_JSON);
});

// After (strong — asserts what actually matters)
it("emits one module with its case_type", () => {
  const hq = expandDoc(doc);
  expect(hq.modules).toHaveLength(1);
  expect(hq.modules[0].case_type).toBe("patient");
});

it("emits a form bind for each field with its data_type", () => {
  const hq = expandDoc(doc);
  const xml = hq._attachments![Object.keys(hq._attachments!)[0]];
  expect(xml).toMatch(/<bind nodeset="\/data\/patient_name"[^>]*type="xsd:string"/);
});
```

Specific assertions fail on specific bugs. Snapshot tests fail on everything including formatting churn, which teaches the maintainer to `-u` snapshots without reading the diff.

- [ ] **Step 3: Delete redundant tests**

If a test asserts something already covered by another test, delete it. Redundancy inflates `npm test` time and obscures which test actually pins a given behavior.

- [ ] **Step 4: Add missing coverage**

While rewriting the expander + compiler, the implementer encountered edge cases that existing tests didn't cover. Add tests for each:
- Case-property rename cascading through XPath references
- Empty form (zero fields) compiles to a stub XForm
- Group containing zero children emits an empty `<group>` node
- Repeat with nested group (two levels of container)
- Form with `form_links` → condition matching emits a `<link>` element
- Connect learn-only module (no deliver sub-config) still compiles

Each test is 10–20 lines. Plan to add 5–10 of them.

- [ ] **Step 5: Verify + commit**

```bash
npm test
git add -A
git commit -m "test(phase-7): strengthen compile-pipeline tests; remove snapshot dependence"
```

---

## Task 23: Rewrite every affected `CLAUDE.md`

**Why:** CLAUDE.md files are the first thing a new engineer (or a fresh subagent) reads. They need to describe the codebase as it IS. Phase-history, "moved from X to Y" stanzas, and aspirational "Phase N will do Z" notes belong in git history, not in a file an agent will load every conversation.

**Files (every one reviewed):**
- `CLAUDE.md` (root)
- `lib/commcare/CLAUDE.md` (fully rewritten — it's the major new home)
- `lib/doc/CLAUDE.md` (remove legacyBridge stanza)
- `lib/ui/CLAUDE.md` (add toastStore, keyboardManager)
- `lib/agent/CLAUDE.md` (`expandBlueprint` → `expandDoc`, remove `toBlueprint` references)
- `lib/preview/CLAUDE.md` (confirm accurate)
- `lib/log/CLAUDE.md` (confirm accurate)
- `lib/routing/CLAUDE.md` (confirm accurate)
- `lib/codemirror/CLAUDE.md` (xpath parser moved out — update)
- `components/builder/CLAUDE.md` (any services references)
- `app/CLAUDE.md` or route-level CLAUDE.md if present

- [ ] **Step 1: Rewrite `lib/commcare/CLAUDE.md` from scratch**

```md
# lib/commcare

One-way emission boundary: `BlueprintDoc` → CommCare wire formats
(XForm XML, `HqApplication` JSON, `.ccz` archive). The only package in
`lib/` that imports CommCare's vocabulary (`Question`, `case_property_on`,
HQ shell shapes). A Biome `noRestrictedImports` rule enforces the
one-way direction.

## Public surface

- `expandDoc(doc)` → `HqApplication` JSON for HQ import
- `compileCcz(hqJson, appName, doc)` → `.ccz` archive as `Buffer`
- `runValidation(doc)` (`@/lib/commcare/validator`) → `ValidationError[]`
- `parser`, `transpileXPath`, term constants (`@/lib/commcare/xpath`)
- `listDomains`, `importApp`, `encrypt`, `decrypt` (`./client`, `./encryption`)

## Allowlist

Only these consumers may reach into this package:

- `app/api/compile/*`, `app/api/commcare/*`, `app/api/upload/*`
- `lib/agent/validationLoop`
- `lib/codemirror/*` (xpath parser + lint diagnostics)
- `lib/preview/engine/*` (xpath transpiler for live evaluation)

## Subpackage layout

compiler.ts expander.ts formActions.ts deriveCaseConfig.ts session.ts
hashtags.ts ids.ts xml.ts constants.ts identifierValidation.ts hqShells.ts
types.ts client.ts encryption.ts
xform/builder.ts
validator/{index,runner,errors,fixes,typeChecker,functionRegistry,xformValidator,xpathValidator}.ts
validator/rules/{app,module,form,field}.ts
xpath/{grammar.lezer.grammar,parser,parser.terms,transpiler,typeInfer}.ts
xpath/passes/dateArithmetic.ts

## Key design decisions

### Vellum dual-attribute pattern

CommCare's Vellum editor requires both expanded XPath AND the original
shorthand on every bind. Real attributes (`calculate`, `relevant`,
`constraint`) get the expanded instance XPath; `vellum:` attributes
preserve the original `#case/` and `#user/` shorthand. Every bind also
gets `vellum:nodeset="#form/..."`.

### Bare hashtags in prose

Hashtag wrapping in label/hint text uses regex, NOT the Lezer XPath
parser. Labels are prose; surrounding characters like `**` (markdown
bold) parse as XPath operators, which swallows the `#`.

### Markdown itext

All itext entries (labels, hints, option labels) emit both `<value>` and
`<value form="markdown">`. Safe for plain text: identical rendering when
no markdown syntax is present.

### Secondary instances

`casedb` and `commcaresession` are accumulated at the point of use —
XPath field + label scans, Connect expression scans. `casedb` implies
`commcaresession`.

### `post_submit` defaults

Controls post-submit navigation. Three user-facing values: `app_home`,
`module`, `previous`. Two internal values (`root`, `parent_module`)
exist for export fidelity. Form-type defaults when absent:
followup/close → `previous`, registration/survey → `app_home`. The SA
only sets `post_submit` when overriding the default.

### Form links

`form_links` on a form enables conditional navigation: `condition?`
(XPath) + `target` (form or module by uuid) + optional `datums`. First
matching condition wins; `post_submit` is the fallback. Fully
validated.

## CommCare HQ upload

Upload creates a new app each time — HQ has no atomic update API.
Two HQ workarounds live on the import endpoint: a CSRF token fetched
from the unauthenticated login GET (HQ is missing `@csrf_exempt`), and
a 16KB padding field that pushes JSON past AWS WAF's inspection window
(HQ is missing the XSS-body exemption). Padding field name must NOT
start with `_` (CouchDB reserved). Symptom of a WAF block: bare nginx
403 — distinct from Django's verbose CSRF 403.

## Not-yet-implemented

HQ build checks we do NOT cover — add when the corresponding feature
lands:

- Shadow modules, parent-select cycles, case-search config
- Case tile configuration, smart links, case list field actions
- Sort field format regex, multimedia, multi-language
- Itemset nodeset/label/copy/value relationships
- Repeat homogeneity

Validation stubs that activate when features land:
- `parent_module` + `root_module` (parent modules not modeled yet)
- `previous` + `multi_select`, `previous` + `inline_search`

### `put_in_root` impact (not yet modeled)

When added: `'module'` becomes invalid (no menu), `'root'` diverges from
`'app_home'`, `'parent_module'` with a `put_in_root` parent is invalid.
Validation should auto-resolve `'module'` → `'root'` for `put_in_root`
modules.
```

- [ ] **Step 2: Update every other affected CLAUDE.md**

For each file listed above, read it, identify phase-history stanzas and stale references, rewrite to current state. Specific known cleanups:

- **Root `CLAUDE.md`:** the "Services Layer" reference becomes "CommCare boundary" at `lib/commcare/`. Update the architecture section's directory listing.
- **`lib/doc/CLAUDE.md`:** strip the `legacyBridge` section entirely. Add `fieldPath.ts`, `resetBuilder.ts`, `connectConfig.ts` to the public surface.
- **`lib/ui/CLAUDE.md`:** add toastStore, keyboardManager under "shared UI primitives".
- **`lib/agent/CLAUDE.md`:** replace `expandBlueprint` with `expandDoc`; delete `toBlueprint` mentions.
- **`lib/codemirror/CLAUDE.md`:** xpath parser moved to `lib/commcare/xpath/` — update.
- **`components/builder/CLAUDE.md`:** grep for `lib/services` references and rewrite.

- [ ] **Step 3: Verify + commit**

```bash
rg -l "lib/services|legacyBridge|legacyTypes|lib/transpiler|lib/schemas|lib/types|toBlueprint|expandBlueprint|CczCompiler|Phase \\d|Phase\\s+\\d" \
   lib/ components/ app/ --glob "*.md"
```

Expected: zero hits. Any remaining phase-history or stale reference is a failed cleanup.

```bash
git add -A
git commit -m "docs(phase-7): rewrite CLAUDE.md files to current-state truth"
```

---

## Task 24: Review every file header comment

**Why:** CLAUDE.md is read by agents. File headers are read by engineers skimming the codebase. Both must be accurate and present-tense.

- [ ] **Step 1: Sweep for phase references + migration notes**

```bash
rg -n "Phase [1-7]|phase \\d|phase-\\d|after Phase|before Phase|legacyBridge|legacyTypes|until Phase|Phase 7 dismantles|moved from|moved to|will be (moved|deleted)" \
   lib/ app/ components/ scripts/ --glob "*.ts" --glob "*.tsx"
```

Every hit → rewrite. Acceptable forms: a single-sentence "why this file exists" header, a comment explaining a non-obvious invariant, or nothing. Unacceptable: "moved here in Phase 3", "TODO when Phase 7 lands", "legacy shim — remove when X".

- [ ] **Step 2: Review CommCare-boundary file headers**

Every file under `lib/commcare/` should have a short header explaining its role in the boundary. Not the file's history — its place in the current architecture.

- [ ] **Step 3: Verify + commit**

```bash
rg -n "Phase [1-7]|phase \\d|legacyBridge|legacyTypes|until Phase" \
   lib/ app/ components/ scripts/ --glob "*.ts" --glob "*.tsx"
# Expect: zero.
git add -A
git commit -m "docs(phase-7): scrub phase history and migration notes from file headers"
```

---

## Task 25: Update `README.md` + root `CLAUDE.md`

- [ ] **Step 1: Review `README.md`**

Check for directory listings, setup instructions, script references. Update:
- Scripts section: remove migration scripts; list current `scripts/` contents.
- Any mention of `AppBlueprint`, wire format, `toBlueprint` → rewrite.

- [ ] **Step 2: Review root `CLAUDE.md`**

Already long (see file). Target: one additional paragraph under "Architecture" describing the `lib/commcare/` boundary as the single CommCare-facing package. Remove any lingering `lib/services/` references.

- [ ] **Step 3: Verify + commit**

```bash
git add -A
git commit -m "docs(phase-7): update README and root CLAUDE.md for post-Phase-7 structure"
```

---

## Task 26: Close the spec document

**Why:** The spec was an ambition doc. It's been delivered (or explicitly diverged from, where we improved on it). Leave a paragraph at the end explaining what shipped and what diverged so future readers aren't confused by the phase-row terseness.

- [ ] **Step 1: Append a "Shipped" section to `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`**

```md
---

## Shipped

Phase 7 landed on 2026-04-XX. The spec's original Phase 7 row described a
5-minute deletion pass; the actual Phase 7 delivered the compile-pipeline
rewrite to consume `BlueprintDoc` directly, eliminated the `legacyBridge`
compat layer and all migration scripts, populated `lib/commcare/` per §7,
enforced the boundary in Biome, and strengthened the compile-pipeline
test suite. See `docs/superpowers/plans/2026-04-20-phase-7-cleanup.md`
for the task list and `git log --grep "phase-7"` for the commit trail.

Divergences from the original spec:
- `lib/schemas/blueprint.ts` was never re-emitted as a public module —
  its content folded directly into `lib/domain/` in Phase 1.
- `lib/codemirror/` editor extensions stay where they are; only the
  XPath grammar + parser moved into `lib/commcare/xpath/` (the spec was
  ambiguous on editor-extension placement).
- `useFormEngine` was not deleted (§11) — Phase 5 turned it into a real
  preview-engine surface rather than an index-based shim. Phase 7 split
  it into single-responsibility hook files but kept the API.
- Migration scripts were deleted entirely rather than preserved; `git`
  is the system of record for historical one-time migrations.
```

Commit:

```bash
git add -A
git commit -m "docs(spec): close the builder-foundation spec with shipped note"
```

---

## Task 27: Final verification

- [ ] **Step 1: Every quality gate green**

```bash
npx tsc --noEmit && echo "✓ tsc"
npm run lint     && echo "✓ lint"
npm run build    && echo "✓ build"
npm test         && echo "✓ test"
npx tsx scripts/check-forbidden-identifiers.ts && echo "✓ forbidden-ids"
```

All five pass. If any fail → fix root cause, no suppressions.

- [ ] **Step 2: Walk every success criterion with concrete commands**

```bash
# #3 — no residual wire vocabulary identifiers outside lib/commcare/
rg -n "\\bQuestion\\b|case_property_on" lib/ components/ app/ \
   --glob '!lib/commcare/**' --glob '!components/chat/AskQuestionsCard.tsx'
# Expect: zero.

# #4 — wire-format shim types gone
rg -n "\\bAppBlueprint\\b|\\btoDoc\\b|\\btoBlueprint\\b|normalizedState|replaceForm|\\bnotify[A-Z]" \
   lib/ components/ app/ scripts/
# Expect: zero.

# #5 — lib/services gone
test ! -d lib/services && echo "✓ lib/services gone"

# #6 — /hooks/ gone (Phase 6)
test ! -d hooks && echo "✓ hooks/ gone"

# #7 — lib/log/replay.ts ≤ 50 lines
lines=$(wc -l < lib/log/replay.ts); [ "$lines" -le 50 ] && echo "✓ replay.ts $lines lines"

# #8 — component sizes
wc -l components/builder/FormSettingsPanel.tsx   # ≤ 200
wc -l components/builder/AppTree.tsx 2>/dev/null || \
  wc -l components/builder/appTree/*.tsx         # main tree ≤ 400

# Boundary allowlist — every lib/commcare import outside the allowlist is an error
npm run lint   # Biome flags any violation
```

- [ ] **Step 3: Adding-a-new-field-kind drill (criterion #12)**

Scaffold a hypothetical `likert` field kind:
1. Copy `lib/domain/fields/text.ts` to `lib/domain/fields/likert.ts`; rename the kind to `"likert"`.
2. Add `"likert"` to the `fieldKinds` tuple in `lib/domain/fields/index.ts`.
3. Add the schema + metadata to `fieldSchema` union + `fieldRegistry`.
4. Add an entry to `components/builder/editor/fieldEditorSchemas.ts`.
5. `npx tsc --noEmit && echo "✓"` — compiler branches complete.
6. `git restore .` — discard the drill.

If step 5 surfaces an exhaustiveness error anywhere — that's a spec violation. Find the missing `switch(kind)` and add the case.

- [ ] **Step 4: PR description**

Write the PR body with:
- A short summary of what shipped.
- The baseline-vs-after file counts from T1.
- The success-criteria verification output from Step 2.
- A link back to this plan file.
- A link back to the spec.

```bash
git status  # clean
```

No additional commit — the PR itself is the handoff artifact.

---

## Handoff

1. Self-code-review with superpowers:requesting-code-review.
2. `gh pr create` with the summary from T27 Step 4.
3. Merge into `main`.
4. `git worktree remove .worktrees/phase-7-final`.

The builder-foundation re-architecture spec is complete.
