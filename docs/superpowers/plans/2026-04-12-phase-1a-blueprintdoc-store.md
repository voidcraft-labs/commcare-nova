# Phase 1a — Builder State Re-architecture: BlueprintDoc Store + Mutation API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully-tested, normalized `BlueprintDoc` Zustand store with its complete mutation reducer, blueprint↔doc converter, provider, and domain hook surface. The store is not yet wired into the running app — that's Phase 1b.

**Architecture:** Immer-backed Zustand store in `lib/doc/store.ts` with `temporal` (zundo), `subscribeWithSelector`, and `devtools` middleware. Mutations are a pure `applyMutation(draft, mut)` reducer split by entity type across `lib/doc/mutations/{app,modules,forms,questions}.ts`. Domain hooks live under `lib/doc/hooks/**` and wrap the three low-level store hooks (`useBlueprintDoc`, `useBlueprintDocShallow`, `useBlueprintDocTemporal`) so consumers never import the store module directly.

**Tech Stack:** TypeScript (strict), Zustand 5, Immer 10, zundo 2, Vitest, Biome, @testing-library/react 16.

**Spec reference:** `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md` — Phase 1 row of the migration table + Section "1. BlueprintDoc (the domain store)" + Section "5. Selector API unification".

**Depends on:** Phase 0 (merged to main at commit `c46be5d`). Types already defined in `lib/doc/types.ts`: `Uuid`, `asUuid`, `ModuleEntity`, `FormEntity`, `QuestionEntity`, `BlueprintDoc`, `Mutation`.

---

## File Structure

New files created in this phase (absolute paths from repo root):

```
lib/doc/
  store.ts                        # Zustand store factory + middleware stack
  provider.tsx                    # <BlueprintDocProvider> React context + store instance
  converter.ts                    # toDoc(blueprint, appId) + toBlueprint(doc)
  mutations/
    index.ts                      # applyMutation dispatch; applyMutations batching
    app.ts                        # setAppName, setConnectType, setCaseTypes
    modules.ts                    # addModule, removeModule, moveModule, renameModule, updateModule
    forms.ts                      # addForm, removeForm, moveForm, renameForm, updateForm, replaceForm
    questions.ts                  # addQuestion, removeQuestion, moveQuestion, renameQuestion,
                                  # duplicateQuestion, updateQuestion
    helpers.ts                    # shared helpers: cascadeDeleteForm, cascadeDeleteQuestion,
                                  # computeQuestionPath, dedupeSiblingId, deepCloneQuestionSubtree
  hooks/
    useBlueprintDoc.ts            # low-level Zustand subscription hooks (private surface)
    useEntity.ts                  # useQuestion, useForm, useModule
    useOrderedChildren.ts         # useOrderedChildren, useOrderedQuestionChildren
    useModuleIds.ts               # useModuleIds, useOrderedModules, useFormIds, useOrderedForms
    useAssembledForm.ts           # composite — reconstruct nested BlueprintForm for expander/compiler
  __tests__/
    converter.test.ts             # blueprint ↔ doc roundtrip
    store.test.ts                 # store lifecycle: load, temporal pause/resume
    mutations-app.test.ts         # setAppName/setConnectType/setCaseTypes
    mutations-modules.test.ts     # all module mutations
    mutations-forms.test.ts       # all form mutations
    mutations-questions.test.ts   # all question mutations
    hooks.test.tsx                # domain hooks — react-testing-library
```

**Dependencies between files:**

- `store.ts` imports `BlueprintDoc`, `Mutation` from `@/lib/doc/types`; imports `applyMutation`, `applyMutations` from `./mutations`; imports `toDoc` from `./converter`.
- `mutations/*.ts` import entity types from `@/lib/doc/types` and shared helpers from `./helpers`.
- `mutations/questions.ts` imports `rewriteXPathRefs` from `@/lib/preview/xpath/rewrite` (existing helper used by the old store).
- `converter.ts` imports `AppBlueprint`, `BlueprintModule`, `BlueprintForm`, `Question` from `@/lib/schemas/blueprint`.
- `hooks/*.ts` import from `./useBlueprintDoc` (the low-level surface). No other file in the codebase imports from `./useBlueprintDoc`.

**File size budgets** (soft targets — exceed when correctness demands):

- Each mutation sub-file under 250 lines
- `helpers.ts` under 200 lines
- Each hook file under 100 lines
- Each test file under 500 lines

If a file blows past its budget during implementation, report the overrun as a concern but complete the task — Phase 1b can split files if warranted.

---

### Task 1: Implement `toDoc` blueprint→doc converter

**Files:**
- Create: `lib/doc/converter.ts`
- Create: `lib/doc/__tests__/converter.test.ts`

The converter flattens an `AppBlueprint` into a `BlueprintDoc`. Modules and forms don't carry UUIDs in the on-disk schema, so this function generates `crypto.randomUUID()` values for them. Questions already carry `uuid: string` — these are cast to the branded `Uuid` and reused. The resulting doc is normalized: entity tables keyed by UUID, order maps expressing hierarchy, no nesting.

Reference prior art: `lib/services/normalizedState.ts:decomposeBlueprint()` does the same flattening for the old `NModule`/`NForm` entity types. We write a new function because our entity types carry the full blueprint shape (`Omit<BlueprintModule, "forms"> & { uuid: Uuid }`) rather than the projected `NModule` subset.

- [ ] **Step 1: Write the failing converter test**

Create `lib/doc/__tests__/converter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toDoc } from "@/lib/doc/converter";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

const APP_ID = "test-app-id";

describe("toDoc", () => {
	it("flattens an empty blueprint", () => {
		const bp: AppBlueprint = {
			app_name: "Empty App",
			connect_type: undefined,
			modules: [],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		expect(doc).toMatchObject({
			appId: APP_ID,
			appName: "Empty App",
			connectType: null,
			caseTypes: null,
			modules: {},
			forms: {},
			questions: {},
			moduleOrder: [],
			formOrder: {},
			questionOrder: {},
		});
	});

	it("converts undefined connect_type to null and preserves defined values", () => {
		const bp: AppBlueprint = {
			app_name: "Learn",
			connect_type: "learn",
			modules: [],
			case_types: [],
		};
		expect(toDoc(bp, APP_ID).connectType).toBe("learn");
	});

	it("generates UUIDs for modules and preserves moduleOrder", () => {
		const bp: AppBlueprint = {
			app_name: "Two Modules",
			connect_type: undefined,
			modules: [
				{ name: "First", forms: [] },
				{ name: "Second", forms: [] },
			],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		expect(doc.moduleOrder).toHaveLength(2);
		const [firstUuid, secondUuid] = doc.moduleOrder;
		expect(doc.modules[firstUuid]?.name).toBe("First");
		expect(doc.modules[secondUuid]?.name).toBe("Second");
		// UUIDs must be unique
		expect(firstUuid).not.toBe(secondUuid);
	});

	it("generates UUIDs for forms and indexes formOrder by module UUID", () => {
		const bp: AppBlueprint = {
			app_name: "One Module Two Forms",
			connect_type: undefined,
			modules: [
				{
					name: "Mod",
					forms: [
						{ name: "Reg", type: "registration", questions: [] },
						{ name: "Follow", type: "followup", questions: [] },
					],
				},
			],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		const modUuid = doc.moduleOrder[0];
		expect(doc.formOrder[modUuid]).toHaveLength(2);
		expect(doc.forms[doc.formOrder[modUuid][0]]?.name).toBe("Reg");
		expect(doc.forms[doc.formOrder[modUuid][1]]?.name).toBe("Follow");
	});

	it("preserves question UUIDs from the blueprint (not regenerated)", () => {
		const qUuid = "q-uuid-preserved-0000-0000-000000000000";
		const bp: AppBlueprint = {
			app_name: "App",
			connect_type: undefined,
			modules: [
				{
					name: "Mod",
					forms: [
						{
							name: "F",
							type: "survey",
							questions: [
								{ uuid: qUuid, id: "name", type: "text", label: "Name" },
							],
						},
					],
				},
			],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		expect(doc.questionOrder[formUuid]).toEqual([qUuid]);
		expect(doc.questions[qUuid]?.id).toBe("name");
	});

	it("flattens nested group children into separate questionOrder entries", () => {
		const groupUuid = "g-0000-0000-0000-000000000000";
		const childUuid = "c-0000-0000-0000-000000000000";
		const bp: AppBlueprint = {
			app_name: "App",
			connect_type: undefined,
			modules: [
				{
					name: "Mod",
					forms: [
						{
							name: "F",
							type: "survey",
							questions: [
								{
									uuid: groupUuid,
									id: "grp",
									type: "group",
									label: "Grp",
									children: [
										{
											uuid: childUuid,
											id: "inner",
											type: "text",
											label: "Inner",
										},
									],
								},
							],
						},
					],
				},
			],
			case_types: null,
		};
		const doc = toDoc(bp, APP_ID);
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		// Top-level order contains the group uuid
		expect(doc.questionOrder[formUuid]).toEqual([groupUuid]);
		// Group has its own entry in questionOrder, keyed by its own uuid
		expect(doc.questionOrder[groupUuid]).toEqual([childUuid]);
		// The child is a peer entry in the flat questions map
		expect(doc.questions[childUuid]?.id).toBe("inner");
		// QuestionEntity has no `children` field
		expect((doc.questions[groupUuid] as { children?: unknown }).children).toBeUndefined();
	});

	it("throws when a question is missing its uuid", () => {
		const bp: AppBlueprint = {
			app_name: "App",
			connect_type: undefined,
			modules: [
				{
					name: "Mod",
					forms: [
						{
							name: "F",
							type: "survey",
							// Cast to bypass the type-level uuid requirement — we want to
							// exercise the runtime guard.
							questions: [{ id: "bare", type: "text" } as never],
						},
					],
				},
			],
			case_types: null,
		};
		expect(() => toDoc(bp, APP_ID)).toThrow(/uuid/i);
	});
});
```

Run the tests to verify they fail:

```bash
npx vitest run lib/doc/__tests__/converter.test.ts
```

Expected: fails because `lib/doc/converter.ts` doesn't exist yet.

- [ ] **Step 2: Implement `toDoc`**

Create `lib/doc/converter.ts`:

```ts
/**
 * Blueprint ↔ BlueprintDoc converter.
 *
 * The on-disk blueprint schema (`AppBlueprint` in `lib/schemas/blueprint.ts`)
 * is a nested tree: modules contain forms, forms contain top-level questions,
 * and group/repeat questions contain children. The builder doc (`BlueprintDoc`
 * in `lib/doc/types.ts`) is normalized: three UUID-keyed entity tables plus
 * three order maps that capture hierarchy.
 *
 * `toDoc` is called on initial blueprint load (Phase 1b wires this into the
 * builder route). `toBlueprint` reconstructs the nested form for save, export,
 * and the chat body.
 *
 * Design choices:
 *   - Module and form UUIDs are freshly minted on every load because the
 *     on-disk schema doesn't persist them. Stable identity across sessions
 *     is NOT a promise of this converter — it's a session-scoped normalization.
 *   - Question UUIDs are preserved verbatim from the blueprint; questions
 *     already carry stable UUIDs (assigned at creation by the SA).
 *   - Missing question UUIDs throw — callers must have run `applyDefaults` or
 *     the SA's question-tree builder before handing the blueprint to `toDoc`.
 */

import type {
	AppBlueprint,
	BlueprintForm,
	BlueprintModule,
	Question,
} from "@/lib/schemas/blueprint";
import {
	type BlueprintDoc,
	type FormEntity,
	type ModuleEntity,
	type QuestionEntity,
	type Uuid,
	asUuid,
} from "@/lib/doc/types";

/**
 * Convert an `AppBlueprint` into a normalized `BlueprintDoc`.
 *
 * @param bp - the blueprint to flatten (as persisted in Firestore)
 * @param appId - the app's document ID, attached to the doc for routing
 */
export function toDoc(bp: AppBlueprint, appId: string): BlueprintDoc {
	const modules: Record<Uuid, ModuleEntity> = {};
	const forms: Record<Uuid, FormEntity> = {};
	const questions: Record<Uuid, QuestionEntity> = {};
	const moduleOrder: Uuid[] = [];
	const formOrder: Record<Uuid, Uuid[]> = {};
	const questionOrder: Record<Uuid, Uuid[]> = {};

	for (const mod of bp.modules) {
		const modUuid = asUuid(crypto.randomUUID());
		moduleOrder.push(modUuid);
		const { forms: modForms, ...moduleRest } = mod as BlueprintModule & {
			forms: BlueprintForm[];
		};
		modules[modUuid] = { ...moduleRest, uuid: modUuid };

		const formUuids: Uuid[] = [];
		for (const form of modForms ?? []) {
			const formUuid = asUuid(crypto.randomUUID());
			formUuids.push(formUuid);
			const { questions: formQuestions, ...formRest } =
				form as BlueprintForm & { questions: Question[] };
			forms[formUuid] = { ...formRest, uuid: formUuid };
			questionOrder[formUuid] = flattenQuestions(
				formQuestions ?? [],
				questions,
				questionOrder,
			);
		}
		formOrder[modUuid] = formUuids;
	}

	return {
		appId,
		appName: bp.app_name,
		connectType: bp.connect_type ?? null,
		caseTypes: bp.case_types ?? null,
		modules,
		forms,
		questions,
		moduleOrder,
		formOrder,
		questionOrder,
	};
}

/**
 * Recursively flatten a question tree into the doc's entity and order maps.
 *
 * Returns the ordered UUID array for the parent (form uuid or group uuid).
 * Populates `questions` and `questionOrder` by side effect — this avoids
 * allocating fresh arrays at each recursion depth.
 */
function flattenQuestions(
	src: Question[],
	questions: Record<Uuid, QuestionEntity>,
	questionOrder: Record<Uuid, Uuid[]>,
): Uuid[] {
	const order: Uuid[] = [];
	for (const q of src) {
		if (!q.uuid) {
			throw new Error(
				`toDoc: question "${q.id}" is missing a uuid — run the applyDefaults pass before calling toDoc`,
			);
		}
		const uuid = asUuid(q.uuid);
		order.push(uuid);
		const { children, uuid: _ignored, ...questionRest } = q;
		questions[uuid] = { ...questionRest, uuid } as QuestionEntity;
		if (children && children.length > 0) {
			questionOrder[uuid] = flattenQuestions(
				children,
				questions,
				questionOrder,
			);
		}
	}
	return order;
}
```

