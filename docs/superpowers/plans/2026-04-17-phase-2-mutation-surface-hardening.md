# Phase 2: Mutation Surface Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the doc store's write surface to one path (`applyMany`), decompose wholesale form replacements into fine-grained mutations, and introduce a first-class `convertField` mutation. Phase 2 of 7 from `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`.

**Architecture:** The doc store's public API shrinks to `applyMany(mutations): MutationResult[]` + hydration hooks (`load`, `beginAgentWrite`, `endAgentWrite`). Every reducer returns a typed result entry so callers that previously used `applyWithResult` read the metadata from the array position matching the dispatched mutation. The SA stream mapper (`mutationMapper.toDocMutations`) stops emitting `replaceForm` and instead produces the decomposed sequence the reducer would have internally — `updateForm` with a full-form patch, then `removeField` per top-level existing child (cascade kills descendants), then `addField` per incoming child in top-down tree order. Type conversions (text ↔ secret, int ↔ decimal, image ↔ audio, group ↔ repeat, etc.) become one atomic `convertField` mutation that runs the kind swap + option/key reconciliation under the reducer — no more remove-and-add dance, no more kind-patch-through-`updateField` that silently drops incompatible keys.

**Tech Stack:** TypeScript 5.x strict, Zod 4.x, Zustand + Immer + zundo, Vitest.

**Worktree:** `.worktrees/phase-2-mutation-surface-hardening` on branch `refactor/phase-2-mutation-surface-hardening` (already created from `origin/main` at commit `7bd94a6` — Phase 1 merge commit).

**Baseline:** 1122 tests green, tsc/lint/build clean at worktree head. Re-verify in Task 1 before starting.

