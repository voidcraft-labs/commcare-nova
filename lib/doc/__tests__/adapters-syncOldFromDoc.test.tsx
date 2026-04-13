/**
 * Tests for the one-way `syncOldFromDoc` adapter.
 *
 * Intentionally avoids React entirely — the adapter is a pure Zustand
 * subscription, and the hook-rules issues Task 3 ran into are not worth
 * inviting again. We wire two stores by hand, hydrate both from the same
 * blueprint, dispatch mutations directly against the doc, and read the
 * projected state off `oldStore.getState()` after each dispatch.
 */

import { describe, expect, it } from "vitest";
import { startSyncOldFromDoc } from "@/lib/doc/adapters/syncOldFromDoc";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { ModuleEntity } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { BuilderPhase } from "@/lib/services/builder";
import { createBuilderStore } from "@/lib/services/builderStore";

/** Canonical source blueprint shared by every test — one module, one survey
 *  form, one top-level question with a known uuid so we can target it in
 *  `renameQuestion` dispatches without going through a path resolver. */
const Q_UUID = "q-0000-0000-0000-0000-000000000000";
const BP: AppBlueprint = {
	app_name: "App",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			name: "M",
			forms: [
				{
					name: "F",
					type: "survey",
					questions: [
						{
							uuid: Q_UUID,
							id: "a",
							type: "text",
							label: "A",
						},
					],
				},
			],
		},
	],
};

/** Build a matched pair of freshly-hydrated doc and legacy stores. The
 *  adapter's contract is "given two already-hydrated stores, keep the
 *  legacy store's entity slice in sync with the doc from here forward,"
 *  so both tests start from this exact baseline. */
function setup() {
	const docStore = createBlueprintDocStore();
	docStore.getState().load(BP, "app");

	const oldStore = createBuilderStore(BuilderPhase.Ready);
	oldStore.getState().loadApp("app", BP);

	const stop = startSyncOldFromDoc(docStore, oldStore);
	return { docStore, oldStore, stop };
}

describe("syncOldFromDoc", () => {
	it("mirrors doc entity maps into the old store on mutation", () => {
		const { docStore, oldStore, stop } = setup();

		// Rename the question through the doc; the adapter should project the
		// new `id` into the legacy store's `questions` map synchronously.
		docStore.getState().apply({
			kind: "renameQuestion",
			uuid: asUuid(Q_UUID),
			newId: "alpha",
		});

		const questionIds = Object.values(oldStore.getState().questions).map(
			(q) => q.id,
		);
		expect(questionIds).toContain("alpha");
		expect(questionIds).not.toContain("a");

		stop();
	});

	it("projects moduleOrder when a new module is added", () => {
		const { docStore, oldStore, stop } = setup();

		// Baseline: one module in each store.
		expect(oldStore.getState().moduleOrder).toHaveLength(1);

		// Add a second module through the doc. The adapter should lengthen
		// the legacy `moduleOrder` and make the new entity available in
		// `modules`.
		const newModuleUuid = asUuid("m-1111-1111-1111-1111-111111111111");
		const newModule: ModuleEntity = {
			uuid: newModuleUuid,
			name: "NewMod",
		} as ModuleEntity;
		docStore.getState().apply({
			kind: "addModule",
			module: newModule,
		});

		const legacy = oldStore.getState();
		expect(legacy.moduleOrder).toHaveLength(2);
		expect(legacy.moduleOrder).toContain(newModuleUuid);
		expect(legacy.modules[newModuleUuid]?.name).toBe("NewMod");

		stop();
	});

	it("short-circuits when no mirrored field changed", () => {
		const { docStore, oldStore, stop } = setup();

		// Snapshot the legacy entity maps before a no-op change. Setting the
		// same app name keeps the entity references stable, so we expect the
		// adapter to project once (on the initial tick) and then not touch
		// entity maps again on the redundant write.
		const beforeModules = oldStore.getState().modules;
		const beforeQuestions = oldStore.getState().questions;

		docStore.getState().apply({ kind: "setAppName", name: "App" });

		// Entity map references should be unchanged — app-name edits never
		// rewrite the entity slots, and shallow-equal short-circuit keeps the
		// adapter from redundantly reassigning them.
		const afterModules = oldStore.getState().modules;
		const afterQuestions = oldStore.getState().questions;
		expect(afterModules).toBe(beforeModules);
		expect(afterQuestions).toBe(beforeQuestions);

		stop();
	});

	it("dispose stops further projections", () => {
		const { docStore, oldStore, stop } = setup();

		// Tear down the subscription, then mutate the doc. The legacy store
		// should retain its pre-dispose question id — proving the adapter is
		// no longer listening.
		stop();

		docStore.getState().apply({
			kind: "renameQuestion",
			uuid: asUuid(Q_UUID),
			newId: "beta",
		});

		const questionIds = Object.values(oldStore.getState().questions).map(
			(q) => q.id,
		);
		expect(questionIds).toContain("a");
		expect(questionIds).not.toContain("beta");
	});
});