Run the tests to verify they pass:

```bash
npx vitest run lib/doc/__tests__/converter.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/converter.ts lib/doc/__tests__/converter.test.ts
git commit -m "feat(builder/doc): add toDoc blueprint→doc converter"
```

---

### Task 2: Implement `toBlueprint` doc→blueprint reverse converter

**Files:**
- Modify: `lib/doc/converter.ts`
- Modify: `lib/doc/__tests__/converter.test.ts`

Save, export, and chat-body serialization all need the nested blueprint shape. `toBlueprint` walks the doc's entity and order maps to reconstruct it. The crucial property is round-trip fidelity: `toBlueprint(toDoc(bp))` should produce the same blueprint modulo the module/form UUIDs that `toDoc` generated (those UUIDs don't appear in the on-disk blueprint, so they're simply not part of the round-trip contract).

- [ ] **Step 1: Write the failing tests**

Append to `lib/doc/__tests__/converter.test.ts`:

```ts

import { toBlueprint } from "@/lib/doc/converter";

describe("toBlueprint", () => {
	it("reconstructs an empty doc", () => {
		const doc = toDoc(
			{
				app_name: "Empty",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			APP_ID,
		);
		expect(toBlueprint(doc)).toEqual({
			app_name: "Empty",
			connect_type: undefined,
			modules: [],
			case_types: null,
		});
	});

	it("round-trips modules + forms + nested questions", () => {
		const bp: AppBlueprint = {
			app_name: "Round Trip",
			connect_type: "deliver",
			modules: [
				{
					name: "Reg Mod",
					case_type: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							questions: [
								{
									uuid: "q1-uuid-0000-0000-000000000000",
									id: "name",
									type: "text",
									label: "Name",
								},
								{
									uuid: "g1-uuid-0000-0000-000000000000",
									id: "contact",
									type: "group",
									label: "Contact",
									children: [
										{
											uuid: "c1-uuid-0000-0000-000000000000",
											id: "phone",
											type: "text",
											label: "Phone",
										},
									],
								},
							],
						},
					],
				},
			],
			case_types: [
				{ name: "patient", properties: [{ name: "name" }] },
			],
		};
		const roundTripped = toBlueprint(toDoc(bp, APP_ID));
		expect(roundTripped).toEqual(bp);
	});

	it("emits undefined (not null) for missing connect_type", () => {
		const doc = toDoc(
			{
				app_name: "NoConnect",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			APP_ID,
		);
		expect(toBlueprint(doc).connect_type).toBeUndefined();
	});

	it("preserves case_types through round-trip", () => {
		const bp: AppBlueprint = {
			app_name: "With Cases",
			connect_type: undefined,
			modules: [],
			case_types: [
				{ name: "patient", properties: [{ name: "name" }, { name: "age" }] },
				{ name: "visit", properties: [{ name: "date" }] },
			],
		};
		expect(toBlueprint(toDoc(bp, APP_ID)).case_types).toEqual(bp.case_types);
	});

	it("uses moduleOrder/formOrder/questionOrder to determine output order", () => {
		const modA = "modA-0000-0000-0000-000000000000";
		const modB = "modB-0000-0000-0000-000000000000";
		const doc: BlueprintDoc = {
			appId: APP_ID,
			appName: "Out Of Order",
			connectType: null,
			caseTypes: null,
			modules: {
				[modA]: { uuid: modA as Uuid, name: "A" } as ModuleEntity,
				[modB]: { uuid: modB as Uuid, name: "B" } as ModuleEntity,
			},
			forms: {},
			questions: {},
			// Intentionally reverse order
			moduleOrder: [modB as Uuid, modA as Uuid],
			formOrder: {},
			questionOrder: {},
		};
		const bp = toBlueprint(doc);
		expect(bp.modules.map((m) => m.name)).toEqual(["B", "A"]);
	});
});
```

Need to add imports at the top of the existing test file. If Biome auto-merged imports, the new imports will merge into the existing block. Otherwise, ensure the following symbols are importable:

```ts
import type { BlueprintDoc, ModuleEntity, Uuid } from "@/lib/doc/types";
```

Run the tests:

```bash
npx vitest run lib/doc/__tests__/converter.test.ts
```

Expected: 5 new tests fail with "toBlueprint is not a function" or similar.

- [ ] **Step 2: Implement `toBlueprint`**

Append to `lib/doc/converter.ts`:

```ts

/**
 * Convert a normalized `BlueprintDoc` back into the nested `AppBlueprint`
 * wire format. The resulting blueprint is suitable for save, export, and
 * chat-body serialization.
 *
 * Output ordering is governed entirely by the doc's `*Order` arrays; the
 * entity tables are consulted for field values but never for ordering.
 *
 * UUID lifecycle:
 *   - Question UUIDs are preserved on output — they appear in the blueprint's
 *     `uuid` fields.
 *   - Module and form UUIDs are NOT serialized to the blueprint; they exist
 *     only for in-session reference. If you `toBlueprint(toDoc(bp))` the
 *     input and output will be identical regardless of the session UUIDs.
 */
export function toBlueprint(doc: BlueprintDoc): AppBlueprint {
	return {
		app_name: doc.appName,
		connect_type: doc.connectType ?? undefined,
		case_types: doc.caseTypes ?? null,
		modules: doc.moduleOrder.map((modUuid) => {
			const { uuid: _m, ...moduleRest } = doc.modules[modUuid];
			const formUuids = doc.formOrder[modUuid] ?? [];
			return {
				...moduleRest,
				forms: formUuids.map((formUuid) => {
					const { uuid: _f, ...formRest } = doc.forms[formUuid];
					return {
						...formRest,
						questions: assembleQuestions(formUuid, doc),
					};
				}),
			};
		}),
	};
}

/**
 * Recursively rebuild the nested question tree for a given parent UUID.
 * Called for each form uuid at the top level, then recursively for each
 * group/repeat's own uuid.
 */
function assembleQuestions(parentUuid: Uuid, doc: BlueprintDoc): Question[] {
	const order = doc.questionOrder[parentUuid] ?? [];
	return order.map((qUuid) => {
		const q = doc.questions[qUuid];
		const nested = doc.questionOrder[qUuid];
		// Group/repeat → emit children. Leaf → omit children entirely (not []).
		return nested !== undefined
			? { ...q, children: assembleQuestions(qUuid, doc) }
			: q;
	});
}
```

Run the tests:

```bash
npx vitest run lib/doc/__tests__/converter.test.ts
```

Expected: all 12 tests pass (7 from Task 1 + 5 new).

- [ ] **Step 3: Commit**

```bash
git add lib/doc/converter.ts lib/doc/__tests__/converter.test.ts
git commit -m "feat(builder/doc): add toBlueprint reverse converter with round-trip coverage"
```

---

### Task 3: Scaffold mutation dispatch + helpers

**Files:**
- Create: `lib/doc/mutations/index.ts`
- Create: `lib/doc/mutations/app.ts`
- Create: `lib/doc/mutations/modules.ts`
- Create: `lib/doc/mutations/forms.ts`
- Create: `lib/doc/mutations/questions.ts`
- Create: `lib/doc/mutations/helpers.ts`

Set up the file skeleton. Every mutation handler is a function `(draft: Draft<BlueprintDoc>, mut: Mutation) => void`. The index file dispatches on `mut.kind` via a `switch` with an `assertNever` default so TypeScript enforces exhaustiveness — adding a new mutation kind later forces the developer to handle it in the dispatcher.

- [ ] **Step 1: Create `mutations/helpers.ts` with shared utilities**

```ts
/**
 * Shared helpers for builder-doc mutations.
 *
 * These helpers encapsulate the recurring patterns — cascade deletion,
 * sibling id deduplication, question path computation — that multiple
 * mutation kinds need. Keeping them in one place prevents subtle drift
 * (e.g. renameQuestion and moveQuestion both need consistent path logic).
 */

import type { Draft } from "immer";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";

/**
 * Remove a question and all of its descendants from the doc. Called by
 * `removeQuestion` and by `removeForm`/`removeModule` when they cascade.
 * Also strips the question from any ordering array; callers that delete
 * a question from a specific parent's order should do that themselves.
 */
export function cascadeDeleteQuestion(
	draft: Draft<BlueprintDoc>,
	uuid: Uuid,
): void {
	const children = draft.questionOrder[uuid];
	if (children) {
		// Snapshot the children list; recursive deletes mutate questionOrder.
		for (const childUuid of [...children]) {
			cascadeDeleteQuestion(draft, childUuid);
		}
		delete draft.questionOrder[uuid];
	}
	delete draft.questions[uuid];
}

/**
 * Remove a form from the doc, cascading to its question subtree. Does NOT
 * remove the form from its module's `formOrder[]` — that's the caller's
 * job, since `removeForm` knows the module uuid but a cascading
 * `removeModule` does not (the form order maps to the module directly).
 */
export function cascadeDeleteForm(draft: Draft<BlueprintDoc>, uuid: Uuid): void {
	const topLevelQuestions = draft.questionOrder[uuid] ?? [];
	for (const qUuid of [...topLevelQuestions]) {
		cascadeDeleteQuestion(draft, qUuid);
	}
	delete draft.questionOrder[uuid];
	delete draft.forms[uuid];
}

/**
 * Locate a question's parent (either a form or a group/repeat).
 * Returns the parent uuid and the question's current index within
 * that parent, or `undefined` if the question isn't in any order map.
 *
 * O(parents × siblings). Mutation code paths typically call this once
 * per mutation, so the cost is acceptable; if this ever shows up in
 * profiles we can maintain a reverse index on the doc.
 */
export function findQuestionParent(
	doc: BlueprintDoc,
	uuid: Uuid,
): { parentUuid: Uuid; index: number } | undefined {
	for (const [parentUuid, order] of Object.entries(doc.questionOrder)) {
		const index = order.indexOf(uuid);
		if (index !== -1) {
			return { parentUuid: parentUuid as Uuid, index };
		}
	}
	return undefined;
}

/**
 * Find the form uuid that contains a given question (direct child or any
 * nested descendant). Returns `undefined` if the question isn't reachable
 * from any form.
 *
 * Traverses up from the question through its parents until a form uuid is
 * found (form uuids appear as keys in both `formOrder[]` values and
 * `questionOrder` — but `draft.forms[uuid]` is the definitive check).
 */
export function findContainingForm(
	doc: BlueprintDoc,
	questionUuid: Uuid,
): Uuid | undefined {
	let cursor: Uuid | undefined = questionUuid;
	const visited = new Set<Uuid>();
	while (cursor !== undefined) {
		if (visited.has(cursor)) return undefined; // Defensive: cycle detection.
		visited.add(cursor);
		const parent = findQuestionParent(doc, cursor);
		if (!parent) return undefined;
		if (doc.forms[parent.parentUuid] !== undefined) {
			return parent.parentUuid;
		}
		cursor = parent.parentUuid;
	}
	return undefined;
}

/**
 * Deduplicate a question id against its siblings. If `desired` conflicts
 * with any existing sibling id, append `_2`, `_3`, ... until unique.
 *
 * CommCare requires unique question ids within each parent level — see
 * the "Sibling IDs must be unique" note in the root CLAUDE.md.
 */
export function dedupeSiblingId(
	draft: Draft<BlueprintDoc>,
	parentUuid: Uuid,
	desired: string,
	excludeUuid: Uuid | undefined,
): string {
	const siblings = draft.questionOrder[parentUuid] ?? [];
	const takenIds = new Set<string>();
	for (const sibUuid of siblings) {
		if (sibUuid === excludeUuid) continue;
		const sibId = draft.questions[sibUuid]?.id;
		if (sibId) takenIds.add(sibId);
	}
	if (!takenIds.has(desired)) return desired;
	for (let n = 2; n < 10_000; n++) {
		const candidate = `${desired}_${n}`;
		if (!takenIds.has(candidate)) return candidate;
	}
	throw new Error(
		`dedupeSiblingId: exhausted 9999 suffixes trying to dedupe "${desired}"`,
	);
}

/**
 * Compute the slash-delimited path from a form to a question, using its
 * CommCare ids (NOT UUIDs). Used by `rewriteXPathRefs` — XPath references
 * in the blueprint are path-based (`group_id/child_q`), not UUID-based.
 *
 * Returns `undefined` if the question isn't reachable from a form.
 */
export function computeQuestionPath(
	doc: BlueprintDoc,
	questionUuid: Uuid,
): string | undefined {
	const segments: string[] = [];
	let cursor: Uuid | undefined = questionUuid;
	const visited = new Set<Uuid>();
	while (cursor !== undefined) {
		if (visited.has(cursor)) return undefined;
		visited.add(cursor);
		if (doc.forms[cursor] !== undefined) {
			// Reached the form — path is complete.
			return segments.reverse().join("/");
		}
		const q = doc.questions[cursor];
		if (!q) return undefined;
		segments.push(q.id);
		const parent = findQuestionParent(doc, cursor);
		if (!parent) return undefined;
		cursor = parent.parentUuid;
	}
	return undefined;
}

/**
 * `never` assertion for exhaustive switch defaults. TypeScript flags
 * any missing mutation kinds as unassignable to `never` at compile time.
 */
export function assertNever(x: never): never {
	throw new Error(`unreachable: unexpected mutation kind: ${JSON.stringify(x)}`);
}
```

- [ ] **Step 2: Create empty mutation sub-files**

Create `lib/doc/mutations/app.ts`:

```ts
import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/** App-level mutations are filled in by the next task. */
export function applyAppMutation(
	_draft: Draft<BlueprintDoc>,
	_mut: Extract<
		Mutation,
		{ kind: "setAppName" | "setConnectType" | "setCaseTypes" }
	>,
): void {
	throw new Error("applyAppMutation not implemented");
}
```

Create `lib/doc/mutations/modules.ts`:

```ts
import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/** Module mutations are filled in by later tasks. */
export function applyModuleMutation(
	_draft: Draft<BlueprintDoc>,
	_mut: Extract<
		Mutation,
		{
			kind:
				| "addModule"
				| "removeModule"
				| "moveModule"
				| "renameModule"
				| "updateModule";
		}
	>,
): void {
	throw new Error("applyModuleMutation not implemented");
}
```