**Architectural north star (from Phase 1's painful lesson):** Internal code runs on domain types (`Field`/`Form`/`Module`/`BlueprintDoc` from `@/lib/domain`) only. Wire formats (`BlueprintForm`, SA tool shapes) exist ONLY at real external boundaries. When touching `mutationMapper.ts` in this phase, DO NOT introduce new wire-format translators or "temporary" bridges. The only place `BlueprintForm` should appear is at the ingress of `mapFormContent` — everything the mapper emits is already in domain shape. If a subagent ever writes `toBlueprint` / `legacyAppBlueprintToDoc` / `xToY` helpers inside this phase's scope, that's a legacy bridge smell and the PR stops.

---

## Scope boundaries

IN SCOPE (this plan):

- Delete `replaceForm` from the `Mutation` union, the reducer, `useBlueprintMutations`, and every test. Rewrite `lib/generation/mutationMapper.ts::mapFormContent` to emit the decomposed mutation sequence through `applyMany`.
- Add a `convertField` mutation kind — atomic kind swap that reconciles per-kind required/optional keys (drops keys the target kind doesn't support, seeds keys the target kind requires). Wire it through the hook and rewire `ContextualEditorHeader`'s Convert Type submenu to dispatch it.
- Collapse the doc store's write surface: `applyMany(mutations: Mutation[]): MutationResult[]` becomes the only public write path. Delete `apply` and `applyWithResult`. Every hook method in `useBlueprintMutations` dispatches via `applyMany([mutation])`; the `renameField` / `moveField` hook methods read metadata out of the returned results array.
- Migrate every `.apply()` / `.applyWithResult()` call site across the codebase (mostly test files) to `.applyMany([...])` + array-destructuring for the result.
- Verify `notify*` mutations are absent from the public `Mutation` union (spec checklist — Phase 1 already folded the XPath rewrites into `renameField` / `moveField`; this task is documentary). The `notifyMoveRename` toast helper at `lib/doc/mutations/notify.ts` is NOT a mutation kind and is intentionally left in place — it's a UI effect, not state change.

OUT OF SCOPE (future phases):

- Phase 3: Tool schema generator + server-side mutation mapper + `lib/agent/` directory move.
- Phase 4: Event log unification (`lib/log/`).
- Phase 5: Declarative editor UI + component splits.
- Phase 6: Hook + lint hygiene, move `/hooks/` into `lib/`.
- Phase 7: Delete `lib/services/`, `lib/schemas/`, `lib/types/`, `lib/prompts/`, `lib/transpiler/`, `lib/codemirror/`.

---

## Bridge-smell guardrails (read before every task)

Subagents trained only on "what to do" invent bridges. Subagents trained on "why bridges betray the architecture" don't. The following patterns MUST NOT appear in any Phase 2 commit:

- A `toBlueprint(doc)` or `legacyDocToBlueprint(doc)` call in any non-test, non-wire-boundary file. Wire format is allowed at the SA's stream ingress (`mapFormContent`) and nowhere else.
- A "keep `replaceForm` as an internal helper that `applyMany` delegates to" rationale. `replaceForm` is deleted, not hidden. If you find yourself reaching for it, your decomposition is wrong.
- A "for now, keep `apply` as a private internal so tests don't break" rationale. Tests are updated to use `applyMany`; the store API has one public write path.
- A `// TODO: replace this shim in Phase 3` comment. Phase 2's end state is complete; no deferred cleanups.
- An `as any` or `@ts-expect-error` to paper over a type mismatch from the new `applyMany` return shape. Type the new shape properly and thread it through.

If you hit a spot where it looks like one of these is the "easy fix," stop and trace the constraint: the decomposition, the result-typing, or the reducer contract is where the real answer lives.

---

## File structure

### Files to modify

| File | Change |
|------|--------|
| `lib/doc/types.ts` | Remove `replaceForm` from the `Mutation` union. Add `convertField`. Export a new `MutationResult` type (discriminated on kind; carries `FieldRenameMeta` for rename, `MoveFieldResult` for move, `undefined` for everything else). |
| `lib/doc/mutations/index.ts` | Change `applyMutation` / `applyMutations` return signatures to produce `MutationResult` / `MutationResult[]`. Drop the `replaceForm` dispatch case. Add the `convertField` dispatch case (routes to `applyFieldMutation`). |
| `lib/doc/mutations/forms.ts` | Delete the `replaceForm` branch. Narrow the `mut` type parameter to exclude it. |
| `lib/doc/mutations/fields.ts` | Add `convertField` branch in `applyFieldMutation`. Its implementation calls a new helper `reconcileFieldForKind(field, toKind)` that returns a normalized Field of the target kind (seeded defaults for required keys, dropped keys the target doesn't support). |
| `lib/doc/mutations/helpers.ts` | Add `reconcileFieldForKind` helper (pure; reads `fieldSchema` for the target kind, merges current field data, strips incompatible keys, seeds required defaults). |
| `lib/doc/store.ts` | Delete `apply` and `applyWithResult` from `BlueprintDocState`. Change `applyMany`'s signature from `void` to `MutationResult[]`. The action collects each reducer's return value as it loops. `load`, `beginAgentWrite`, `endAgentWrite` unchanged. |
| `lib/doc/hooks/useBlueprintMutations.ts` | Delete `replaceForm` method. Add `convertField(uuid: Uuid, toKind: FieldKind)` method. Every method (except `applyMany` passthrough) now dispatches via `store.getState().applyMany([mutation])`; `renameField` / `moveField` destructure the single-element result array to extract metadata. Delete the internal `dispatch` lambda that called `.apply()`. |
| `lib/generation/mutationMapper.ts` | Rewrite `mapFormContent`: no more `replaceForm` emission. Emit `updateForm` with the full replacement patch (every form-level property explicitly set, including explicit `undefined` for values being cleared), then `removeField` per top-level existing field in `doc.fieldOrder[formUuid]`, then `addField` per incoming field in top-down tree order (parents precede children). Drop the unused `BlueprintForm` → `Field[]` flattener? NO — keep `flattenFormQuestions` (renamed to `flattenWireQuestionsToFields` for clarity) as an internal helper producing `{ parentUuid, field }[]` that `mapFormContent` consumes. |
| `components/builder/contextual/ContextualEditorHeader.tsx` | The Convert Type submenu's `onSelect={(next) => saveField("kind", next)}` changes to `onSelect={(next) => convertField(asUuid(selectedUuid), next)}`. Pull `convertField` from `useBlueprintMutations()`. |

### Test files to modify

| File | Change |
|------|--------|
| `lib/doc/__tests__/mutations-forms.test.ts` | Remove every `replaceForm` describe block. The decomposed behavior is tested via `mutationMapper.test.ts` (at the emission boundary) + a new `mutations-fields.test.ts` test for `convertField`. |
| `lib/doc/__tests__/mutations-fields-*.test.ts` | Add a new `mutations-fields-convertField.test.ts` covering text↔secret, int↔decimal, date↔time, single_select↔multi_select (options preserved), image↔audio (media subkind swap), group↔repeat, and invalid conversions (reducer no-ops). |
| `lib/doc/__tests__/store.test.ts` | Replace every `store.getState().apply({...})` with `store.getState().applyMany([{...}])`. Add new tests for `applyMany` return shape (empty array for no-result mutations, `FieldRenameMeta` for rename, `MoveFieldResult` for move). Delete any `applyWithResult` coverage. |
| `lib/doc/__tests__/hooks.test.tsx` | Replace `.apply(...)` usages with `.applyMany([...])`. |
| `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx` | Delete `replaceForm` describe block. Add `convertField` describe block covering the hook's pre-check + dispatch path. |
| `lib/doc/__tests__/mutations-fields-move-xpath.test.ts` | Replace `.apply(...)` setup calls with `.applyMany([...])`. |
| `lib/doc/__tests__/fieldParent.test.ts` | Already uses `applyMany` — verify after refactor; update any `replaceForm` reference if present. |
| `lib/generation/__tests__/mutationMapper.test.ts` | Rewrite `describe("data-form-done")` + siblings to assert the decomposed mutation sequence (updateForm + removeField × N_old + addField × N_new). Add a test where the form was initially empty (all adds, no removes). Add a test where the form had an existing subtree that gets wiped. Add a test where the incoming payload has a nested group — confirms parent-before-child ordering. |
| `lib/generation/__tests__/generationLifecycle.test.ts` | Migrate the one `.apply(...)` call to `.applyMany([...])`. |
| `lib/preview/engine/__tests__/engineController.test.ts` | Migrate three `.apply(...)` calls to `.applyMany([...])`. |
| `lib/routing/__tests__/builderActions-useUndoRedo.test.tsx` | Migrate five `.apply(...)` calls. |
| `lib/routing/__tests__/builderActions-useDeleteSelectedField.test.tsx` | Migrate two `.apply(...)` calls. |
| `lib/routing/__tests__/LocationRecoveryEffect.test.tsx` | Migrate one `.apply(...)` call. |
| `lib/session/__tests__/store.test.ts` | Migrate two `.apply(...)` calls. |
| `components/preview/form/virtual/__tests__/useFormRows.test.tsx` | Migrate one `.apply(...)` call. |

### Files that do NOT change

- `lib/doc/mutations/notify.ts` — `notifyMoveRename` is a toast emitter, not a mutation. Stays. Callsites (`VirtualFormList.tsx`, `useBuilderShortcuts.ts`) continue calling it with the `MoveFieldResult` they read out of the `applyMany` return array.
- `lib/doc/mutations/pathRewrite.ts` — XPath rewrite helper, reducer-internal. No change.
- `lib/doc/fieldParent.ts` — reverse-index rebuilder. No change.
- `lib/generation/streamDispatcher.ts` — already calls `applyMany`. No change.

---

## Task 1: Baseline verification in worktree

**Files:** (no changes — verification only)

The worktree `.worktrees/phase-2-mutation-surface-hardening` already exists at `origin/main` (commit `7bd94a6` — Phase 1 merge). Verify clean baseline before starting.

- [ ] **Step 1: Confirm worktree + branch**

```bash
cd /Users/braxtonperry/work/personal/code/commcare-nova/.worktrees/phase-2-mutation-surface-hardening
git status
git log --oneline -1
```

Expected: branch `refactor/phase-2-mutation-surface-hardening`, HEAD at `7bd94a6 refactor: phase 1 — domain layer + rename + normalized Firestore (#3)`, working tree clean aside from this plan document.

- [ ] **Step 2: Type-check, lint, build, test — all must pass**

```bash
npx tsc --noEmit && echo "✓ tsc clean"
npm run lint && echo "✓ lint clean"
npm test -- --run
npm run build && echo "✓ build clean"
```

Expected passing count: **1122 tests across 61 files**. Record the exact number; Task 10 gates on ≥ this number.

- [ ] **Step 3: Commit a baseline marker**

The plan document itself was committed before this task list was handed off. Just record a baseline marker so later verification commits have a reference point.

```bash
git commit --allow-empty -m "chore: phase 2 baseline marker (1122 tests)"
```

---

## Task 2: Define `MutationResult` type + adjust reducer signatures

Lays the type foundation for the new `applyMany` return shape. No behavior change yet — existing `apply` / `applyWithResult` still work.

**Files:**
- Modify: `lib/doc/types.ts`
- Modify: `lib/doc/mutations/index.ts`

- [ ] **Step 1: Extend `lib/doc/types.ts` with the `MutationResult` type**

Replace the file's contents after the existing `Mutation` union export block with the new type. The `Mutation` union itself is NOT changed in this task — `replaceForm` is still present; that's Task 5's job.

```ts
// Append to lib/doc/types.ts (after the Mutation union definition)

import type {
	FieldRenameMeta,
	MoveFieldResult,
} from "@/lib/doc/mutations/fields";

/**
 * Per-mutation result returned by the reducer.
 *
 * `applyMany(mutations)` returns `MutationResult[]` — one entry per input
 * mutation, same order. Most mutation kinds produce `undefined`; the two
 * that surface actionable metadata are:
 *   - `renameField`: `FieldRenameMeta` with the XPath-rewrite count
 *   - `moveField`: `MoveFieldResult` with cross-level auto-rename info
 *
 * Keeping this as a single union (rather than a positionally-typed tuple
 * or a generic-per-mutation result) keeps the public API flat and easy to
 * type at call sites. Callers that care about metadata destructure the
 * known position and narrow by `typeof` / kind check.
 */
export type MutationResult = FieldRenameMeta | MoveFieldResult | undefined;

export type { FieldRenameMeta, MoveFieldResult };
```

- [ ] **Step 2: Update `lib/doc/mutations/index.ts` signatures**

Change the internal dispatcher + public entry points to return `MutationResult` / `MutationResult[]`. The existing behavior (rebuild `fieldParent` after reducers run; batch version rebuilds once at the end) is preserved.

Replace the file body's top-of-file comment + the three exported functions. Key signature changes:

```ts
export function applyMutation(
	draft: Draft<BlueprintDoc>,
	mut: Mutation,
): MutationResult {
	const result = dispatchMutation(draft, mut);
	rebuildFieldParent(draft as unknown as BlueprintDoc);
	return result;
}

export function applyMutations(
	draft: Draft<BlueprintDoc>,
	muts: Mutation[],
): MutationResult[] {
	const results: MutationResult[] = [];
	for (const mut of muts) {
		results.push(dispatchMutation(draft, mut));
	}
	rebuildFieldParent(draft as unknown as BlueprintDoc);
	return results;
}
```

Update `dispatchMutation`'s return type from `MoveFieldResult | FieldRenameMeta | undefined` to `MutationResult` (same set, just the named alias).

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit && echo "✓ tsc clean"
```

Expected: clean. `applyWithResult` in `store.ts` already narrows via overloads that return `MoveFieldResult | undefined` / `FieldRenameMeta | undefined` — those overloads are compatible with the new `MutationResult` alias because `MutationResult` is their union.

- [ ] **Step 4: Run existing tests — no behavior change expected**

```bash
npm test -- --run
```

Expected: 1122 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add lib/doc/types.ts lib/doc/mutations/index.ts
git commit -m "refactor(doc): introduce MutationResult type; typed reducer return"
```

---

## Task 3: Add `convertField` mutation — reducer + helper

Introduces the `convertField` mutation kind with a pure reconciliation helper. No caller wiring yet.

**Files:**
- Modify: `lib/doc/types.ts`
- Modify: `lib/doc/mutations/index.ts`
- Modify: `lib/doc/mutations/fields.ts`
- Modify: `lib/doc/mutations/helpers.ts`
- Create: `lib/doc/__tests__/mutations-fields-convertField.test.ts`

- [ ] **Step 1: Add `convertField` to the `Mutation` union**

In `lib/doc/types.ts`, inside the `Mutation` union, add the new kind alongside the Field mutations block:

```ts
	// Field
	| { kind: "addField"; parentUuid: Uuid; field: Field; index?: number }
	| { kind: "removeField"; uuid: Uuid }
	| { kind: "moveField"; uuid: Uuid; toParentUuid: Uuid; toIndex: number }
	| { kind: "renameField"; uuid: Uuid; newId: string }
	| { kind: "duplicateField"; uuid: Uuid }
	| { kind: "updateField"; uuid: Uuid; patch: FieldPatch }
	| { kind: "convertField"; uuid: Uuid; toKind: FieldKind }
```

Make sure `FieldKind` is imported from `@/lib/domain` at the top of the file.

- [ ] **Step 2: Add the reconciliation helper to `lib/doc/mutations/helpers.ts`**

Append:

```ts
import { fieldSchema, type Field, type FieldKind } from "@/lib/domain";

/**
 * Produce a normalized `Field` of `toKind` seeded from `source`.
 *
 * Reconciliation rules — applied in this order:
 *   1. Start with the source field's shared identity (`uuid`, `id`, `label`).
 *   2. Carry over any property whose key exists on BOTH kinds (validation,
 *      relevancy, required, case_property, calculate, default_value, hint
 *      — depending on what the destination kind accepts).
 *   3. Stamp the new `kind` discriminator.
 *   4. Run the result through `fieldSchema.safeParse` to strip keys the
 *      destination kind doesn't recognize and validate values.
 *   5. If parsing fails (e.g. destination kind requires a key the source
 *      doesn't have), return `undefined`. Callers treat that as "abort
 *      the conversion" (reducer logs a warning and no-ops).
 *
 * Why `fieldSchema.safeParse` instead of a hand-rolled per-kind table:
 * the Zod schemas are already the single source of truth for which keys
 * each kind accepts. A parallel table here would drift. The schema's
 * default behavior (strip unknowns, reject invalid types) is exactly the
 * reconciliation policy we want.
 *
 * Special cases:
 *   - `single_select` ↔ `multi_select`: `options` transfers verbatim.
 *   - `text` ↔ `secret`: no options, no calculate on secret — validate/
 *     relevant/required/hint/case_property carry over.
 *   - Media subkinds (image/audio/video/signature): only identity + label
 *     carries over; binary capture has no XPath fields in the schema today.
 *   - `group` ↔ `repeat`: container; only identity + label + relevant
 *     carry over. Children are untouched — they stay in `fieldOrder`
 *     under the same parent uuid, which is still a valid container after
 *     the kind swap.
 */
export function reconcileFieldForKind(
	source: Field,
	toKind: FieldKind,
): Field | undefined {
	// Build a candidate object from the source with the new discriminant.
	// Spread source first so its keys populate; override `kind` last.
	const candidate = { ...source, kind: toKind };
	const result = fieldSchema.safeParse(candidate);
	if (!result.success) {
		return undefined;
	}
	return result.data;
}
```

- [ ] **Step 3: Add the `convertField` reducer branch in `lib/doc/mutations/fields.ts`**

Inside `applyFieldMutation`, widen the `mut` extract type to include `"convertField"` and add the case at the end of the switch:

```ts
		case "convertField": {
			const field = draft.fields[mut.uuid];
			if (!field) return;
			// No-op if the kind is already the target (treat as idempotent).
			if (field.kind === mut.toKind) return;
			const reconciled = reconcileFieldForKind(field, mut.toKind);
			if (!reconciled) {
				// Reconciliation failed — the target kind requires a key the
				// source doesn't have (e.g. converting a group to single_select,
				// which needs `options`). Log and skip; UI should have gated
				// this via `getConvertibleTypes` already.
				console.warn(
					`convertField: cannot reconcile ${field.kind} → ${mut.toKind}`,
					{ uuid: mut.uuid, field },
				);
				return;
			}
			// Preserve the stable uuid — `reconcileFieldForKind` already
			// carries it through, but re-stamp defensively so a future
			// helper refactor can't silently drop it.
			reconciled.uuid = mut.uuid;
			draft.fields[mut.uuid] = reconciled;
			return;
		}
```

Import `reconcileFieldForKind` from `./helpers` at the top of `fields.ts`.

- [ ] **Step 4: Route `convertField` in the dispatcher**

In `lib/doc/mutations/index.ts`, add `"convertField"` to the Field mutations case block:

```ts
		case "addField":
		case "removeField":
		case "moveField":
		case "renameField":
		case "duplicateField":
		case "updateField":
		case "convertField":
			return applyFieldMutation(draft, mut);
```

- [ ] **Step 5: Write the reducer tests**

Create `lib/doc/__tests__/mutations-fields-convertField.test.ts`:

```ts
/**
 * Reducer tests for the `convertField` mutation.
 *
 * Covers the six conversion families defined in `lib/fieldTypeConversions.ts`
 * plus the invariants: uuid preserved, id/label preserved, incompatible
 * keys dropped, options transferred where both kinds accept them,
 * no-op when the kind is already the target.
 */

import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { applyMutation } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";

function docWithField(field: Parameters<typeof f>[0]) {
	return buildDoc({
		appId: "app-1",
		modules: [
			{
				uuid: "m-1",
				name: "M",
				forms: [
					{
						uuid: "form-1",
						name: "F",
						type: "registration",
						fields: [f(field)],
					},
				],
			},
		],
	});
}

describe("convertField", () => {
	it("text → secret preserves id, label, required, hint, validate", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "text",
			id: "pin",
			label: "PIN",
			required: "true()",
			hint: "four digits",
			validate: "string-length(.) = 4",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "secret",
			});
		});
		const converted = next.fields[asUuid("q-1")];
		expect(converted.kind).toBe("secret");
		expect(converted.id).toBe("pin");
		expect(converted.label).toBe("PIN");
		expect(converted.uuid).toBe("q-1");
		expect((converted as { hint?: string }).hint).toBe("four digits");
	});

	it("single_select → multi_select preserves options", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "single_select",
			id: "color",
			label: "Color",
			options: [
				{ value: "r", label: "Red" },
				{ value: "b", label: "Blue" },
			],
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "multi_select",
			});
		});
		const converted = next.fields[asUuid("q-1")];
		expect(converted.kind).toBe("multi_select");
		expect(
			(converted as { options?: Array<{ value: string }> }).options,
		).toHaveLength(2);
	});

	it("int → decimal preserves numeric validation", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "int",
			id: "age",
			label: "Age",
			validate: ". > 0",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "decimal",
			});
		});
		expect(next.fields[asUuid("q-1")].kind).toBe("decimal");
		expect(
			(next.fields[asUuid("q-1")] as { validate?: string }).validate,
		).toBe(". > 0");
	});

	it("group → repeat preserves children (fieldOrder untouched)", () => {
		const doc = buildDoc({
			appId: "app-1",
			modules: [
				{
					uuid: "m-1",
					name: "M",
					forms: [
						{
							uuid: "form-1",
							name: "F",
							type: "registration",
							fields: [
								f({
									uuid: "g-1",
									kind: "group",
									id: "demographics",
									label: "Demographics",
									children: [
										f({
											uuid: "c-1",
											kind: "text",
											id: "name",
											label: "Name",
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("g-1"),
				toKind: "repeat",
			});
		});
		expect(next.fields[asUuid("g-1")].kind).toBe("repeat");
		expect(next.fieldOrder[asUuid("g-1")]).toEqual([asUuid("c-1")]);
		expect(next.fields[asUuid("c-1")]).toBeDefined();
	});

	it("no-op when the kind is already the target", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "text",
			id: "pin",
			label: "PIN",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("q-1"),
				toKind: "text",
			});
		});
		expect(next.fields[asUuid("q-1")]).toBe(doc.fields[asUuid("q-1")]);
	});

	it("skips when the source uuid is unknown", () => {
		const doc = docWithField({
			uuid: "q-1",
			kind: "text",
			id: "pin",
			label: "PIN",
		});
		const next = produce(doc, (d) => {
			applyMutation(d, {
				kind: "convertField",
				uuid: asUuid("does-not-exist"),
				toKind: "secret",
			});
		});
		expect(next.fields).toEqual(doc.fields);
	});
});
```

- [ ] **Step 6: Run the new tests**

```bash
npm test -- lib/doc/__tests__/mutations-fields-convertField.test.ts --run
```

Expected: all tests pass.

- [ ] **Step 7: Run the full suite — no existing test should regress**

```bash
npm test -- --run
```

Expected: 1128 tests (was 1122, +6 new).

- [ ] **Step 8: Commit**

```bash
git add lib/doc/types.ts lib/doc/mutations/index.ts lib/doc/mutations/fields.ts lib/doc/mutations/helpers.ts lib/doc/__tests__/mutations-fields-convertField.test.ts
git commit -m "feat(doc): add convertField mutation for atomic kind swap"
```

---

## Task 4: Wire `convertField` through the hook + UI

**Files:**
- Modify: `lib/doc/hooks/useBlueprintMutations.ts`
- Modify: `components/builder/contextual/ContextualEditorHeader.tsx`
- Modify: `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`

- [ ] **Step 1: Add `convertField` to the hook's public interface**

In `lib/doc/hooks/useBlueprintMutations.ts`, add the method to the `BlueprintMutations` interface alongside the other field mutations:

```ts
	/**
	 * Convert a field to a different kind atomically.
	 *
	 * Unlike the ad-hoc `saveField("kind", ...)` path it replaces, this
	 * dispatches a `convertField` mutation that runs the kind swap inside
	 * the reducer — one atomic undo entry, one clean event log entry, and
	 * the schema-driven key reconciliation handles options / validation /
	 * hint preservation per kind's Zod schema.
	 *
	 * Silently no-ops when the uuid is unknown or when the source kind
	 * equals the target kind.
	 */
	convertField: (uuid: Uuid, toKind: FieldKind) => void;
```

- [ ] **Step 2: Implement `convertField` inside the `useMemo` body**

Add after `duplicateField`:

```ts
			convertField(uuid, toKind) {
				const doc = get();
				if (!doc.fields[uuid]) {
					warnUnresolved("convertField", { uuid });
					return;
				}
				dispatch({ kind: "convertField", uuid, toKind });
			},
```

(`dispatch` is the internal `(mut) => store.getState().apply(mut)` lambda. Task 7 replaces it with `applyMany`.)

- [ ] **Step 3: Rewire `ContextualEditorHeader`**

Replace the Convert Type submenu's `onSelect` callback. Open `components/builder/contextual/ContextualEditorHeader.tsx`, find the `FieldTypeList` inside the Convert Type submenu (around line 438), and change:

```tsx
// BEFORE
<FieldTypeList
	types={conversionTargets}
	activeType={field.kind}
	onSelect={(next) => saveField("kind", next)}
/>
```

to:

```tsx
// AFTER
<FieldTypeList
	types={conversionTargets}
	activeType={field.kind}
	onSelect={(next) => convertField(asUuid(selectedUuid), next)}
/>
```

Destructure `convertField` from `useBlueprintMutations()` alongside the other actions (line 84 area).

- [ ] **Step 4: Delete the obsolete comment referencing `saveField("kind", ...)`**

The lines above the `FieldTypeList` call reference `saveField`'s `updateField` routing through the `kind` discriminant. Replace with:

```tsx
{/* `convertField` dispatches a single atomic mutation — the reducer
 *  swaps the kind and reconciles per-kind properties via `fieldSchema`.
 *  Previously this used `saveField("kind", ...)` which relied on Zod
 *  strip to drop incompatible keys; the dedicated mutation is cleaner
 *  for undo history and event logging. */}
```

- [ ] **Step 5: Add hook tests**

In `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`, add a `describe("convertField")` block covering:
- dispatches the expected mutation (assert via a store spy or via reading doc state)
- no-ops when uuid is unknown
- kind swap is visible in subsequent `useField` / `getState()` reads

Use the existing fixture pattern in the file.

- [ ] **Step 6: Run tests**

```bash
npm test -- lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx --run
npm test -- --run
```

Expected: new tests pass, full suite green.

- [ ] **Step 7: Smoke test in dev**

```bash
npm run dev
```

Open an app, select a text field, open the header action menu → Convert Type → "Secret". Verify the field converts, the change is undoable (ctrl+z reverts in one step), and the label/id survive.

- [ ] **Step 8: Commit**

```bash
git add lib/doc/hooks/useBlueprintMutations.ts components/builder/contextual/ContextualEditorHeader.tsx lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx
git commit -m "feat(builder): wire convertField through hook + Convert Type submenu"
```

---

## Task 5: Rewrite `mutationMapper.mapFormContent` to emit decomposed mutations

This is the big semantic change — the SA stream stops producing `replaceForm` and starts producing fine-grained sequences. `replaceForm` itself is still present in the reducer for this task; it's deleted in Task 6.

**Files:**
- Modify: `lib/generation/mutationMapper.ts`
- Modify: `lib/generation/__tests__/mutationMapper.test.ts`

- [ ] **Step 1: Rename `flattenFormQuestions` → `flattenWireQuestionsToFields` and change its return shape**

The current helper side-effects `fields` and `fieldOrder`. Rework it to return an array of `{ parentUuid, field, index }` tuples in top-down tree order. That shape is what `mapFormContent` needs to emit `addField` mutations directly.

```ts
/**
 * Flat list of (parent, field, index) tuples describing the incoming
 * form's field subtree. Produced in top-down order so `addField`
 * mutations can be emitted in array order — parents always land before
 * their children. Children of the form root carry `parentUuid === formUuid`;
 * children of a group/repeat carry `parentUuid === containerUuid`.
 *
 * `index` is the sibling index within the parent (0-based). `addField`
 * reducer accepts an optional `index`; we emit it explicitly to pin
 * ordering under sequential `addField` dispatches.
 */
interface PendingFieldAdd {
	parentUuid: Uuid;
	field: Field;
	index: number;
}

function flattenWireQuestionsToFields(
	questions: ReadonlyArray<WireQuestion>,
	parentUuid: Uuid,
	acc: PendingFieldAdd[],
): void {
	questions.forEach((q, index) => {
		const uuid = asUuid(q.uuid);
		const fieldObj: Record<string, unknown> = {
			kind: q.type,
			uuid,
			id: q.id,
			label: q.label ?? "",
			...(q.case_property_on != null && { case_property: q.case_property_on }),
			...(q.hint != null && { hint: q.hint }),
			...(q.required != null && { required: q.required }),
			...(q.relevant != null && { relevant: q.relevant }),
			...(q.validation != null && { validate: q.validation }),
			...(q.validation_msg != null && { validate_msg: q.validation_msg }),
			...(q.calculate != null && { calculate: q.calculate }),
			...(q.default_value != null && { default_value: q.default_value }),
			...(q.options != null && { options: q.options }),
		};
		acc.push({ parentUuid, field: fieldObj as Field, index });
		if (q.children?.length && (q.type === "group" || q.type === "repeat")) {
			flattenWireQuestionsToFields(q.children as WireQuestion[], uuid, acc);
		}
	});
}
```

Define `WireQuestion` as a local interface at the top of the helper — the wire format is the only place `type` (vs `kind`) and `case_property_on` (vs `case_property`) still appear, so this is the one boundary that knows about both vocabularies:

```ts
/**
 * Wire-format question shape as received from the SA stream.
 *
 * Mirrors today's inline parameter shape of the pre-rewrite
 * `flattenFormQuestions`. CommCare's vocabulary (`type`, `case_property_on`,
 * `validation`, `validation_msg`) survives ONLY here — every downstream
 * mutation carries the domain names (`kind`, `case_property`, `validate`,
 * `validate_msg`).
 */
interface WireQuestion {
	uuid: string;
	id: string;
	type: string;
	label?: string;
	hint?: string;
	required?: string;
	relevant?: string;
	validation?: string;
	validation_msg?: string;
	calculate?: string;
	default_value?: string;
	options?: Array<{ value: string; label: string }>;
	case_property_on?: string;
	children?: WireQuestion[];
}
```

- [ ] **Step 2: Rewrite `mapFormContent` to emit the decomposed sequence**

Replace the entire function body:

```ts
function mapFormContent(
	data: Record<string, unknown>,
	doc: BlueprintDoc,
): Mutation[] {
	const moduleIndex = data.moduleIndex as number;
	const formIndex = data.formIndex as number;
	const form = data.form as BlueprintForm;

	const moduleUuid = doc.moduleOrder[moduleIndex];
	if (!moduleUuid) return [];
	const formUuid = doc.formOrder[moduleUuid]?.[formIndex];
	if (!formUuid) return [];

	const existingForm = doc.forms[formUuid];

	/*
	 * Build the form-level patch. We emit every mutable form-level property
	 * explicitly — present values set the new state, absent values become
	 * `undefined` so the reducer's `Object.assign` clears them. This
	 * preserves the wholesale-replace semantics the old `replaceForm`
	 * mutation provided at the form-entity level.
	 *
	 * `purpose` is NOT in the patch — it's set during scaffold and the
	 * SA's `BlueprintForm` wire payload doesn't carry it. Omission leaves
	 * the existing value in place (what the old `replaceForm` also did,
	 * via the re-stamp dance).
	 */
	const formPatch: Partial<Omit<Form, "uuid" | "purpose">> = {
		// Forms carry a semantic id slug; preserve the scaffold slug when
		// present, else derive one. `id` DOES belong in the patch because
		// it's a mutable form-level property.
		id: existingForm?.id ?? (slugify(form.name) || "form"),
		name: form.name,
		type: form.type as FormType,
		closeCondition: form.close_condition
			? {
					field: form.close_condition.question,
					answer: form.close_condition.answer,
					...(form.close_condition.operator && {
						operator: form.close_condition.operator,
					}),
				}
			: undefined,
		connect: form.connect ?? undefined,
		postSubmit: form.post_submit,
	};

	const mutations: Mutation[] = [];
	mutations.push({ kind: "updateForm", uuid: formUuid, patch: formPatch });

	/*
	 * Wipe the existing field subtree. We only emit `removeField` for the
	 * top-level children — the reducer cascades down into group/repeat
	 * descendants via `cascadeDeleteField`. Reading from `doc.fieldOrder`
	 * (snapshot) gives us the authoritative top-level list.
	 */
	const existingTopLevel = doc.fieldOrder[formUuid] ?? [];
	for (const childUuid of existingTopLevel) {
		mutations.push({ kind: "removeField", uuid: childUuid });
	}

	/*
	 * Add every incoming field. Order matters: a group/repeat parent must
	 * be added BEFORE its children so the child's `addField` reducer finds
	 * the parent entity in the draft (the reducer pre-seeds an empty
	 * `fieldOrder` slot for new containers). `flattenWireQuestionsToFields`
	 * produces the tree in top-down order, so emitting in list order is
	 * correct.
	 */
	const pending: PendingFieldAdd[] = [];
	flattenWireQuestionsToFields(
		(form.questions ?? []) as WireQuestion[],
		formUuid,
		pending,
	);
	for (const { parentUuid, field, index } of pending) {
		mutations.push({ kind: "addField", parentUuid, field, index });
	}

	return mutations;
}
```

Remove the now-unused local `replacementForm: Form` builder and the `fields: Field[]` / `fieldOrder: Record<Uuid, Uuid[]>` assembly from the old implementation.

- [ ] **Step 3: Update `lib/generation/__tests__/mutationMapper.test.ts`**

Rewrite the `describe("data-form-done")`, `describe("data-form-fixed")`, and `describe("data-form-updated")` blocks. Each test that previously asserted `kind === "replaceForm"` now asserts the decomposed sequence. For example:

```ts
it("decomposes data-form-done into updateForm + addFields (empty existing form)", () => {
	const doc = buildDocWithOneModuleOneFormEmpty();
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];

	const mutations = toDocMutations(
		"data-form-done",
		{
			moduleIndex: 0,
			formIndex: 0,
			form: {
				name: "Registration",
				type: "registration",
				questions: [
					{
						uuid: "q-1",
						type: "text",
						id: "name",
						label: "Name",
					},
					{
						uuid: "q-2",
						type: "int",
						id: "age",
						label: "Age",
					},
				],
			} satisfies BlueprintForm,
		},
		doc,
	);

	// Expected shape: 1 updateForm + 0 removeField + 2 addField = 3
	expect(mutations).toHaveLength(3);

	assert(mutations[0].kind === "updateForm");
	expect(mutations[0].uuid).toBe(formUuid);
	expect(mutations[0].patch.name).toBe("Registration");
	expect(mutations[0].patch.type).toBe("registration");

	assert(mutations[1].kind === "addField");
	expect(mutations[1].parentUuid).toBe(formUuid);
	expect(mutations[1].field.id).toBe("name");
	expect(mutations[1].index).toBe(0);

	assert(mutations[2].kind === "addField");
	expect(mutations[2].field.id).toBe("age");
	expect(mutations[2].index).toBe(1);
});

it("decomposes with removes when the existing form had fields", () => {
	const doc = buildDocWithOneModuleOneForm(); // existing q-uuid-1
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const mutations = toDocMutations(
		"data-form-updated",
		{
			moduleIndex: 0,
			formIndex: 0,
			form: {
				name: "Registration",
				type: "registration",
				questions: [
					{ uuid: "new-q-1", type: "text", id: "name", label: "Name" },
				],
			} satisfies BlueprintForm,
		},
		doc,
	);
	// 1 updateForm + 1 removeField (q-uuid-1) + 1 addField (new-q-1) = 3
	expect(mutations).toHaveLength(3);
	assert(mutations[0].kind === "updateForm");
	assert(mutations[1].kind === "removeField");
	expect(mutations[1].uuid).toBe("q-uuid-1");
	assert(mutations[2].kind === "addField");
});

it("emits parent before children for nested groups", () => {
	const doc = buildDocWithOneModuleOneFormEmpty();
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const mutations = toDocMutations(
		"data-form-done",
		{
			moduleIndex: 0,
			formIndex: 0,
			form: {
				name: "Nested",
				type: "registration",
				questions: [
					{
						uuid: "g-1",
						type: "group",
						id: "demographics",
						label: "Demographics",
						children: [
							{
								uuid: "c-1",
								type: "text",
								id: "name",
								label: "Name",
							},
						],
					},
				],
			} satisfies BlueprintForm,
		},
		doc,
	);

	// 1 updateForm + 0 removes + 2 addFields (group, then child)
	expect(mutations).toHaveLength(3);
	assert(mutations[1].kind === "addField");
	expect(mutations[1].field.uuid).toBe("g-1");
	expect(mutations[1].parentUuid).toBe(formUuid);
	assert(mutations[2].kind === "addField");
	expect(mutations[2].field.uuid).toBe("c-1");
	expect(mutations[2].parentUuid).toBe("g-1");
});
```

Delete every assertion that references `kind === "replaceForm"`. The `preserves purpose` test becomes: assert that the `updateForm` patch does NOT include `purpose`, and confirm via a separate setup (build a doc, apply the mutations manually via `applyMany`, observe `doc.forms[formUuid].purpose` is untouched).

- [ ] **Step 4: Run the mutation mapper tests**

```bash
npm test -- lib/generation/__tests__/mutationMapper.test.ts --run
```

Expected: all pass.

- [ ] **Step 5: Run the full suite**

```bash
npm test -- --run
```

Expected: 1128+ tests still passing. The `lib/doc/__tests__/mutations-forms.test.ts` `replaceForm` tests are still in place (Task 6 removes them); they still pass because the reducer hasn't been touched yet.

- [ ] **Step 6: Commit**

```bash
git add lib/generation/mutationMapper.ts lib/generation/__tests__/mutationMapper.test.ts
git commit -m "refactor(generation): decompose mapFormContent into fine-grained mutations"
```

---

## Task 6: Delete `replaceForm` mutation

Now that no caller emits `replaceForm`, rip it out of the reducer, the Mutation union, the hook, and the tests. This is a pure deletion pass — no behavior change, just dead-code removal.

**Files:**
- Modify: `lib/doc/types.ts`
- Modify: `lib/doc/mutations/index.ts`
- Modify: `lib/doc/mutations/forms.ts`
- Modify: `lib/doc/hooks/useBlueprintMutations.ts`
- Modify: `lib/doc/__tests__/mutations-forms.test.ts`
- Modify: `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`

- [ ] **Step 1: Remove `replaceForm` from the `Mutation` union**

Delete these lines in `lib/doc/types.ts`:

```ts
	| {
			kind: "replaceForm";
			uuid: Uuid;
			form: Form;
			fields: Field[];
			fieldOrder: Record<Uuid, Uuid[]>;
	  }
```

Verify `Field` is still imported (it's used elsewhere in the union — grep to confirm).

- [ ] **Step 2: Remove `replaceForm` from the dispatcher**

In `lib/doc/mutations/index.ts`, drop `replaceForm` from the form case:

```ts
		case "addForm":
		case "removeForm":
		case "moveForm":
		case "renameForm":
		case "updateForm":
			applyFormMutation(draft, mut);
			return;
```

- [ ] **Step 3: Remove the `replaceForm` branch from `applyFormMutation`**

In `lib/doc/mutations/forms.ts`, narrow the `mut` extract and delete the `case "replaceForm":` block. Drop `cascadeDeleteField` from the imports (it was only used there).

- [ ] **Step 4: Remove the `replaceForm` method from `useBlueprintMutations`**

Delete the method from the `BlueprintMutations` interface and from the `useMemo` body. Also delete the `FieldPatch` / `Field` imports if they become unused.

- [ ] **Step 5: Delete `replaceForm` test coverage in `lib/doc/__tests__/mutations-forms.test.ts`**

Delete every `describe("replaceForm")` block.

- [ ] **Step 6: Delete `replaceForm` test coverage in `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`**

Delete the `describe("replaceForm")` block.

- [ ] **Step 7: Type-check, lint, test**

```bash
npx tsc --noEmit && echo "✓ tsc clean"
npm run lint && echo "✓ lint clean"
npm test -- --run
```

Expected: clean. Test count will drop by the number of `replaceForm`-specific tests deleted (rough estimate: ~10 tests gone, ~6 new from Task 3 / Task 5 additions, net roughly stable near 1122 ± 10).

- [ ] **Step 8: Grep to confirm `replaceForm` is gone from source**

```bash
rg "replaceForm" lib/ components/ app/ hooks/
```

Expected: only matches inside docs (`docs/superpowers/**`). Any hit in `lib/` or `components/` is a leftover that must be cleaned up before committing.

- [ ] **Step 9: Commit**

```bash
git add lib/doc/types.ts lib/doc/mutations/index.ts lib/doc/mutations/forms.ts lib/doc/hooks/useBlueprintMutations.ts lib/doc/__tests__/mutations-forms.test.ts lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx
git commit -m "refactor(doc): delete replaceForm mutation — decomposed by mutationMapper"
```

---

## Task 7: Change `applyMany` to return `MutationResult[]`; delete `apply` + `applyWithResult`

The store now has one public write action. The hook routes every dispatch through it. The two metadata-producing mutations (`renameField`, `moveField`) destructure the single-element result array to pull their return values.

**Files:**
- Modify: `lib/doc/store.ts`
- Modify: `lib/doc/hooks/useBlueprintMutations.ts`

- [ ] **Step 1: Update the store's `BlueprintDocState` type**

Delete `apply` and `applyWithResult` from `BlueprintDocState`. Change `applyMany`'s signature to return `MutationResult[]`. Keep `load`, `beginAgentWrite`, `endAgentWrite`.

```ts
export type BlueprintDocState = BlueprintDoc & {
	/**
	 * The ONLY write path into the store.
	 *
	 * Applies every mutation in the array to a single Immer draft inside one
	 * `set()` call. zundo records exactly one undo entry for the whole batch,
	 * regardless of array length — a single user edit and a multi-step agent
	 * write both collapse to one undoable snapshot.
	 *
	 * Returns an array of reducer results, one per input mutation, same
	 * order. Most kinds produce `undefined`. `renameField` returns
	 * `FieldRenameMeta` with the XPath rewrite count. `moveField` returns
	 * `MoveFieldResult` with cross-level auto-rename info. Callers that
	 * need metadata destructure the known position; callers that don't
	 * care ignore the return value.
	 */
	applyMany: (muts: Mutation[]) => MutationResult[];
	load: (doc: PersistableDoc) => void;
	beginAgentWrite: () => void;
	endAgentWrite: () => void;
};
```

- [ ] **Step 2: Implement the new `applyMany` action**

Replace the existing action block — delete `apply`, delete `applyWithResult`, and change `applyMany` to collect results:

```ts
							applyMany: (muts: Mutation[]): MutationResult[] => {
								let results: MutationResult[] = [];
								set((draft) => {
									results = applyMutations(
										draft as unknown as Parameters<typeof applyMutations>[0],
										muts,
									);
								});
								return results;
							},
```

- [ ] **Step 3: Update `useBlueprintMutations` to use `applyMany` everywhere**

In `lib/doc/hooks/useBlueprintMutations.ts`:

- Delete the `dispatch` internal lambda.
- Replace every `dispatch(mut)` call with `store.getState().applyMany([mut])`.
- Rewrite `renameField`:

```ts
renameField(uuid, newId) {
	const doc = get();
	const field = doc.fields[uuid];
	if (!field) {
		warnUnresolved("renameField", { uuid });
		return { newPath: "" as QuestionPath, xpathFieldsRewritten: 0 };
	}
	// Pre-check sibling conflict — reject before dispatching.
	const parentUuid = doc.fieldParent[uuid] ?? undefined;
	if (parentUuid !== undefined) {
		const siblings = doc.fieldOrder[parentUuid] ?? [];
		for (const sibUuid of siblings) {
			if (sibUuid === uuid) continue;
			if (doc.fields[sibUuid]?.id === newId) {
				return {
					newPath: "" as QuestionPath,
					xpathFieldsRewritten: 0,
					conflict: true,
				};
			}
		}
	}
	// Dispatch via the single write path. Position [0] carries the
	// reducer's metadata for this mutation.
	const [result] = store.getState().applyMany([
		{ kind: "renameField", uuid, newId },
	]);
	const meta = result as FieldRenameMeta | undefined;
	const after = get();
	const newPath = (computePathForUuid(after, uuid) ?? "") as QuestionPath;
	return {
		newPath,
		xpathFieldsRewritten: meta?.xpathFieldsRewritten ?? 0,
	};
},
```

- Rewrite `moveField`:

```ts
moveField(uuid, opts) {
	const doc = get();
	const field = doc.fields[uuid];
	if (!field) {
		warnUnresolved("moveField", { uuid });
		return { droppedCrossDepthRefs: 0 };
	}
	const toParentUuid = opts.toParentUuid ?? doc.fieldParent[uuid] ?? uuid;
	const base = doc.fieldOrder[toParentUuid] ?? [];
	const virtual = base.includes(uuid)
		? base.filter((u) => u !== uuid)
		: base;
	let toIndex = virtual.length;
	if (opts.toIndex !== undefined) toIndex = opts.toIndex;
	else if (opts.beforeUuid) {
		const i = virtual.indexOf(opts.beforeUuid);
		if (i >= 0) toIndex = i;
	} else if (opts.afterUuid) {
		const i = virtual.indexOf(opts.afterUuid);
		if (i >= 0) toIndex = i + 1;
	}
	const [result] = store.getState().applyMany([
		{ kind: "moveField", uuid, toParentUuid, toIndex },
	]);
	return (result as MoveFieldResult | undefined) ?? {
		droppedCrossDepthRefs: 0,
	};
},
```

- Rewrite `updateApp` to use the single-call `applyMany` directly (already does — verify no change needed).
- The `applyMany` passthrough method stays: `store.getState().applyMany(mutations)` — but now returns `MutationResult[]`. Update the hook interface:

```ts
	applyMany: (mutations: Mutation[]) => MutationResult[];
```

- Import `MutationResult` from `@/lib/doc/types`.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit && echo "✓ tsc clean"
```

Expected: clean. Every external `.apply()` / `.applyWithResult()` call is now a type error — those are fixed in Task 8.

If you see errors, they'll be from test files — note the list and proceed to Task 8 before re-running tests. DO NOT make the type check pass by reviving `apply` as a public method; that defeats the point of the task.

- [ ] **Step 5: Commit**

```bash
git add lib/doc/store.ts lib/doc/hooks/useBlueprintMutations.ts
git commit -m "refactor(doc): collapse store write API to applyMany only (returns results)"
```

---

## Task 8: Migrate every external `.apply()` / `.applyWithResult()` call site

Test files + any non-test callers that broke when Task 7 removed the methods.

**Files (from the Task 1 survey — exact list):**
- Modify: `lib/doc/__tests__/store.test.ts`
- Modify: `lib/doc/__tests__/hooks.test.tsx`
- Modify: `lib/doc/__tests__/mutations-fields-move-xpath.test.ts`
- Modify: `lib/routing/__tests__/builderActions-useUndoRedo.test.tsx`
- Modify: `lib/routing/__tests__/builderActions-useDeleteSelectedField.test.tsx`
- Modify: `lib/routing/__tests__/LocationRecoveryEffect.test.tsx`
- Modify: `lib/session/__tests__/store.test.ts`
- Modify: `lib/preview/engine/__tests__/engineController.test.ts`
- Modify: `lib/generation/__tests__/generationLifecycle.test.ts`
- Modify: `components/preview/form/virtual/__tests__/useFormRows.test.tsx`

- [ ] **Step 1: Enumerate remaining violations**

```bash
rg "\.apply\(" lib/ components/ app/ hooks/ --type ts --type tsx -n
rg "\.applyWithResult\(" lib/ components/ app/ hooks/ --type ts --type tsx -n
```

Only internal hook-level usage inside `lib/doc/hooks/useBlueprintMutations.ts` should remain (passthrough in `applyMany`). Ignore hits in `lib/doc/mutations/**/*.ts` comments — those are doc strings; fix them in Step 3.

- [ ] **Step 2: For each test file, replace `.apply(mut)` with `.applyMany([mut])`**

Example transformation:

```ts
// BEFORE
store.getState().apply({ kind: "setAppName", name: "After" });

// AFTER
store.getState().applyMany([{ kind: "setAppName", name: "After" }]);
```

For `.applyWithResult(mut)` (which should only appear in the hook itself and nowhere else now), replace with `.applyMany([mut])` and destructure position [0]:

```ts
// BEFORE
const meta = store.getState().applyWithResult({ kind: "renameField", uuid, newId });

// AFTER
const [meta] = store.getState().applyMany([{ kind: "renameField", uuid, newId }]);
```

Repeat for every test file listed above. The changes are mechanical — no test logic should change.

- [ ] **Step 3: Update doc strings in reducer files**

`lib/doc/mutations/fields.ts` comments reference `store.apply()`. Update to `store.applyMany([...])`.

`lib/doc/mutations/helpers.ts` similar.

- [ ] **Step 4: Update the `lib/generation/mutationMapper.ts` top-of-file comment**

Line ~5 says "that can be applied to a `BlueprintDoc` via `store.apply()` or `store.applyMany()`". Update to `store.applyMany()`.

- [ ] **Step 5: Type-check, lint, full test suite**

```bash
npx tsc --noEmit && echo "✓ tsc clean"
npm run lint && echo "✓ lint clean"
npm test -- --run
```

Expected: clean. All tests pass.

- [ ] **Step 6: Grep — `apply(` / `applyWithResult(` must only appear inside `lib/doc/` (internal) or as substring hits in unrelated identifiers**

```bash
rg "\.apply\(|\.applyWithResult\(" lib/ components/ app/ hooks/ --type ts --type tsx
```

Every match must be either inside `lib/doc/hooks/useBlueprintMutations.ts` (internal passthrough) or a doc comment. No external code should retain `.apply()` / `.applyWithResult()`.

- [ ] **Step 7: Commit**

```bash
git add lib/ components/ app/ hooks/
git commit -m "refactor: migrate all callers from apply/applyWithResult to applyMany"
```

---

## Task 9: Verify `notify*` mutation absence + refresh CLAUDE.md

Documentary pass — confirms the spec's `notify*` item is satisfied by Phase 1's work.

**Files:**
- Modify: `lib/doc/CLAUDE.md` (doc refresh)

- [ ] **Step 1: Confirm no `notify*` entries exist in the `Mutation` union**

```bash
rg "kind:\s*['\"]notify" lib/doc/ --type ts
```

Expected: zero matches. If any show up, that's a Phase 1 gap that should be filed as a separate issue — do not add them back and do not remove them as part of this phase without explicit discussion.

- [ ] **Step 2: Confirm `notifyMoveRename` callsites use `applyMany` results**

```bash
rg "notifyMoveRename" --type ts --type tsx
```

Expected matches:
- `lib/doc/mutations/notify.ts` (definition)
- `components/preview/form/virtual/VirtualFormList.tsx` (consumer — should be reading the return of `useBlueprintMutations().moveField(...)`, which is now a `MoveFieldResult` sourced from `applyMany([{kind:"moveField", ...}])[0]`). Verify the code path still compiles and the toast still fires.
- `components/builder/useBuilderShortcuts.ts` (same pattern).

Skim the three consumer lines to confirm they still destructure the metadata correctly. No code changes expected — the hook's public `moveField` signature is unchanged.

- [ ] **Step 3: Update `lib/doc/CLAUDE.md`**

Add a short paragraph documenting the new constraint:

```markdown
## The write surface

`applyMany(mutations: Mutation[]): MutationResult[]` is the only write action on the store. `renameField` and `moveField` produce a `MutationResult` entry at their array position carrying XPath-rewrite metadata; every other mutation produces `undefined`. There is no `apply` / `applyWithResult` — single-mutation dispatches wrap as `applyMany([m])` with `[result]` destructuring for metadata.

The public `Mutation` union is fine-grained. There is no `replaceForm`: wholesale form replacements decompose into `updateForm` + `removeField × N` + `addField × M` at the emission boundary (see `lib/generation/mutationMapper.ts::mapFormContent`). There are no `notify*` mutations: XPath hashtag rewrites + sibling-id dedup are reducer side-effects of `renameField` / `moveField`, surfaced to UI as `MutationResult` return values.
```

- [ ] **Step 4: Commit**

```bash
git add lib/doc/CLAUDE.md
git commit -m "docs(doc): document single-write-path + decomposed mutation surface"
```

---

## Task 10: Final verification

**Files:** (no changes — verification only)

- [ ] **Step 1: Type-check**

```bash
npx tsc --noEmit && echo "✓ tsc clean"
```

- [ ] **Step 2: Lint**

```bash
npm run lint && echo "✓ lint clean"
```

- [ ] **Step 3: Full test suite**

```bash
npm test -- --run
```

Expected: ≥ 1122 tests passing (baseline from Task 1), with net change ≈ new `convertField` tests (+6) + deleted `replaceForm` tests (~−10) + adjusted mapper tests (~±0). Exact count doesn't need to match — but it cannot drop below 1122 minus the count of deleted `replaceForm` tests, and every previously-green test unrelated to the changes must still pass.

- [ ] **Step 4: Production build**

```bash
npm run build
```

Expected: clean. The Turbopack build prints the route manifest; no TS / lint errors should surface.

- [ ] **Step 5: Grep for legacy bridge smells**

```bash
rg "replaceForm|applyWithResult" lib/ components/ app/ hooks/ --type ts --type tsx
rg "\.apply\(" lib/ components/ app/ hooks/ --type ts --type tsx | rg -v "lib/doc/hooks/useBlueprintMutations\.ts"
```

Expected: zero matches for `replaceForm` / `applyWithResult` outside docs. The second grep should be empty — every `.apply(` in src is inside `useBlueprintMutations` (internal), or inside `lib/doc/mutations/` as a reducer-internal comment.

- [ ] **Step 6: Manual smoke test**

```bash
npm run dev
```

In the browser (localhost:3000):

- Open an existing app. Verify modules, forms, fields render correctly (this confirms `mapFormContent`'s decomposed mutations hydrate the doc identically to the old `replaceForm`).
- Select a text field → header menu → Convert Type → Secret. Field converts, undo rolls back in one step.
- Rename a field that's referenced by another field's XPath. Toast shows rewrite count. Undo reverts both the rename and the rewrite.
- Drag a field across a group boundary that already has a sibling with the same id. Auto-rename toast appears. Undo reverts.
- Generate a new app via the SA (empty app → type "a simple patient registration app"). Every form renders correctly as it streams.
- Run an edit on an existing app (e.g. ask the SA to "add a phone number field to the registration form"). The edit applies without a flash or tree-reset — the decomposed mutations animate cleanly.

Document any bug found; fix in a follow-up commit before the next step.

- [ ] **Step 7: Final commit marker**

```bash
git commit --allow-empty -m "chore: phase 2 verification complete"
```

---

## Task 11: Open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin refactor/phase-2-mutation-surface-hardening
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "refactor: phase 2 — mutation surface hardening" --body "$(cat <<'EOF'
## Summary

Phase 2 of 7 from `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`.

- Collapses the doc store's public write API to one path: `applyMany(mutations): MutationResult[]`. Deletes `apply` and `applyWithResult`.
- Deletes the `replaceForm` mutation. The SA stream mapper (`mapFormContent`) now emits `updateForm` + `removeField × N` + `addField × M` — fine-grained, clean undo, clean event log.
- Adds a first-class `convertField` mutation for atomic kind swaps. The Convert Type submenu in the contextual editor header dispatches it directly instead of the ad-hoc `updateField({ kind: ... })` path.
- Documents that `notify*` mutations never landed in the public union (Phase 1 folded XPath rewrites into `renameField` / `moveField` reducers); the `notifyMoveRename` toast helper stays as a UI effect, not a mutation.

## Architectural boundaries

- No wire-format translators (`toBlueprint`, `legacyDocToBlueprint`) introduced. The SA's `BlueprintForm` payload enters `mapFormContent` as the last wire boundary; every mutation emitted is in domain shape.
- Single write path — no private `apply` kept for "internal compatibility."
- No legacy shims, no `// TODO` deferred cleanups.

## Test plan

- [x] `convertField` reducer tests (six conversion families + no-op + unknown uuid).
- [x] `mutationMapper` decomposition tests (empty form, existing form, nested group parent-before-child ordering).
- [x] `applyMany` return-shape tests (rename / move metadata preserved).
- [x] Full suite ≥ 1122 tests (baseline), all green.
- [x] Manual smoke: convert, rename with XPath rewrite, cross-level move auto-rename, SA build, SA edit.

## Deployment

No migration step. The wire format (SA → stream → client) is unchanged; only the client-side decomposition changed. Rolling deploy is safe.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Pause for review**

Do not merge until the PR is reviewed.

---

## What Phase 3 picks up

After Phase 2 lands:
- `lib/agent/` directory creation + move of SA code out of `lib/services/` — Phase 3.
- Tool schema generator (`toolSchemaGenerator`) — Phase 3.
- Server-side mutation mapper — Phase 3.
- `lib/services/` still exists (smaller surface) — eventual deletion in Phase 7.
- Top-level `/hooks/` still exists — Phase 6 moves it into `lib/*/hooks/`.
- Event log unification (`lib/log/`) — Phase 4.