Create `lib/doc/mutations/forms.ts`:

```ts
import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/** Form mutations are filled in by later tasks. */
export function applyFormMutation(
	_draft: Draft<BlueprintDoc>,
	_mut: Extract<
		Mutation,
		{
			kind:
				| "addForm"
				| "removeForm"
				| "moveForm"
				| "renameForm"
				| "updateForm"
				| "replaceForm";
		}
	>,
): void {
	throw new Error("applyFormMutation not implemented");
}
```

Create `lib/doc/mutations/questions.ts`:

```ts
import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/** Question mutations are filled in by later tasks. */
export function applyQuestionMutation(
	_draft: Draft<BlueprintDoc>,
	_mut: Extract<
		Mutation,
		{
			kind:
				| "addQuestion"
				| "removeQuestion"
				| "moveQuestion"
				| "renameQuestion"
				| "duplicateQuestion"
				| "updateQuestion";
		}
	>,
): void {
	throw new Error("applyQuestionMutation not implemented");
}
```

- [ ] **Step 3: Create `mutations/index.ts` dispatcher**

```ts
/**
 * Mutation dispatcher. Every way the doc can change flows through here.
 *
 * Sub-files (`app.ts`, `modules.ts`, `forms.ts`, `questions.ts`) each
 * handle a related family of mutations. This top-level switch routes
 * on `kind` and delegates.
 *
 * `applyMutation` operates on an Immer draft — call sites wrap it in
 * `produce()` or let the Zustand store's Immer middleware handle the
 * drafting. `applyMutations` is a batched convenience for the agent
 * stream (Phase 4) and for restoring a doc from a mutation log.
 */

import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { applyAppMutation } from "./app";
import { applyFormMutation } from "./forms";
import { assertNever } from "./helpers";
import { applyModuleMutation } from "./modules";
import { applyQuestionMutation } from "./questions";

export function applyMutation(
	draft: Draft<BlueprintDoc>,
	mut: Mutation,
): void {
	switch (mut.kind) {
		case "setAppName":
		case "setConnectType":
		case "setCaseTypes":
			return applyAppMutation(draft, mut);
		case "addModule":
		case "removeModule":
		case "moveModule":
		case "renameModule":
		case "updateModule":
			return applyModuleMutation(draft, mut);
		case "addForm":
		case "removeForm":
		case "moveForm":
		case "renameForm":
		case "updateForm":
		case "replaceForm":
			return applyFormMutation(draft, mut);
		case "addQuestion":
		case "removeQuestion":
		case "moveQuestion":
		case "renameQuestion":
		case "duplicateQuestion":
		case "updateQuestion":
			return applyQuestionMutation(draft, mut);
		default:
			return assertNever(mut);
	}
}

/** Apply a batch of mutations to a single Immer draft. */
export function applyMutations(
	draft: Draft<BlueprintDoc>,
	muts: Mutation[],
): void {
	for (const mut of muts) applyMutation(draft, mut);
}
```

- [ ] **Step 4: Verify typecheck passes**

```bash
npx tsc --noEmit
```

Expected: clean (sub-handlers throw at runtime but typecheck).

- [ ] **Step 5: Commit**

```bash
git add lib/doc/mutations/
git commit -m "feat(builder/doc): scaffold mutation dispatcher + helpers"
```

---

### Task 4: Implement app-level mutations

**Files:**
- Modify: `lib/doc/mutations/app.ts`
- Create: `lib/doc/__tests__/mutations-app.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/doc/__tests__/mutations-app.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { produce } from "immer";
import type { BlueprintDoc } from "@/lib/doc/types";
import { applyMutation } from "@/lib/doc/mutations";

function emptyDoc(): BlueprintDoc {
	return {
		appId: "test",
		appName: "Original",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		questions: {},
		moduleOrder: [],
		formOrder: {},
		questionOrder: {},
	};
}

describe("applyMutation: setAppName", () => {
	it("updates appName", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "setAppName", name: "Renamed" });
		});
		expect(next.appName).toBe("Renamed");
	});

	it("does not mutate the input doc", () => {
		const doc = emptyDoc();
		produce(doc, (d) => {
			applyMutation(d, { kind: "setAppName", name: "Renamed" });
		});
		expect(doc.appName).toBe("Original");
	});
});

describe("applyMutation: setConnectType", () => {
	it("sets learn", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "setConnectType", connectType: "learn" });
		});
		expect(next.connectType).toBe("learn");
	});

	it("sets null to disable connect", () => {
		const withLearn: BlueprintDoc = { ...emptyDoc(), connectType: "learn" };
		const next = produce(withLearn, (d) => {
			applyMutation(d, { kind: "setConnectType", connectType: null });
		});
		expect(next.connectType).toBeNull();
	});
});

describe("applyMutation: setCaseTypes", () => {
	it("sets a case type list", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, {
				kind: "setCaseTypes",
				caseTypes: [{ name: "patient", properties: [{ name: "name" }] }],
			});
		});
		expect(next.caseTypes).toEqual([
			{ name: "patient", properties: [{ name: "name" }] },
		]);
	});

	it("sets null", () => {
		const withTypes: BlueprintDoc = {
			...emptyDoc(),
			caseTypes: [{ name: "a", properties: [] }],
		};
		const next = produce(withTypes, (d) => {
			applyMutation(d, { kind: "setCaseTypes", caseTypes: null });
		});
		expect(next.caseTypes).toBeNull();
	});
});
```

Run tests:

```bash
npx vitest run lib/doc/__tests__/mutations-app.test.ts
```

Expected: all tests fail with "applyAppMutation not implemented".

- [ ] **Step 2: Implement the handlers**

Replace `lib/doc/mutations/app.ts` with:

```ts
import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/**
 * App-level mutations: name, connect mode, case type catalog. Each is
 * a single-field assignment with no cascading side effects — they can't
 * orphan entities or desync order maps.
 */
export function applyAppMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{ kind: "setAppName" | "setConnectType" | "setCaseTypes" }
	>,
): void {
	switch (mut.kind) {
		case "setAppName":
			draft.appName = mut.name;
			return;
		case "setConnectType":
			draft.connectType = mut.connectType;
			return;
		case "setCaseTypes":
			draft.caseTypes = mut.caseTypes;
			return;
	}
}
```

Run tests — expect all passing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/mutations/app.ts lib/doc/__tests__/mutations-app.test.ts
git commit -m "feat(builder/doc): implement app-level mutations (setAppName, setConnectType, setCaseTypes)"
```

---

### Task 5: Implement module mutations

**Files:**
- Modify: `lib/doc/mutations/modules.ts`
- Create: `lib/doc/__tests__/mutations-modules.test.ts`

Module mutations: add, remove (with cascade), move, rename, update. `removeModule` is the trickiest because it cascades — delete forms (which cascade to questions), clear formOrder for this module, then delete the module entity and remove it from moduleOrder.

- [ ] **Step 1: Write the failing tests**

Create `lib/doc/__tests__/mutations-modules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { produce } from "immer";
import type { BlueprintDoc, FormEntity, ModuleEntity, QuestionEntity, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import { applyMutation } from "@/lib/doc/mutations";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);

function module_(uuid: Uuid, name: string): ModuleEntity {
	return { uuid, name } as ModuleEntity;
}
function form_(uuid: Uuid, name: string): FormEntity {
	return { uuid, name, type: "survey" } as FormEntity;
}
function question_(uuid: Uuid, id: string): QuestionEntity {
	return { uuid, id, type: "text" } as QuestionEntity;
}

function emptyDoc(): BlueprintDoc {
	return {
		appId: "test",
		appName: "App",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		questions: {},
		moduleOrder: [],
		formOrder: {},
		questionOrder: {},
	};
}

describe("addModule", () => {
	it("appends to moduleOrder by default", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "addModule", module: module_(M("A"), "A") });
			applyMutation(d, { kind: "addModule", module: module_(M("B"), "B") });
		});
		expect(next.moduleOrder).toEqual([M("A"), M("B")]);
		expect(next.modules[M("A")]?.name).toBe("A");
	});

	it("inserts at index when provided", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: { [M("A")]: module_(M("A"), "A"), [M("C")]: module_(M("C"), "C") },
			moduleOrder: [M("A"), M("C")],
			formOrder: { [M("A")]: [], [M("C")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "addModule",
				module: module_(M("B"), "B"),
				index: 1,
			});
		});
		expect(next.moduleOrder).toEqual([M("A"), M("B"), M("C")]);
	});

	it("initializes empty formOrder slot for the new module", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "addModule", module: module_(M("A"), "A") });
		});
		expect(next.formOrder[M("A")]).toEqual([]);
	});
});

describe("removeModule", () => {
	it("removes the module entity, its entry in moduleOrder, and its formOrder slot", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: { [M("A")]: module_(M("A"), "A") },
			moduleOrder: [M("A")],
			formOrder: { [M("A")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "removeModule", uuid: M("A") });
		});
		expect(next.modules[M("A")]).toBeUndefined();
		expect(next.moduleOrder).toEqual([]);
		expect(next.formOrder[M("A")]).toBeUndefined();
	});

	it("cascades to forms and questions", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: { [M("A")]: module_(M("A"), "A") },
			forms: { [F("1")]: form_(F("1"), "F") },
			questions: { [Q("x")]: question_(Q("x"), "x") },
			moduleOrder: [M("A")],
			formOrder: { [M("A")]: [F("1")] },
			questionOrder: { [F("1")]: [Q("x")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "removeModule", uuid: M("A") });
		});
		expect(next.forms[F("1")]).toBeUndefined();
		expect(next.questions[Q("x")]).toBeUndefined();
		expect(next.questionOrder[F("1")]).toBeUndefined();
	});
});

describe("moveModule", () => {
	it("reorders moduleOrder", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: module_(M("A"), "A"),
				[M("B")]: module_(M("B"), "B"),
				[M("C")]: module_(M("C"), "C"),
			},
			moduleOrder: [M("A"), M("B"), M("C")],
			formOrder: { [M("A")]: [], [M("B")]: [], [M("C")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "moveModule", uuid: M("A"), toIndex: 2 });
		});
		expect(next.moduleOrder).toEqual([M("B"), M("C"), M("A")]);
	});

	it("clamps toIndex to valid range", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: module_(M("A"), "A"),
				[M("B")]: module_(M("B"), "B"),
			},
			moduleOrder: [M("A"), M("B")],
			formOrder: { [M("A")]: [], [M("B")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "moveModule", uuid: M("A"), toIndex: 999 });
		});
		expect(next.moduleOrder).toEqual([M("B"), M("A")]);
	});

	it("is a no-op when the module isn't in moduleOrder", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "moveModule", uuid: M("missing"), toIndex: 0 });
		});
		expect(next.moduleOrder).toEqual([]);
	});
});

describe("renameModule", () => {
	it("updates the module's name (user-visible identifier)", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: { uuid: M("A"), name: "Original" } as ModuleEntity,
			},
			moduleOrder: [M("A")],
			formOrder: { [M("A")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameModule",
				uuid: M("A"),
				newId: "Renamed",
			});
		});
		expect(next.modules[M("A")]?.name).toBe("Renamed");
	});

	it("is a no-op when the module doesn't exist", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, {
				kind: "renameModule",
				uuid: M("missing"),
				newId: "X",
			});
		});
		expect(next.modules[M("missing")]).toBeUndefined();
	});
});

describe("updateModule", () => {
	it("applies a partial patch", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: { [M("A")]: module_(M("A"), "A") },
			moduleOrder: [M("A")],
			formOrder: { [M("A")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "updateModule",
				uuid: M("A"),
				patch: { case_type: "patient" },
			});
		});
		expect(next.modules[M("A")]?.case_type).toBe("patient");
		expect(next.modules[M("A")]?.name).toBe("A"); // Other fields preserved
	});

	it("ignores updates to unknown module uuids", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, {
				kind: "updateModule",
				uuid: M("missing"),
				patch: { case_type: "patient" },
			});
		});
		expect(next.modules[M("missing")]).toBeUndefined();
	});
});
```

Run tests — expect failure (handlers throw "not implemented").

- [ ] **Step 2: Implement the handlers**

Replace `lib/doc/mutations/modules.ts` with:

```ts
import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { cascadeDeleteForm } from "./helpers";

/**
 * Module mutations operate on the `modules`, `moduleOrder`, and `formOrder`
 * maps. Removal cascades: dropping a module drops its forms (which drop
 * their questions via `cascadeDeleteForm`).
 *
 * `renameModule` maps to the module's `name` field — modules have no
 * dedicated slug in the blueprint schema; `name` is the user-visible
 * identifier. The mutation's `newId` is the target display name.
 */
export function applyModuleMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addModule"
				| "removeModule"
				| "moveModule"
				| "renameModule"
				| "updateModule";
		}
	>,
): void {
	switch (mut.kind) {
		case "addModule": {
			const { uuid } = mut.module;
			draft.modules[uuid] = mut.module;
			draft.formOrder[uuid] = [];
			const index = mut.index ?? draft.moduleOrder.length;
			const clamped = Math.max(0, Math.min(index, draft.moduleOrder.length));
			draft.moduleOrder.splice(clamped, 0, uuid);
			return;
		}
		case "removeModule": {
			const { uuid } = mut;
			if (draft.modules[uuid] === undefined) return;
			// Cascade to forms
			for (const formUuid of [...(draft.formOrder[uuid] ?? [])]) {
				cascadeDeleteForm(draft, formUuid);
			}
			delete draft.formOrder[uuid];
			delete draft.modules[uuid];
			const orderIndex = draft.moduleOrder.indexOf(uuid);
			if (orderIndex !== -1) draft.moduleOrder.splice(orderIndex, 1);
			return;
		}
		case "moveModule": {
			const { uuid, toIndex } = mut;
			const from = draft.moduleOrder.indexOf(uuid);
			if (from === -1) return;
			draft.moduleOrder.splice(from, 1);
			const clamped = Math.max(0, Math.min(toIndex, draft.moduleOrder.length));
			draft.moduleOrder.splice(clamped, 0, uuid);
			return;
		}
		case "renameModule": {
			const mod = draft.modules[mut.uuid];
			if (mod) mod.name = mut.newId;
			return;
		}
		case "updateModule": {
			const mod = draft.modules[mut.uuid];
			if (!mod) return;
			Object.assign(mod, mut.patch);
			return;
		}
	}
}
```

Run tests — expect all passing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/mutations/modules.ts lib/doc/__tests__/mutations-modules.test.ts
git commit -m "feat(builder/doc): implement module mutations with cascade delete"
```

---

### Task 6: Implement form mutations (simple)

**Files:**
- Modify: `lib/doc/mutations/forms.ts`
- Create: `lib/doc/__tests__/mutations-forms.test.ts`

Simple form mutations: add, remove (with cascade), move, rename, update. `replaceForm` is deferred to Task 7 because it has non-trivial ordering semantics.

- [ ] **Step 1: Write the failing tests**

Create `lib/doc/__tests__/mutations-forms.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { produce } from "immer";
import type { BlueprintDoc, FormEntity, ModuleEntity, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import { applyMutation } from "@/lib/doc/mutations";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);

function form_(uuid: Uuid, name = "Form"): FormEntity {
	return { uuid, name, type: "survey" } as FormEntity;
}

function docWithModule(modUuid: Uuid): BlueprintDoc {
	return {
		appId: "test",
		appName: "App",
		connectType: null,
		caseTypes: null,
		modules: {
			[modUuid]: { uuid: modUuid, name: "M" } as ModuleEntity,
		},
		forms: {},
		questions: {},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [] },
		questionOrder: {},
	};
}

describe("addForm", () => {
	it("inserts into the module's formOrder and creates an entity", () => {
		const next = produce(docWithModule(M("A")), (d) => {
			applyMutation(d, {
				kind: "addForm",
				moduleUuid: M("A"),
				form: form_(F("1"), "Reg"),
			});
		});
		expect(next.formOrder[M("A")]).toEqual([F("1")]);
		expect(next.forms[F("1")]?.name).toBe("Reg");
	});

	it("initializes an empty questionOrder slot for the new form", () => {
		const next = produce(docWithModule(M("A")), (d) => {
			applyMutation(d, {
				kind: "addForm",
				moduleUuid: M("A"),
				form: form_(F("1")),
			});
		});
		expect(next.questionOrder[F("1")]).toEqual([]);
	});

	it("respects index when provided", () => {
		const start = produce(docWithModule(M("A")), (d) => {
			applyMutation(d, {
				kind: "addForm",
				moduleUuid: M("A"),
				form: form_(F("1"), "A"),
			});
			applyMutation(d, {
				kind: "addForm",
				moduleUuid: M("A"),
				form: form_(F("3"), "C"),
			});
		});
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "addForm",
				moduleUuid: M("A"),
				form: form_(F("2"), "B"),
				index: 1,
			});
		});
		expect(next.formOrder[M("A")]).toEqual([F("1"), F("2"), F("3")]);
	});

	it("is a no-op when the moduleUuid doesn't exist", () => {
		const next = produce(docWithModule(M("A")), (d) => {
			applyMutation(d, {
				kind: "addForm",
				moduleUuid: M("missing"),
				form: form_(F("1")),
			});
		});
		expect(next.forms[F("1")]).toBeUndefined();
	});
});

describe("removeForm", () => {
	it("removes the form, its questionOrder slot, and entry from module's formOrder", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1")) },
			formOrder: { [M("A")]: [F("1")] },
			questionOrder: { [F("1")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "removeForm", uuid: F("1") });
		});
		expect(next.forms[F("1")]).toBeUndefined();
		expect(next.questionOrder[F("1")]).toBeUndefined();
		expect(next.formOrder[M("A")]).toEqual([]);
	});

	it("cascades to questions", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1")) },
			questions: { [Q("a")]: { uuid: Q("a"), id: "a", type: "text" } as never },
			formOrder: { [M("A")]: [F("1")] },
			questionOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "removeForm", uuid: F("1") });
		});
		expect(next.questions[Q("a")]).toBeUndefined();
	});
});

describe("moveForm", () => {
	it("moves a form within the same module", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: {
				[F("1")]: form_(F("1"), "Alpha"),
				[F("2")]: form_(F("2"), "Beta"),
			},
			formOrder: { [M("A")]: [F("1"), F("2")] },
			questionOrder: { [F("1")]: [], [F("2")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveForm",
				uuid: F("1"),
				toModuleUuid: M("A"),
				toIndex: 1,
			});
		});
		expect(next.formOrder[M("A")]).toEqual([F("2"), F("1")]);
	});

	it("moves a form across modules", () => {
		const start: BlueprintDoc = {
			appId: "test",
			appName: "A",
			connectType: null,
			caseTypes: null,
			modules: {
				[M("X")]: { uuid: M("X"), name: "X" } as ModuleEntity,
				[M("Y")]: { uuid: M("Y"), name: "Y" } as ModuleEntity,
			},
			forms: { [F("1")]: form_(F("1")) },
			questions: {},
			moduleOrder: [M("X"), M("Y")],
			formOrder: { [M("X")]: [F("1")], [M("Y")]: [] },
			questionOrder: { [F("1")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveForm",
				uuid: F("1"),
				toModuleUuid: M("Y"),
				toIndex: 0,
			});
		});
		expect(next.formOrder[M("X")]).toEqual([]);
		expect(next.formOrder[M("Y")]).toEqual([F("1")]);
	});

	it("is a no-op when destination module doesn't exist", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1")) },
			formOrder: { [M("A")]: [F("1")] },
			questionOrder: { [F("1")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveForm",
				uuid: F("1"),
				toModuleUuid: M("missing"),
				toIndex: 0,
			});
		});
		expect(next.formOrder[M("A")]).toEqual([F("1")]);
	});
});

describe("renameForm", () => {
	it("updates the form's name", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1"), "Old") },
			formOrder: { [M("A")]: [F("1")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "renameForm", uuid: F("1"), newId: "New" });
		});
		// Form "rename" maps to the user-visible name.
		expect(next.forms[F("1")]?.name).toBe("New");
	});
});

describe("updateForm", () => {
	it("applies a partial patch", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1")) },
			formOrder: { [M("A")]: [F("1")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "updateForm",
				uuid: F("1"),
				patch: { type: "registration" },
			});
		});
		expect(next.forms[F("1")]?.type).toBe("registration");
	});
});
```

Run tests — expect failure.

- [ ] **Step 2: Implement the simple form handlers**

Replace `lib/doc/mutations/forms.ts` with:

```ts
import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { cascadeDeleteForm } from "./helpers";

/**
 * Form mutations. `replaceForm` is handled in a dedicated branch because it
 * has to atomically swap a form's entire subtree — questions and all nested
 * ordering — without disturbing siblings.
 *
 * `renameForm` maps to the form's `name` field (the only user-editable
 * free-form identifier on a form). The `id`-style slug doesn't exist on
 * forms; CommCare derives the form's XForm id from its position.
 */
export function applyFormMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addForm"
				| "removeForm"
				| "moveForm"
				| "renameForm"
				| "updateForm"
				| "replaceForm";
		}
	>,
): void {
	switch (mut.kind) {
		case "addForm": {
			if (draft.modules[mut.moduleUuid] === undefined) return;
			const { uuid } = mut.form;
			draft.forms[uuid] = mut.form;
			draft.questionOrder[uuid] = [];
			const order = draft.formOrder[mut.moduleUuid] ?? [];
			const index = mut.index ?? order.length;
			const clamped = Math.max(0, Math.min(index, order.length));
			order.splice(clamped, 0, uuid);
			draft.formOrder[mut.moduleUuid] = order;
			return;
		}
		case "removeForm": {
			if (draft.forms[mut.uuid] === undefined) return;
			// Find which module owns this form, remove from its order.
			for (const [modUuid, formList] of Object.entries(draft.formOrder)) {
				const idx = formList.indexOf(mut.uuid);
				if (idx !== -1) {
					formList.splice(idx, 1);
					draft.formOrder[modUuid as keyof typeof draft.formOrder] = formList;
					break;
				}
			}
			cascadeDeleteForm(draft, mut.uuid);
			return;
		}
		case "moveForm": {
			if (draft.forms[mut.uuid] === undefined) return;
			if (draft.modules[mut.toModuleUuid] === undefined) return;
			// Remove from source module
			for (const [modUuid, formList] of Object.entries(draft.formOrder)) {
				const idx = formList.indexOf(mut.uuid);
				if (idx !== -1) {
					formList.splice(idx, 1);
					draft.formOrder[modUuid as keyof typeof draft.formOrder] = formList;
					break;
				}
			}
			// Insert into destination
			const destOrder = draft.formOrder[mut.toModuleUuid] ?? [];
			const clamped = Math.max(0, Math.min(mut.toIndex, destOrder.length));
			destOrder.splice(clamped, 0, mut.uuid);
			draft.formOrder[mut.toModuleUuid] = destOrder;
			return;
		}
		case "renameForm": {
			const form = draft.forms[mut.uuid];
			if (form) form.name = mut.newId;
			return;
		}
		case "updateForm": {
			const form = draft.forms[mut.uuid];
			if (!form) return;
			Object.assign(form, mut.patch);
			return;
		}
		case "replaceForm": {
			// Filled in by Task 7.
			throw new Error("replaceForm not implemented");
		}
	}
}
```

Run tests — expect all passing except replaceForm, which isn't tested here yet.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/mutations/forms.ts lib/doc/__tests__/mutations-forms.test.ts
git commit -m "feat(builder/doc): implement form mutations (add, remove, move, rename, update)"
```

---

### Task 7: Implement `replaceForm`

**Files:**
- Modify: `lib/doc/mutations/forms.ts`
- Modify: `lib/doc/__tests__/mutations-forms.test.ts`

`replaceForm` atomically swaps a form's entity, its questions, and its entire nested question ordering. The mutation carries `Record<Uuid, Uuid[]>` for `questionOrder` so nested groups are expressible.

- [ ] **Step 1: Append the failing tests**

Append to `lib/doc/__tests__/mutations-forms.test.ts`:

```ts

describe("replaceForm", () => {
	it("swaps entity, questions, and questionOrder atomically", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1"), "Old") },
			questions: {
				[Q("old1")]: { uuid: Q("old1"), id: "old", type: "text" } as never,
			},
			formOrder: { [M("A")]: [F("1")] },
			questionOrder: { [F("1")]: [Q("old1")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "replaceForm",
				uuid: F("1"),
				form: { uuid: F("1"), name: "New", type: "registration" } as FormEntity,
				questions: [
					{ uuid: Q("new1"), id: "new1", type: "text" } as never,
					{ uuid: Q("new2"), id: "new2", type: "int" } as never,
				],
				questionOrder: { [F("1")]: [Q("new1"), Q("new2")] },
			});
		});
		expect(next.forms[F("1")]?.name).toBe("New");
		expect(next.forms[F("1")]?.type).toBe("registration");
		expect(next.questions[Q("old1")]).toBeUndefined();
		expect(next.questions[Q("new1")]?.id).toBe("new1");
		expect(next.questionOrder[F("1")]).toEqual([Q("new1"), Q("new2")]);
	});

	it("populates nested questionOrder for groups in the replacement", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1")) },
			questions: {},
			formOrder: { [M("A")]: [F("1")] },
			questionOrder: { [F("1")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "replaceForm",
				uuid: F("1"),
				form: form_(F("1")),
				questions: [
					{ uuid: Q("grp"), id: "grp", type: "group" } as never,
					{ uuid: Q("child"), id: "child", type: "text" } as never,
				],
				questionOrder: {
					[F("1")]: [Q("grp")],
					[Q("grp")]: [Q("child")],
				},
			});
		});
		expect(next.questionOrder[F("1")]).toEqual([Q("grp")]);
		expect(next.questionOrder[Q("grp")]).toEqual([Q("child")]);
	});

	it("is a no-op when the target form doesn't exist", () => {
		const next = produce(docWithModule(M("A")), (d) => {
			applyMutation(d, {
				kind: "replaceForm",
				uuid: F("missing"),
				form: form_(F("missing")),
				questions: [],
				questionOrder: { [F("missing")]: [] },
			});
		});
		expect(next.forms[F("missing")]).toBeUndefined();
	});
});
```

Run tests — expect the three new tests to fail with "replaceForm not implemented".

- [ ] **Step 2: Implement `replaceForm`**

In `lib/doc/mutations/forms.ts`, replace the `replaceForm` case with:

```ts
		case "replaceForm": {
			const existing = draft.forms[mut.uuid];
			if (!existing) return;
			// Drop the old question subtree (but don't touch formOrder — the
			// form stays in its module at the same position).
			const oldTop = draft.questionOrder[mut.uuid] ?? [];
			for (const qUuid of [...oldTop]) {
				// Recursive drop via cascadeDeleteQuestion.
				dropQuestionCascade(draft, qUuid);
			}
			// Swap the entity.
			draft.forms[mut.uuid] = mut.form;
			// Install the new questions.
			for (const q of mut.questions) {
				draft.questions[q.uuid] = q;
			}
			// Install the new ordering maps. Each entry replaces whatever
			// was there before.
			for (const [parent, order] of Object.entries(mut.questionOrder)) {
				draft.questionOrder[parent as keyof typeof draft.questionOrder] = order;
			}
			return;
		}
```

Add a local helper above the switch (or use the existing `cascadeDeleteQuestion` from `helpers.ts` — just import it):

```ts
import { cascadeDeleteForm, cascadeDeleteQuestion as dropQuestionCascade } from "./helpers";
```

Note the alias import — it's used as `dropQuestionCascade` inside the switch to keep the line under the soft 120-char budget. If Biome or the existing import block style prefers unaliased imports, use the plain name.

Run tests — all passing, including the new three.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/mutations/forms.ts lib/doc/__tests__/mutations-forms.test.ts
git commit -m "feat(builder/doc): implement replaceForm with atomic subtree swap"
```

---

### Task 8: Implement simple question mutations (`addQuestion`, `updateQuestion`)

**Files:**
- Modify: `lib/doc/mutations/questions.ts`
- Create: `lib/doc/__tests__/mutations-questions.test.ts`

The simple cases. `addQuestion` inserts into any parent's order (form uuid or group uuid). `updateQuestion` applies a partial patch to the entity.

- [ ] **Step 1: Write the failing tests**

Create `lib/doc/__tests__/mutations-questions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { produce } from "immer";
import type {
	BlueprintDoc,
	FormEntity,
	ModuleEntity,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import { applyMutation } from "@/lib/doc/mutations";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);

function question_(uuid: Uuid, id: string, patch: Partial<QuestionEntity> = {}): QuestionEntity {
	return { uuid, id, type: "text", ...patch } as QuestionEntity;
}

function docWithForm(): BlueprintDoc {
	return {
		appId: "test",
		appName: "A",
		connectType: null,
		caseTypes: null,
		modules: { [M("X")]: { uuid: M("X"), name: "M" } as ModuleEntity },
		forms: { [F("1")]: { uuid: F("1"), name: "F", type: "survey" } as FormEntity },
		questions: {},
		moduleOrder: [M("X")],
		formOrder: { [M("X")]: [F("1")] },
		questionOrder: { [F("1")]: [] },
	};
}

describe("addQuestion", () => {
	it("appends under a form uuid", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, {
				kind: "addQuestion",
				parentUuid: F("1"),
				question: question_(Q("a"), "name"),
			});
		});
		expect(next.questionOrder[F("1")]).toEqual([Q("a")]);
		expect(next.questions[Q("a")]?.id).toBe("name");
	});

	it("appends under a group uuid", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: { [Q("grp")]: question_(Q("grp"), "grp", { type: "group" }) },
			questionOrder: { [F("1")]: [Q("grp")], [Q("grp")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "addQuestion",
				parentUuid: Q("grp"),
				question: question_(Q("c"), "child"),
			});
		});
		expect(next.questionOrder[Q("grp")]).toEqual([Q("c")]);
	});

	it("respects index when inserting", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("a")]: question_(Q("a"), "a"),
				[Q("c")]: question_(Q("c"), "c"),
			},
			questionOrder: { [F("1")]: [Q("a"), Q("c")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "addQuestion",
				parentUuid: F("1"),
				question: question_(Q("b"), "b"),
				index: 1,
			});
		});
		expect(next.questionOrder[F("1")]).toEqual([Q("a"), Q("b"), Q("c")]);
	});

	it("is a no-op when parent doesn't exist", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, {
				kind: "addQuestion",
				parentUuid: F("missing"),
				question: question_(Q("a"), "a"),
			});
		});
		expect(next.questions[Q("a")]).toBeUndefined();
	});
});

describe("updateQuestion", () => {
	it("applies a partial patch", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: { [Q("a")]: question_(Q("a"), "name") },
			questionOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "updateQuestion",
				uuid: Q("a"),
				patch: { label: "Patient Name", required: "true" },
			});
		});
		expect(next.questions[Q("a")]?.label).toBe("Patient Name");
		expect(next.questions[Q("a")]?.required).toBe("true");
		expect(next.questions[Q("a")]?.id).toBe("name"); // Preserved
	});
});
```

Run tests — expect failure.

- [ ] **Step 2: Implement the simple handlers**

Replace `lib/doc/mutations/questions.ts` with:

```ts
import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/**
 * Question mutations. Six kinds:
 *   - addQuestion, updateQuestion: simple entity-level edits
 *   - removeQuestion: cascade delete subtree
 *   - moveQuestion: cross-parent reorder + xpath rewrite + sibling dedup
 *   - renameQuestion: id change + xpath rewrite of any referencing fields
 *   - duplicateQuestion: deep clone with new UUIDs, dedupe sibling id
 *
 * This task implements only addQuestion and updateQuestion. The cascade,
 * move, rename, and duplicate handlers land in Tasks 9–12.
 */
export function applyQuestionMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addQuestion"
				| "removeQuestion"
				| "moveQuestion"
				| "renameQuestion"
				| "duplicateQuestion"
				| "updateQuestion";
		}
	>,
): void {
	switch (mut.kind) {
		case "addQuestion": {
			// Parent must be a form or a group/repeat that already has an
			// order entry (groups/repeats are added via addQuestion + an
			// empty order slot, so we also allow parents that are registered
			// questions).
			const parentExists =
				draft.forms[mut.parentUuid] !== undefined ||
				draft.questions[mut.parentUuid] !== undefined;
			if (!parentExists) return;
			const order = draft.questionOrder[mut.parentUuid] ?? [];
			const index = mut.index ?? order.length;
			const clamped = Math.max(0, Math.min(index, order.length));
			order.splice(clamped, 0, mut.question.uuid);
			draft.questionOrder[mut.parentUuid] = order;
			draft.questions[mut.question.uuid] = mut.question;
			// If the new question is a group/repeat, pre-seed its order slot.
			if (
				mut.question.type === "group" ||
				mut.question.type === "repeat"
			) {
				draft.questionOrder[mut.question.uuid] ??= [];
			}
			return;
		}
		case "updateQuestion": {
			const q = draft.questions[mut.uuid];
			if (!q) return;
			Object.assign(q, mut.patch);
			return;
		}
		case "removeQuestion":
		case "moveQuestion":
		case "renameQuestion":
		case "duplicateQuestion":
			// Implemented in later tasks.
			throw new Error(`applyQuestionMutation: ${mut.kind} not implemented`);
	}
}
```

Run tests — expect all passing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/mutations/questions.ts lib/doc/__tests__/mutations-questions.test.ts
git commit -m "feat(builder/doc): implement addQuestion + updateQuestion"
```

---

### Task 9: Implement `removeQuestion` with cascade

**Files:**
- Modify: `lib/doc/mutations/questions.ts`
- Modify: `lib/doc/__tests__/mutations-questions.test.ts`

`removeQuestion` must find the question's parent, splice it out of the parent's order, then cascade-delete the question and any descendants (if it's a group/repeat).

- [ ] **Step 1: Append failing tests**

Append to `lib/doc/__tests__/mutations-questions.test.ts`:

```ts

describe("removeQuestion", () => {
	it("removes a leaf question and splices its parent's order", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("a")]: question_(Q("a"), "a"),
				[Q("b")]: question_(Q("b"), "b"),
			},
			questionOrder: { [F("1")]: [Q("a"), Q("b")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "removeQuestion", uuid: Q("a") });
		});
		expect(next.questions[Q("a")]).toBeUndefined();
		expect(next.questions[Q("b")]).toBeDefined();
		expect(next.questionOrder[F("1")]).toEqual([Q("b")]);
	});

	it("cascades to group children", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("grp")]: question_(Q("grp"), "grp", { type: "group" }),
				[Q("c1")]: question_(Q("c1"), "c1"),
				[Q("c2")]: question_(Q("c2"), "c2"),
			},
			questionOrder: {
				[F("1")]: [Q("grp")],
				[Q("grp")]: [Q("c1"), Q("c2")],
			},
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "removeQuestion", uuid: Q("grp") });
		});
		expect(next.questions[Q("grp")]).toBeUndefined();
		expect(next.questions[Q("c1")]).toBeUndefined();
		expect(next.questions[Q("c2")]).toBeUndefined();
		expect(next.questionOrder[Q("grp")]).toBeUndefined();
	});

	it("is a no-op when the question doesn't exist", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, { kind: "removeQuestion", uuid: Q("missing") });
		});
		expect(Object.keys(next.questions)).toHaveLength(0);
	});
});
```

Run tests — expect failure.

- [ ] **Step 2: Implement the handler**

In `lib/doc/mutations/questions.ts`, add imports at the top:

```ts
import { cascadeDeleteQuestion, findQuestionParent } from "./helpers";
```

Replace the `removeQuestion` case:

```ts
		case "removeQuestion": {
			if (draft.questions[mut.uuid] === undefined) return;
			// Remove from parent's order, if any.
			const parent = findQuestionParent(draft, mut.uuid);
			if (parent) {
				const order = draft.questionOrder[parent.parentUuid];
				if (order) {
					order.splice(parent.index, 1);
					draft.questionOrder[parent.parentUuid] = order;
				}
			}
			cascadeDeleteQuestion(draft, mut.uuid);
			return;
		}
```

Run tests — expect all passing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/mutations/questions.ts lib/doc/__tests__/mutations-questions.test.ts
git commit -m "feat(builder/doc): implement removeQuestion with cascade delete"
```

---

### Task 10: Implement `moveQuestion` with xpath rewrite + sibling dedup

**Files:**
- Modify: `lib/doc/mutations/questions.ts`
- Modify: `lib/doc/__tests__/mutations-questions.test.ts`

The trickiest mutation. Steps:

1. Find the question's current parent.
2. Splice it out of the old parent's order.
3. If the new parent is different from the old parent, dedupe the question's `id` against its new siblings (auto-suffix `_2`, `_3`).
4. Compute the question's old and new paths (via `computeQuestionPath`).
5. Rewrite any XPath references that point to the old path. Walk all questions in the doc, rewrite `calculate`, `relevant`, `required`, `validation`, `constraint`, `default_value`, `validation_msg`, `hint` fields.
6. Insert into the new parent's order at `toIndex`.

The xpath-rewriting field list matches the existing code's behavior (see `lib/services/builderStore.ts:1926` for the reference).

- [ ] **Step 1: Append failing tests**

Append to `lib/doc/__tests__/mutations-questions.test.ts`:

```ts

describe("moveQuestion", () => {
	it("moves within the same parent (reorder)", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("a")]: question_(Q("a"), "a"),
				[Q("b")]: question_(Q("b"), "b"),
				[Q("c")]: question_(Q("c"), "c"),
			},
			questionOrder: { [F("1")]: [Q("a"), Q("b"), Q("c")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveQuestion",
				uuid: Q("a"),
				toParentUuid: F("1"),
				toIndex: 2,
			});
		});
		expect(next.questionOrder[F("1")]).toEqual([Q("b"), Q("c"), Q("a")]);
	});

	it("moves across parents", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("grp")]: question_(Q("grp"), "grp", { type: "group" }),
				[Q("x")]: question_(Q("x"), "x"),
			},
			questionOrder: {
				[F("1")]: [Q("grp"), Q("x")],
				[Q("grp")]: [],
			},
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveQuestion",
				uuid: Q("x"),
				toParentUuid: Q("grp"),
				toIndex: 0,
			});
		});
		expect(next.questionOrder[F("1")]).toEqual([Q("grp")]);
		expect(next.questionOrder[Q("grp")]).toEqual([Q("x")]);
	});

	it("dedupes id against new siblings on cross-parent move", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("grp")]: question_(Q("grp"), "grp", { type: "group" }),
				[Q("name_a")]: question_(Q("name_a"), "name"),
				[Q("name_b")]: question_(Q("name_b"), "name"), // Same id, different group
			},
			questionOrder: {
				[F("1")]: [Q("grp"), Q("name_a")],
				[Q("grp")]: [Q("name_b")],
			},
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveQuestion",
				uuid: Q("name_a"),
				toParentUuid: Q("grp"),
				toIndex: 1,
			});
		});
		// After move, Q("name_a") must have a unique id — "name_2".
		expect(next.questions[Q("name_a")]?.id).toBe("name_2");
	});

	it("rewrites XPath references from old path to new path", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("src")]: question_(Q("src"), "source"),
				[Q("ref")]: question_(Q("ref"), "ref", {
					calculate: "/data/source + 1",
				}),
				[Q("grp")]: question_(Q("grp"), "grp", { type: "group" }),
			},
			questionOrder: {
				[F("1")]: [Q("src"), Q("ref"), Q("grp")],
				[Q("grp")]: [],
			},
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveQuestion",
				uuid: Q("src"),
				toParentUuid: Q("grp"),
				toIndex: 0,
			});
		});
		// After moving Q("src") into Q("grp"), its path is "grp/source"
		// instead of "source". Ref in Q("ref") should now point to the new
		// path.
		expect(next.questions[Q("ref")]?.calculate).toContain("grp/source");
	});

	it("is a no-op when the target parent doesn't exist", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: { [Q("a")]: question_(Q("a"), "a") },
			questionOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveQuestion",
				uuid: Q("a"),
				toParentUuid: Q("missing"),
				toIndex: 0,
			});
		});
		expect(next.questionOrder[F("1")]).toEqual([Q("a")]);
	});
});
```

Run tests — expect failure.

- [ ] **Step 2: Implement the handler**

In `lib/doc/mutations/questions.ts`, add imports:

```ts
import { rewriteXPathRefs } from "@/lib/preview/xpath/rewrite";
import {
	cascadeDeleteQuestion,
	computeQuestionPath,
	dedupeSiblingId,
	findQuestionParent,
} from "./helpers";
```

Also define a local constant at module top:

```ts
/**
 * Fields on a `QuestionEntity` that may contain XPath expressions referencing
 * other questions by path. When a question is renamed or moved, these fields
 * across ALL questions in the doc must be rewritten to point to the new path.
 *
 * Mirrors the set in the existing `lib/services/builderStore.ts` rename
 * handler; update both if CommCare adds new XPath-bearing fields.
 */
const XPATH_FIELDS = [
	"calculate",
	"relevant",
	"required",
	"validation",
	"validation_msg",
	"constraint",
	"default_value",
	"hint",
] as const satisfies readonly (keyof QuestionEntity)[];
```

Add `QuestionEntity` to the imports if it isn't already:

```ts
import type { BlueprintDoc, Mutation, QuestionEntity, Uuid } from "@/lib/doc/types";
```

Replace the `moveQuestion` case:

```ts
		case "moveQuestion": {
			const q = draft.questions[mut.uuid];
			if (!q) return;
			// Destination parent must exist as either a form or a group/repeat.
			const destIsForm = draft.forms[mut.toParentUuid] !== undefined;
			const destQ = draft.questions[mut.toParentUuid];
			const destIsContainer =
				destQ && (destQ.type === "group" || destQ.type === "repeat");
			if (!destIsForm && !destIsContainer) return;

			const sourceParent = findQuestionParent(draft, mut.uuid);
			const oldPath = computeQuestionPath(draft, mut.uuid);
			const crossParent =
				sourceParent !== undefined &&
				sourceParent.parentUuid !== mut.toParentUuid;

			// Remove from source order.
			if (sourceParent) {
				const srcOrder = draft.questionOrder[sourceParent.parentUuid];
				if (srcOrder) {
					srcOrder.splice(sourceParent.index, 1);
					draft.questionOrder[sourceParent.parentUuid] = srcOrder;
				}
			}

			// Dedupe id against new siblings if we crossed parent boundary.
			if (crossParent) {
				const deduped = dedupeSiblingId(
					draft,
					mut.toParentUuid,
					q.id,
					mut.uuid,
				);
				q.id = deduped;
			}

			// Insert at destination.
			const destOrder = draft.questionOrder[mut.toParentUuid] ?? [];
			const clamped = Math.max(0, Math.min(mut.toIndex, destOrder.length));
			destOrder.splice(clamped, 0, mut.uuid);
			draft.questionOrder[mut.toParentUuid] = destOrder;

			// Rewrite XPath refs (old path → new id at new position).
			// The helper is name-based — if the id didn't change but the path
			// did, we pass oldPath (with the OLD id segment) as the "from"
			// location and the current id as the new leaf segment.
			const newPath = computeQuestionPath(draft, mut.uuid);
			if (oldPath !== undefined && newPath !== undefined && oldPath !== newPath) {
				rewriteRefsAllQuestions(draft, oldPath, q.id);
			}
			return;
		}
```

Add the rewrite helper at the bottom of the file:

```ts
/**
 * Walk every question in the doc and rewrite XPath references that point
 * to `oldPath`. The `newLeafId` replaces the last segment of matching
 * references; `rewriteXPathRefs` already knows how to produce the new
 * canonical form from this pair.
 */
function rewriteRefsAllQuestions(
	draft: Draft<BlueprintDoc>,
	oldPath: string,
	newLeafId: string,
): void {
	for (const q of Object.values(draft.questions)) {
		for (const field of XPATH_FIELDS) {
			const expr = q[field];
			if (typeof expr === "string" && expr.length > 0) {
				q[field] = rewriteXPathRefs(expr, oldPath, newLeafId) as never;
			}
		}
	}
}
```

Run tests — expect all passing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/mutations/questions.ts lib/doc/__tests__/mutations-questions.test.ts
git commit -m "feat(builder/doc): implement moveQuestion with XPath rewrite + sibling dedup"
```

---

### Task 11: Implement `renameQuestion` with xpath rewrite

**Files:**
- Modify: `lib/doc/mutations/questions.ts`
- Modify: `lib/doc/__tests__/mutations-questions.test.ts`

Rename is a subset of move: the question stays in place, its id changes, and all xpath references to its old path must be rewritten.

- [ ] **Step 1: Append failing tests**

Append to `lib/doc/__tests__/mutations-questions.test.ts`:

```ts

describe("renameQuestion", () => {
	it("updates the question's id", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: { [Q("a")]: question_(Q("a"), "old_name") },
			questionOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameQuestion",
				uuid: Q("a"),
				newId: "new_name",
			});
		});
		expect(next.questions[Q("a")]?.id).toBe("new_name");
	});

	it("rewrites XPath references that point to the old id", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("src")]: question_(Q("src"), "source"),
				[Q("ref")]: question_(Q("ref"), "ref", {
					calculate: "/data/source * 2",
				}),
			},
			questionOrder: { [F("1")]: [Q("src"), Q("ref")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameQuestion",
				uuid: Q("src"),
				newId: "primary",
			});
		});
		expect(next.questions[Q("ref")]?.calculate).toContain("primary");
		expect(next.questions[Q("ref")]?.calculate).not.toContain("source");
	});

	it("is a no-op when the question doesn't exist", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, {
				kind: "renameQuestion",
				uuid: Q("missing"),
				newId: "x",
			});
		});
		expect(Object.keys(next.questions)).toHaveLength(0);
	});
});
```

Run tests — expect failure.

- [ ] **Step 2: Implement the handler**

In `lib/doc/mutations/questions.ts`, replace the `renameQuestion` case:

```ts
		case "renameQuestion": {
			const q = draft.questions[mut.uuid];
			if (!q) return;
			const oldPath = computeQuestionPath(draft, mut.uuid);
			q.id = mut.newId;
			if (oldPath !== undefined) {
				rewriteRefsAllQuestions(draft, oldPath, mut.newId);
			}
			return;
		}
```

Run tests — expect all passing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/mutations/questions.ts lib/doc/__tests__/mutations-questions.test.ts
git commit -m "feat(builder/doc): implement renameQuestion with XPath rewrite"
```

---

### Task 12: Implement `duplicateQuestion`

**Files:**
- Modify: `lib/doc/mutations/questions.ts`
- Modify: `lib/doc/__tests__/mutations-questions.test.ts`
- Modify: `lib/doc/mutations/helpers.ts`

Duplicate a question's entire subtree with new UUIDs, insert after the source, dedupe the id against siblings. External XPath references to the original continue to point to the original (not duplicated).

- [ ] **Step 1: Append failing tests**

Append to `lib/doc/__tests__/mutations-questions.test.ts`:

```ts

describe("duplicateQuestion", () => {
	it("duplicates a leaf question with a new uuid", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: { [Q("a")]: question_(Q("a"), "name") },
			questionOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "duplicateQuestion", uuid: Q("a") });
		});
		// Original still exists
		expect(next.questions[Q("a")]).toBeDefined();
		// Order has two entries
		expect(next.questionOrder[F("1")]).toHaveLength(2);
		// Second entry is a new uuid ≠ Q("a")
		const [, dupUuid] = next.questionOrder[F("1")];
		expect(dupUuid).not.toBe(Q("a"));
		// Duplicated question has deduped id
		expect(next.questions[dupUuid]?.id).toBe("name_2");
	});

	it("inserts the duplicate right after the source", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("a")]: question_(Q("a"), "a"),
				[Q("b")]: question_(Q("b"), "b"),
			},
			questionOrder: { [F("1")]: [Q("a"), Q("b")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "duplicateQuestion", uuid: Q("a") });
		});
		expect(next.questionOrder[F("1")]).toHaveLength(3);
		const [first, second, third] = next.questionOrder[F("1")];
		expect(first).toBe(Q("a"));
		expect(third).toBe(Q("b"));
		// The duplicate is at index 1
		expect(next.questions[second]?.id).toBe("a_2");
	});

	it("deep-clones a group with new uuids for all descendants", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			questions: {
				[Q("grp")]: question_(Q("grp"), "grp", { type: "group" }),
				[Q("c")]: question_(Q("c"), "child"),
			},
			questionOrder: {
				[F("1")]: [Q("grp")],
				[Q("grp")]: [Q("c")],
			},
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "duplicateQuestion", uuid: Q("grp") });
		});
		// Two top-level groups
		expect(next.questionOrder[F("1")]).toHaveLength(2);
		const [, dupGrp] = next.questionOrder[F("1")];
		// Dup group has its own child order
		expect(next.questionOrder[dupGrp]).toHaveLength(1);
		const [dupChild] = next.questionOrder[dupGrp];
		// Dup child is a new uuid
		expect(dupChild).not.toBe(Q("c"));
		// But retains the same id (within the new group, no siblings conflict)
		expect(next.questions[dupChild]?.id).toBe("child");
	});

	it("is a no-op when the source doesn't exist", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, { kind: "duplicateQuestion", uuid: Q("missing") });
		});
		expect(Object.keys(next.questions)).toHaveLength(0);
	});
});
```

Run tests — expect failure.

- [ ] **Step 2: Add the clone helper**

Append to `lib/doc/mutations/helpers.ts`:

```ts

import { asUuid } from "@/lib/doc/types";

/**
 * Deep-clone a question subtree with fresh UUIDs for every entity. The
 * returned object contains the new entities to insert into `questions`
 * and the `questionOrder` entries for the cloned subtree (keyed by the
 * new UUIDs).
 *
 * Field values (`id`, `label`, `calculate`, …) are preserved verbatim —
 * duplicated questions are intentionally identical to their source except
 * for identity. Sibling id deduplication is the caller's responsibility;
 * only the top-level duplicate typically needs deduping since nested
 * clones don't collide with sibling ids.
 */
export function cloneQuestionSubtree(
	doc: BlueprintDoc,
	srcUuid: Uuid,
): {
	questions: Record<Uuid, QuestionEntity>;
	questionOrder: Record<Uuid, Uuid[]>;
	rootUuid: Uuid;
} {
	const clonedQuestions: Record<Uuid, QuestionEntity> = {};
	const clonedOrder: Record<Uuid, Uuid[]> = {};

	function cloneOne(uuid: Uuid): Uuid {
		const src = doc.questions[uuid];
		if (!src) {
			throw new Error(`cloneQuestionSubtree: missing question ${uuid}`);
		}
		const newUuid = asUuid(crypto.randomUUID());
		clonedQuestions[newUuid] = { ...src, uuid: newUuid };
		const childOrder = doc.questionOrder[uuid];
		if (childOrder !== undefined) {
			clonedOrder[newUuid] = childOrder.map((childUuid) =>
				cloneOne(childUuid),
			);
		}
		return newUuid;
	}

	const rootUuid = cloneOne(srcUuid);
	return { questions: clonedQuestions, questionOrder: clonedOrder, rootUuid };
}
```

Also add the missing imports at the top of `helpers.ts`:

```ts
import type { QuestionEntity } from "@/lib/doc/types";
```

Typecheck:

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Implement `duplicateQuestion` in the question handler**

In `lib/doc/mutations/questions.ts`, add to the imports:

```ts
import { cloneQuestionSubtree } from "./helpers";
```

Replace the `duplicateQuestion` case:

```ts
		case "duplicateQuestion": {
			const src = draft.questions[mut.uuid];
			if (!src) return;
			const parent = findQuestionParent(draft, mut.uuid);
			if (!parent) return;

			// Clone the subtree off the current draft's state (Immer drafts
			// read through original, so this is safe).
			const { questions: clonedQ, questionOrder: clonedO, rootUuid } =
				cloneQuestionSubtree(draft as unknown as BlueprintDoc, mut.uuid);

			// Install cloned entities.
			for (const [uuid, q] of Object.entries(clonedQ)) {
				draft.questions[uuid as Uuid] = q;
			}
			for (const [parentUuid, order] of Object.entries(clonedO)) {
				draft.questionOrder[parentUuid as Uuid] = order;
			}

			// Dedupe top-level clone's id against parent's siblings.
			const clone = draft.questions[rootUuid];
			if (clone) {
				const deduped = dedupeSiblingId(
					draft,
					parent.parentUuid,
					clone.id,
					rootUuid,
				);
				clone.id = deduped;
			}

			// Insert clone right after the source in parent's order.
			const parentOrder = draft.questionOrder[parent.parentUuid];
			if (parentOrder) {
				parentOrder.splice(parent.index + 1, 0, rootUuid);
				draft.questionOrder[parent.parentUuid] = parentOrder;
			}
			return;
		}
```

Run tests — expect all passing.

- [ ] **Step 4: Commit**

```bash
git add lib/doc/mutations/questions.ts lib/doc/mutations/helpers.ts lib/doc/__tests__/mutations-questions.test.ts
git commit -m "feat(builder/doc): implement duplicateQuestion with deep subtree clone"
```

---

### Task 13: Build the Zustand store with middleware + load/pause/resume

**Files:**
- Create: `lib/doc/store.ts`
- Create: `lib/doc/__tests__/store.test.ts`

The store factory wraps `BlueprintDoc` + three actions (`apply`, `applyMany`, `load`) with Immer + zundo + subscribeWithSelector + devtools middleware. Temporal is paused on creation and by `load()`; `resumeTracking()` resumes. `beginAgentWrite()` and `endAgentWrite()` are convenience pairings for Phase 4 — implemented now so the API is complete.

Reference existing Zustand store patterns: `lib/services/builderStore.ts`. The new store uses the same middleware stack but a simpler API (no selection/nav/UI fields).

- [ ] **Step 1: Write the failing store tests**

Create `lib/doc/__tests__/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { asUuid } from "@/lib/doc/types";

describe("createBlueprintDocStore", () => {
	it("starts with an empty doc", () => {
		const store = createBlueprintDocStore();
		const doc = store.getState();
		expect(doc.appName).toBe("");
		expect(doc.moduleOrder).toEqual([]);
	});

	it("load() hydrates the doc from a blueprint", () => {
		const store = createBlueprintDocStore();
		const bp: AppBlueprint = {
			app_name: "Loaded",
			connect_type: undefined,
			modules: [{ name: "Mod", forms: [] }],
			case_types: null,
		};
		store.getState().load(bp, "app-1");
		const doc = store.getState();
		expect(doc.appName).toBe("Loaded");
		expect(doc.appId).toBe("app-1");
		expect(doc.moduleOrder).toHaveLength(1);
	});

	it("load() does NOT populate the undo stack", () => {
		const store = createBlueprintDocStore();
		store.getState().load(
			{
				app_name: "Loaded",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			"app-1",
		);
		expect(store.temporal.getState().pastStates).toHaveLength(0);
	});

	it("apply() captures a state change in the undo stack", () => {
		const store = createBlueprintDocStore();
		store.getState().load(
			{
				app_name: "Before",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			"app-1",
		);
		store.temporal.getState().resume();
		store.getState().apply({ kind: "setAppName", name: "After" });
		expect(store.getState().appName).toBe("After");
		expect(store.temporal.getState().pastStates.length).toBeGreaterThan(0);
	});

	it("applyMany() batches multiple mutations into a single undo entry", () => {
		const store = createBlueprintDocStore();
		store.getState().load(
			{
				app_name: "A",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			"app-1",
		);
		store.temporal.getState().resume();
		store.getState().applyMany([
			{ kind: "setAppName", name: "B" },
			{ kind: "setConnectType", connectType: "learn" },
		]);
		expect(store.getState().appName).toBe("B");
		expect(store.getState().connectType).toBe("learn");
		// Exactly one undo entry was added.
		expect(store.temporal.getState().pastStates).toHaveLength(1);
	});

	it("beginAgentWrite()/endAgentWrite() pause and resume undo tracking", () => {
		const store = createBlueprintDocStore();
		store.getState().load(
			{
				app_name: "A",
				connect_type: undefined,
				modules: [],
				case_types: null,
			},
			"app-1",
		);
		store.temporal.getState().resume();
		store.getState().beginAgentWrite();
		store.getState().apply({ kind: "setAppName", name: "During Agent" });
		expect(store.temporal.getState().pastStates).toHaveLength(0);
		store.getState().endAgentWrite();
		store.getState().apply({ kind: "setAppName", name: "After Agent" });
		expect(store.temporal.getState().pastStates).toHaveLength(1);
	});
});
```

Run tests — expect failure.

- [ ] **Step 2: Implement the store**

Create `lib/doc/store.ts`:

```ts
/**
 * BlueprintDoc Zustand store factory.
 *
 * Middleware stack (outer → inner):
 *   devtools        Redux-DevTools inspection, named "BlueprintDoc"
 *   temporal        zundo — undo/redo of every state change
 *   subscribeWithSelector  fine-grained subscriptions (used by hooks in Phase 3+)
 *   immer           structural-sharing mutable-syntax updates
 *
 * The store is created via a factory function so each builder mount gets
 * its own store instance (matches the existing pattern in
 * `lib/services/builderStore.ts`). Phase 1b's `<BlueprintDocProvider>`
 * calls this factory at mount time and exposes the instance via React
 * context.
 *
 * Temporal is paused on creation and across `load()`. Callers that want
 * captured undo history — i.e. the live builder — must call
 * `temporal.resume()` after load completes. Agent writes (Phase 4) pause
 * and re-resume via `beginAgentWrite()`/`endAgentWrite()` so a full
 * generation collapses into a single undoable unit.
 */

import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { temporal } from "zundo";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { toDoc } from "@/lib/doc/converter";
import { applyMutation, applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

export type BlueprintDocState = BlueprintDoc & {
	/** Apply a single mutation; captured as one undo entry while tracking. */
	apply: (mut: Mutation) => void;
	/** Apply a batch of mutations as one undo entry. */
	applyMany: (muts: Mutation[]) => void;
	/**
	 * Replace the doc from an AppBlueprint. Does NOT create an undo entry —
	 * loads are session hydration, not user edits.
	 */
	load: (bp: AppBlueprint, appId: string) => void;
	/** Pause undo tracking for an agent stream. */
	beginAgentWrite: () => void;
	/** Resume undo tracking after an agent stream completes. */
	endAgentWrite: () => void;
};

const EMPTY_DOC: BlueprintDoc = {
	appId: "",
	appName: "",
	connectType: null,
	caseTypes: null,
	modules: {},
	forms: {},
	questions: {},
	moduleOrder: [],
	formOrder: {},
	questionOrder: {},
};

/**
 * Create a fresh BlueprintDoc store. Each builder mount gets its own
 * instance (the store is NOT a module-level singleton).
 */
export function createBlueprintDocStore() {
	return create<BlueprintDocState>()(
		devtools(
			temporal(
				subscribeWithSelector(
					immer((set, get) => ({
						...EMPTY_DOC,
						apply: (mut) =>
							set((draft) => {
								applyMutation(draft, mut);
							}),
						applyMany: (muts) =>
							set((draft) => {
								applyMutations(draft, muts);
							}),
						load: (bp, appId) => {
							// Snapshot pause state — if tracking was already
							// paused we leave it paused after load.
							const temporal = (get() as unknown as {
								_temporal?: { pause: () => void };
							})._temporal;
							// Convert and replace the entire doc (no undo entry).
							const next = toDoc(bp, appId);
							set((draft) => {
								draft.appId = next.appId;
								draft.appName = next.appName;
								draft.connectType = next.connectType;
								draft.caseTypes = next.caseTypes;
								draft.modules = next.modules;
								draft.forms = next.forms;
								draft.questions = next.questions;
								draft.moduleOrder = next.moduleOrder;
								draft.formOrder = next.formOrder;
								draft.questionOrder = next.questionOrder;
							});
							// Clear any existing undo history — prior state was
							// an empty doc or an old session's data.
							store.temporal.getState().clear();
							// Keep tracking paused after load; caller resumes
							// once the UI is ready.
							store.temporal.getState().pause();
						},
						beginAgentWrite: () => {
							store.temporal.getState().pause();
						},
						endAgentWrite: () => {
							store.temporal.getState().resume();
						},
					})),
				),
				{
					// Capture applyMany batches as single undo entries.
					// zundo's default is every state change; we rely on it.
					limit: 100,
				},
			),
			{ name: "BlueprintDoc" },
		),
	);
	// `store` is referenced above inside `load`/`beginAgentWrite`/
	// `endAgentWrite`. Declare it below so the closures can capture it.
}
```

Wait — the `store` reference inside the factory won't resolve because the store isn't yet assigned. Refactor to assign to a variable:

```ts
export function createBlueprintDocStore() {
	const store = create<BlueprintDocState>()(
		devtools(
			temporal(
				subscribeWithSelector(
					immer((set) => ({
						...EMPTY_DOC,
						apply: (mut) =>
							set((draft) => {
								applyMutation(draft, mut);
							}),
						applyMany: (muts) =>
							set((draft) => {
								applyMutations(draft, muts);
							}),
						load: (bp, appId) => {
							const next = toDoc(bp, appId);
							set((draft) => {
								draft.appId = next.appId;
								draft.appName = next.appName;
								draft.connectType = next.connectType;
								draft.caseTypes = next.caseTypes;
								draft.modules = next.modules;
								draft.forms = next.forms;
								draft.questions = next.questions;
								draft.moduleOrder = next.moduleOrder;
								draft.formOrder = next.formOrder;
								draft.questionOrder = next.questionOrder;
							});
							store.temporal.getState().clear();
							store.temporal.getState().pause();
						},
						beginAgentWrite: () => {
							store.temporal.getState().pause();
						},
						endAgentWrite: () => {
							store.temporal.getState().resume();
						},
					})),
				),
				{ limit: 100 },
			),
			{ name: "BlueprintDoc" },
		),
	);
	// Pause tracking immediately — factory-created stores start with no
	// history, and hydration via `load()` should not generate undo entries.
	store.temporal.getState().pause();
	return store;
}
```

Run tests:

```bash
npx vitest run lib/doc/__tests__/store.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/store.ts lib/doc/__tests__/store.test.ts
git commit -m "feat(builder/doc): add Zustand store factory with temporal middleware"
```

---

### Task 14: Build low-level infrastructure hooks

**Files:**
- Create: `lib/doc/hooks/useBlueprintDoc.ts`

Expose three low-level hooks: `useBlueprintDoc(selector)` (reference-stable), `useBlueprintDocShallow(selector)` (shallow equality), `useBlueprintDocTemporal(selector)` (zundo temporal state). These are the ONLY place in the codebase that talks to the store directly. Domain hooks (Tasks 15–17) wrap these.

The store instance is provided via React context (Phase 1b wires the provider; for Phase 1a we build the hooks assuming the context exists).

- [ ] **Step 1: Create the hook surface**

Create `lib/doc/hooks/useBlueprintDoc.ts`:

```ts
/**
 * Low-level store subscription hooks.
 *
 * These three hooks are the ONLY place components can talk to the
 * BlueprintDoc store. Everything else in the codebase imports a named
 * domain hook from `lib/doc/hooks/**` and lets it handle the subscription
 * shape and memoization.
 *
 * Phase 6 enforces this rule via a Biome `noRestrictedImports` lint rule:
 * imports of this file from outside `lib/doc/hooks/**` will fail the build.
 *
 * The store instance comes from `BlueprintDocContext` (Phase 1b). Calling
 * any of these hooks outside a `<BlueprintDocProvider>` throws.
 */

import { useContext } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { TemporalState } from "zundo";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import type { BlueprintDocState } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";

/** Throw with a helpful message if the provider is missing. */
function useStoreInstance(): BlueprintDocStore {
	const store = useContext(BlueprintDocContext);
	if (!store) {
		throw new Error(
			"BlueprintDoc hooks require a <BlueprintDocProvider> ancestor",
		);
	}
	return store;
}

/**
 * Subscribe to a slice of the BlueprintDoc via a selector. Re-renders only
 * when the selected value changes (reference equality via `Object.is`).
 */
export function useBlueprintDoc<T>(selector: (s: BlueprintDocState) => T): T {
	const store = useStoreInstance();
	return useStore(store, selector);
}

/**
 * Subscribe with shallow equality — use when the selector returns a plain
 * object whose fields are primitives or stable references. Prevents
 * re-render on identity changes that don't affect any selected field.
 */
export function useBlueprintDocShallow<T>(
	selector: (s: BlueprintDocState) => T,
): T {
	const store = useStoreInstance();
	return useStore(store, useShallow(selector));
}

/**
 * Subscribe to zundo's temporal state (undo/redo history). Uses
 * `useStoreWithEqualityFn` (zundo's recommended API) — the default
 * `useStore` re-renders on every temporal change regardless of selector.
 */
export function useBlueprintDocTemporal<T>(
	selector: (t: TemporalState<BlueprintDoc>) => T,
	equalityFn?: (a: T, b: T) => boolean,
): T {
	const store = useStoreInstance();
	return useStoreWithEqualityFn(
		store.temporal,
		(t) => selector(t as TemporalState<BlueprintDoc>),
		equalityFn,
	);
}
```

Note: this imports from `@/lib/doc/provider`, which doesn't exist yet — Task 18 creates it. That's fine at this point because nothing outside this file imports from it yet. TypeScript will complain once the file compiles though.

- [ ] **Step 2: Stub the provider context so imports resolve**

Create `lib/doc/provider.tsx` as a minimal stub — Task 18 fills in the implementation:

```tsx
/**
 * BlueprintDoc React context + provider.
 *
 * Task 18 fills in the actual <BlueprintDocProvider> component. The
 * context is defined here so that hooks can import from a stable
 * module path even before the provider ships.
 */

"use client";

import { createContext } from "react";
import type { createBlueprintDocStore } from "@/lib/doc/store";

export type BlueprintDocStore = ReturnType<typeof createBlueprintDocStore>;

export const BlueprintDocContext = createContext<BlueprintDocStore | null>(null);
```

Typecheck:

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/hooks/useBlueprintDoc.ts lib/doc/provider.tsx
git commit -m "feat(builder/doc): add low-level store hooks + context stub"
```

---

### Task 15: Build entity lookup domain hooks

**Files:**
- Create: `lib/doc/hooks/useEntity.ts`
- Create: `lib/doc/__tests__/hooks.test.tsx`

`useQuestion(uuid)`, `useForm(uuid)`, `useModule(uuid)` — each returns a single entity or `undefined`. All three leverage Immer's structural sharing: the entity reference stays stable across mutations that don't touch that specific entity.

- [ ] **Step 1: Write the failing hooks tests**

Create `lib/doc/__tests__/hooks.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { useModule, useForm, useQuestion } from "@/lib/doc/hooks/useEntity";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

function setup() {
	const store = createBlueprintDocStore();
	const bp: AppBlueprint = {
		app_name: "Hooks Test",
		connect_type: undefined,
		modules: [
			{
				name: "Registration",
				forms: [
					{
						name: "Reg Form",
						type: "registration",
						questions: [
							{
								uuid: "q-111-0000-0000-0000-000000000000",
								id: "name",
								type: "text",
								label: "Name",
							},
						],
					},
				],
			},
		],
		case_types: null,
	};
	store.getState().load(bp, "app-1");
	const moduleUuid = store.getState().moduleOrder[0];
	const formUuid = store.getState().formOrder[moduleUuid][0];
	const questionUuid = store.getState().questionOrder[formUuid][0];
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper, moduleUuid, formUuid, questionUuid };
}

describe("useModule / useForm / useQuestion", () => {
	it("returns the entity when the uuid exists", () => {
		const { wrapper, moduleUuid } = setup();
		const { result } = renderHook(() => useModule(moduleUuid), { wrapper });
		expect(result.current?.name).toBe("Registration");
	});

	it("returns undefined for unknown uuids", () => {
		const { wrapper } = setup();
		const { result } = renderHook(
			() => useQuestion("missing-uuid" as never),
			{ wrapper },
		);
		expect(result.current).toBeUndefined();
	});

	it("does not re-render when an unrelated entity changes", () => {
		const { store, wrapper, questionUuid } = setup();
		let renderCount = 0;
		renderHook(
			() => {
				renderCount++;
				return useQuestion(questionUuid);
			},
			{ wrapper },
		);
		const initialRenders = renderCount;
		store.temporal.getState().resume();
		act(() => {
			store.getState().apply({ kind: "setAppName", name: "Changed" });
		});
		// setAppName doesn't touch any question entity, so Immer preserves
		// the reference — useQuestion must NOT re-render.
		expect(renderCount).toBe(initialRenders);
	});
});
```

Run tests — expect failure (module not found).

- [ ] **Step 2: Implement the entity hooks**

Create `lib/doc/hooks/useEntity.ts`:

```ts
/**
 * Entity lookup hooks — one hook per entity kind.
 *
 * Each returns the entity for a given uuid, or `undefined` if absent.
 * The returned reference is stable across mutations that don't touch
 * this specific entity (Immer structural sharing).
 */

import { useBlueprintDoc } from "./useBlueprintDoc";
import type {
	FormEntity,
	ModuleEntity,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";

export function useModule(uuid: Uuid): ModuleEntity | undefined {
	return useBlueprintDoc((s) => s.modules[uuid]);
}

export function useForm(uuid: Uuid): FormEntity | undefined {
	return useBlueprintDoc((s) => s.forms[uuid]);
}

export function useQuestion(uuid: Uuid): QuestionEntity | undefined {
	return useBlueprintDoc((s) => s.questions[uuid]);
}
```

Run tests — expect all passing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/hooks/useEntity.ts lib/doc/__tests__/hooks.test.tsx
git commit -m "feat(builder/doc): add entity lookup hooks (useQuestion, useForm, useModule)"
```

---

### Task 16: Build ordered collection domain hooks

**Files:**
- Create: `lib/doc/hooks/useOrderedChildren.ts`
- Create: `lib/doc/hooks/useModuleIds.ts`
- Modify: `lib/doc/__tests__/hooks.test.tsx`

Ordered hooks return memoized arrays. Each follows the two-tier pattern: shallow-select the source slices, then `useMemo` the derivation.

- [ ] **Step 1: Append failing tests**

Append to `lib/doc/__tests__/hooks.test.tsx`:

```tsx

import {
	useModuleIds,
	useOrderedForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { useOrderedChildren } from "@/lib/doc/hooks/useOrderedChildren";

describe("useModuleIds / useOrderedModules", () => {
	it("useModuleIds returns the moduleOrder array", () => {
		const { store, wrapper, moduleUuid } = setup();
		const { result } = renderHook(() => useModuleIds(), { wrapper });
		expect(result.current).toEqual([moduleUuid]);
	});

	it("useOrderedModules returns modules in moduleOrder sequence", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useOrderedModules(), { wrapper });
		expect(result.current).toHaveLength(1);
		expect(result.current[0].name).toBe("Registration");
	});

	it("useOrderedModules stays reference-stable when unrelated state changes", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(() => useOrderedModules(), { wrapper });
		const first = result.current;
		store.temporal.getState().resume();
		act(() => {
			store.getState().apply({ kind: "setAppName", name: "Different" });
		});
		expect(result.current).toBe(first);
	});
});

describe("useOrderedForms", () => {
	it("returns forms for a given module in order", () => {
		const { wrapper, moduleUuid } = setup();
		const { result } = renderHook(() => useOrderedForms(moduleUuid), {
			wrapper,
		});
		expect(result.current).toHaveLength(1);
		expect(result.current[0].name).toBe("Reg Form");
	});

	it("returns empty array when module doesn't exist", () => {
		const { wrapper } = setup();
		const { result } = renderHook(
			() => useOrderedForms("missing" as never),
			{ wrapper },
		);
		expect(result.current).toEqual([]);
	});
});

describe("useOrderedChildren", () => {
	it("returns questions under a given parent (form or group)", () => {
		const { wrapper, formUuid } = setup();
		const { result } = renderHook(() => useOrderedChildren(formUuid), {
			wrapper,
		});
		expect(result.current).toHaveLength(1);
		expect(result.current[0].id).toBe("name");
	});

	it("returns empty array when parent has no children or doesn't exist", () => {
		const { wrapper } = setup();
		const { result } = renderHook(
			() => useOrderedChildren("nope" as never),
			{ wrapper },
		);
		expect(result.current).toEqual([]);
	});
});
```

Run tests — expect failure.

- [ ] **Step 2: Implement the ordered-collection hooks**

Create `lib/doc/hooks/useOrderedChildren.ts`:

```ts
/**
 * Return the ordered child questions of a form or group/repeat.
 *
 * Uses the two-tier subscription pattern: shallow-select the specific
 * order array and the questions map, then memoize the derivation. The
 * returned array is reference-stable when neither the parent's ordering
 * nor any contained question entity has changed.
 */

import { useMemo } from "react";
import { useBlueprintDocShallow } from "./useBlueprintDoc";
import type { QuestionEntity, Uuid } from "@/lib/doc/types";

export function useOrderedChildren(parentUuid: Uuid): QuestionEntity[] {
	const { order, questions } = useBlueprintDocShallow((s) => ({
		order: s.questionOrder[parentUuid],
		questions: s.questions,
	}));
	return useMemo(
		() =>
			(order ?? [])
				.map((uuid) => questions[uuid])
				.filter((q): q is QuestionEntity => q !== undefined),
		[order, questions],
	);
}
```

Create `lib/doc/hooks/useModuleIds.ts`:

```ts
/**
 * Hooks over the module and form order arrays.
 */

import { useMemo } from "react";
import {
	useBlueprintDoc,
	useBlueprintDocShallow,
} from "./useBlueprintDoc";
import type { FormEntity, ModuleEntity, Uuid } from "@/lib/doc/types";

/** The raw moduleOrder array — reference-stable via Immer. */
export function useModuleIds(): Uuid[] {
	return useBlueprintDoc((s) => s.moduleOrder);
}

/** Modules in moduleOrder sequence. Memoized. */
export function useOrderedModules(): ModuleEntity[] {
	const { moduleOrder, modules } = useBlueprintDocShallow((s) => ({
		moduleOrder: s.moduleOrder,
		modules: s.modules,
	}));
	return useMemo(
		() =>
			moduleOrder
				.map((uuid) => modules[uuid])
				.filter((m): m is ModuleEntity => m !== undefined),
		[moduleOrder, modules],
	);
}

/** Form uuids for a given module, in order. Reference-stable via Immer. */
export function useFormIds(moduleUuid: Uuid): Uuid[] | undefined {
	return useBlueprintDoc((s) => s.formOrder[moduleUuid]);
}

/** Forms for a given module in order. Memoized; empty array for unknown modules. */
export function useOrderedForms(moduleUuid: Uuid): FormEntity[] {
	const { order, forms } = useBlueprintDocShallow((s) => ({
		order: s.formOrder[moduleUuid],
		forms: s.forms,
	}));
	return useMemo(
		() =>
			(order ?? [])
				.map((uuid) => forms[uuid])
				.filter((f): f is FormEntity => f !== undefined),
		[order, forms],
	);
}
```

Run tests — expect all passing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/hooks/useOrderedChildren.ts lib/doc/hooks/useModuleIds.ts lib/doc/__tests__/hooks.test.tsx
git commit -m "feat(builder/doc): add ordered-collection hooks (useOrderedModules/Forms/Children)"
```

---

### Task 17: Build `useAssembledForm` composite hook

**Files:**
- Create: `lib/doc/hooks/useAssembledForm.ts`
- Modify: `lib/doc/__tests__/hooks.test.tsx`

Some existing code paths — the expander, compiler, form preview — need the nested `BlueprintForm` shape rather than the flattened entity view. `useAssembledForm(formUuid)` runs the `toBlueprint`-style reconstruction for a single form, memoized.

- [ ] **Step 1: Append failing tests**

Append to `lib/doc/__tests__/hooks.test.tsx`:

```tsx

import { useAssembledForm } from "@/lib/doc/hooks/useAssembledForm";

describe("useAssembledForm", () => {
	it("reconstructs a form with nested questions", () => {
		const { wrapper, formUuid } = setup();
		const { result } = renderHook(() => useAssembledForm(formUuid), {
			wrapper,
		});
		expect(result.current?.name).toBe("Reg Form");
		expect(result.current?.questions).toHaveLength(1);
		expect(result.current?.questions[0].id).toBe("name");
	});

	it("returns undefined for unknown form uuids", () => {
		const { wrapper } = setup();
		const { result } = renderHook(
			() => useAssembledForm("missing" as never),
			{ wrapper },
		);
		expect(result.current).toBeUndefined();
	});
});
```

Run tests — expect failure.

- [ ] **Step 2: Implement the hook**

Create `lib/doc/hooks/useAssembledForm.ts`:

```ts
/**
 * Reconstruct the nested `BlueprintForm` shape for a single form.
 *
 * Used by consumers that predate the normalized doc model — the expander,
 * the XForms compiler, the form preview renderer. Memoized so the
 * reconstruction runs only when the form's entity or question subtree
 * changes.
 */

import { useMemo } from "react";
import { useBlueprintDocShallow } from "./useBlueprintDoc";
import type { BlueprintForm, Question } from "@/lib/schemas/blueprint";
import type {
	BlueprintDoc,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";

export function useAssembledForm(formUuid: Uuid): BlueprintForm | undefined {
	const { form, questions, questionOrder } = useBlueprintDocShallow((s) => ({
		form: s.forms[formUuid],
		questions: s.questions,
		questionOrder: s.questionOrder,
	}));

	return useMemo(() => {
		if (!form) return undefined;
		const { uuid: _ignored, ...formRest } = form;
		return {
			...formRest,
			questions: assembleQuestionTree(
				formUuid,
				questions,
				questionOrder,
			),
		};
	}, [form, formUuid, questions, questionOrder]);
}

function assembleQuestionTree(
	parentUuid: Uuid,
	questions: BlueprintDoc["questions"],
	questionOrder: BlueprintDoc["questionOrder"],
): Question[] {
	const order = questionOrder[parentUuid] ?? [];
	return order
		.map((uuid) => {
			const q = questions[uuid];
			if (!q) return undefined;
			const nested = questionOrder[uuid];
			return nested !== undefined
				? {
						...(q as QuestionEntity),
						children: assembleQuestionTree(
							uuid,
							questions,
							questionOrder,
						),
					}
				: (q as Question);
		})
		.filter((q): q is Question => q !== undefined);
}
```

Run tests — expect all passing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/hooks/useAssembledForm.ts lib/doc/__tests__/hooks.test.tsx
git commit -m "feat(builder/doc): add useAssembledForm composite hook"
```

---

### Task 18: Implement `BlueprintDocProvider`

**Files:**
- Modify: `lib/doc/provider.tsx`

Turn the stub from Task 14 into the full provider: accepts an initial blueprint, creates a store instance via the factory, loads the blueprint, and exposes the instance via context. Includes a dev-mode warning if the initial blueprint is missing.

- [ ] **Step 1: Rewrite `lib/doc/provider.tsx` with the full implementation**

Replace `lib/doc/provider.tsx` with:

```tsx
/**
 * BlueprintDoc React context + provider.
 *
 * Creates a new store instance per mount (matching the existing
 * `useBuilder.tsx` pattern — the builder is a singleton per route, but
 * the store itself is not a module-level global). Consumers access the
 * store via the hooks under `lib/doc/hooks/**`.
 *
 * Phase 0 added the Phase 0 types; Phase 1a builds the store and hooks
 * behind this provider; Phase 1b wires the provider into the builder
 * route layout.
 */

"use client";

import {
	createContext,
	type ReactNode,
	useRef,
} from "react";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import {
	type BlueprintDocState,
	createBlueprintDocStore,
} from "@/lib/doc/store";
import type { UseBoundStore, StoreApi } from "zustand";
import type { TemporalState } from "zundo";
import type { BlueprintDoc } from "@/lib/doc/types";

export type BlueprintDocStore = ReturnType<typeof createBlueprintDocStore>;

export const BlueprintDocContext = createContext<BlueprintDocStore | null>(null);

export interface BlueprintDocProviderProps {
	/**
	 * The blueprint to load on mount. If `undefined`, the provider creates
	 * an empty doc — useful for pre-generation states (Phase 1b's `Idle`
	 * phase before the SA has produced a scaffold).
	 */
	initialBlueprint?: AppBlueprint;
	/** The app's Firestore document ID. Attached to the doc's `appId`. */
	appId: string;
	/**
	 * Whether to begin with undo tracking active. Defaults to `true` —
	 * meaning the first user edit after load is undoable. Agent streams
	 * should pass `false`, then call `endAgentWrite()` after the stream
	 * completes.
	 */
	startTracking?: boolean;
	children: ReactNode;
}

export function BlueprintDocProvider({
	initialBlueprint,
	appId,
	startTracking = true,
	children,
}: BlueprintDocProviderProps) {
	const storeRef = useRef<BlueprintDocStore>(null);

	if (!storeRef.current) {
		const store = createBlueprintDocStore();
		if (initialBlueprint) {
			store.getState().load(initialBlueprint, appId);
		}
		if (startTracking) {
			store.temporal.getState().resume();
		}
		storeRef.current = store;
	}

	return (
		<BlueprintDocContext.Provider value={storeRef.current}>
			{children}
		</BlueprintDocContext.Provider>
	);
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/provider.tsx
git commit -m "feat(builder/doc): implement BlueprintDocProvider"
```

---

### Task 19: Full Phase 1a verification

**Files:**
- None modified.

- [ ] **Step 1: Run the full test suite**

```bash
npm test -- --run
```

Expected: all tests pass. The new `lib/doc/__tests__/*` tests should contribute ~75 new tests (converter ~12, store ~6, mutations-app ~5, mutations-modules ~10, mutations-forms ~12, mutations-questions ~18, hooks ~12).

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit && echo "✓ typecheck clean"
```

- [ ] **Step 3: Lint + format**

```bash
npm run lint
```

Expected: clean. If Biome reports formatting fixes, run `npm run format` and re-run lint.

- [ ] **Step 4: Production build**

```bash
npm run build
```

Expected: succeeds. Bundle size unchanged — nothing outside `lib/doc/` imports from these files.

- [ ] **Step 5: Verify no app-side consumption of the new module**

```bash
grep -rn '"@/lib/doc/' --include="*.ts" --include="*.tsx" app/ components/ hooks/ scripts/ 2>/dev/null | grep -v "lib/doc/" || echo "✓ no consumers"
```

Expected: `✓ no consumers` — the running app still ignores the new doc entirely.

- [ ] **Step 6: Review commit graph**

```bash
git log --oneline main..HEAD
```

Expected: ~17 new commits, each single-concern, each with a descriptive scoped message (e.g. `feat(builder/doc): implement module mutations with cascade delete`). No amended commits, no mixed-concern commits.

---

## Phase 1a complete

What exists at end of this phase:

- **`lib/doc/converter.ts`** — `toDoc(blueprint, appId)` flattens a nested blueprint into the normalized doc; `toBlueprint(doc)` rebuilds the nested form for save/export. Fully unit-tested with round-trip coverage.
- **`lib/doc/mutations/`** — complete mutation reducer split across `app.ts`, `modules.ts`, `forms.ts`, `questions.ts`, plus shared helpers. Every mutation kind in the `Mutation` union from Phase 0 has a handler with unit tests. `moveQuestion` and `renameQuestion` correctly rewrite XPath references; `duplicateQuestion` deep-clones subtrees with fresh UUIDs.
- **`lib/doc/store.ts`** — Zustand store factory (`createBlueprintDocStore`) with Immer + temporal + subscribeWithSelector + devtools middleware. `load()`, `apply()`, `applyMany()`, `beginAgentWrite()`, `endAgentWrite()` — full lifecycle API.
- **`lib/doc/hooks/`** — three low-level subscription hooks (`useBlueprintDoc`, `useBlueprintDocShallow`, `useBlueprintDocTemporal`) plus domain hooks (`useModule`, `useForm`, `useQuestion`, `useModuleIds`, `useOrderedModules`, `useFormIds`, `useOrderedForms`, `useOrderedChildren`, `useAssembledForm`).
- **`lib/doc/provider.tsx`** — `<BlueprintDocProvider>` React component and context.

What does NOT exist yet:

- Any wiring between the new doc and the running app. The existing `BuilderEngine`/`builderStore` remain the source of truth at runtime.
- The `syncOldFromDoc()` adapter (Phase 1b).
- Any component that imports from `lib/doc/`.

**Next plan:** Phase 1b — wire `BlueprintDocProvider` into the builder route, switch initial blueprint load to populate the doc, route old-store mutation actions through doc mutations + one-way sync back to the old store's entity maps, migrate consumers to doc hooks one at a time.
