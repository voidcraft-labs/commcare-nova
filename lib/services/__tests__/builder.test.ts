/**
 * Tests for `applyDataPart` — the dispatcher that translates AI SDK stream
 * data parts into store/doc mutations during both live streaming and replay.
 *
 * The regression of interest is `data-blueprint-updated` (the SA's post-build
 * edit path) landing in the doc store. Before the fix, the emission called
 * `completeGeneration(bp)` but nothing ever unpacked `bp` into the doc,
 * silently dropping edits made by tools like `updateModule`, `createForm`,
 * and cross-form rename flows.
 */

import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { applyDataPart } from "@/lib/services/builder";
import { BuilderEngine } from "@/lib/services/builderEngine";

/** Tiny fixture: one module, one form, one question. Enough to verify that
 *  `data-blueprint-updated` fully replaces the doc's entity state with the
 *  incoming blueprint's contents. */
const INITIAL_BP: AppBlueprint = {
	app_name: "Initial",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			name: "Module A",
			case_type: undefined,
			forms: [
				{
					name: "Form A",
					type: "survey",
					questions: [
						{
							uuid: "00000000-0000-0000-0000-000000000001",
							id: "q1",
							type: "text",
							label: "Q1",
						},
					],
				},
			],
		},
	],
};

/** Same structure but with renamed app, an added module, and a second
 *  question on Form A — simulates what an SA edit tool would produce. */
const EDITED_BP: AppBlueprint = {
	app_name: "Edited",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			name: "Module A Renamed",
			case_type: undefined,
			forms: [
				{
					name: "Form A",
					type: "survey",
					questions: [
						{
							uuid: "00000000-0000-0000-0000-000000000001",
							id: "q1",
							type: "text",
							label: "Q1 edited",
						},
						{
							uuid: "00000000-0000-0000-0000-000000000002",
							id: "q2",
							type: "text",
							label: "Q2",
						},
					],
				},
			],
		},
		{
			name: "Module B",
			case_type: undefined,
			forms: [],
		},
	],
};

/** Build a minimally wired engine + doc store pair that mimics the runtime
 *  provider setup: the doc store is installed on the engine via
 *  `setDocStore`, the legacy store is loaded, and the doc is hydrated from
 *  the initial blueprint. Returns both halves for direct assertions. */
function setupEngine() {
	const engine = new BuilderEngine();
	const docStore = createBlueprintDocStore();
	docStore.getState().load(INITIAL_BP, "app-under-test");
	/* Resume temporal so subsequent mutations enter the history — matches
	 * the real provider (`startTracking={true}` for loaded apps). */
	docStore.temporal.getState().resume();
	engine.setDocStore(docStore);
	engine.store.getState().loadApp("app-under-test");
	return { engine, docStore };
}

describe("applyDataPart — data-blueprint-updated", () => {
	it("dispatches the updated blueprint to the doc store", () => {
		const { engine, docStore } = setupEngine();

		// Precondition: the doc carries the INITIAL_BP state.
		expect(docStore.getState().appName).toBe("Initial");
		expect(docStore.getState().moduleOrder).toHaveLength(1);
		expect(Object.keys(docStore.getState().questions)).toHaveLength(1);

		// Simulate the SA post-build edit stream: a single
		// `data-blueprint-updated` emission with the rewritten blueprint.
		applyDataPart(engine, "data-blueprint-updated", {
			blueprint: EDITED_BP as unknown as Record<string, unknown>,
		});

		// Postcondition: the doc reflects the EDITED_BP state. If the
		// regression returns, none of these assertions hold — the doc
		// stays pinned to the INITIAL_BP values because completeGeneration
		// only flips lifecycle flags without touching entity data.
		const doc = docStore.getState();
		expect(doc.appName).toBe("Edited");
		expect(doc.moduleOrder).toHaveLength(2);
		const firstModule = doc.modules[doc.moduleOrder[0]];
		expect(firstModule.name).toBe("Module A Renamed");
		expect(Object.keys(doc.questions)).toHaveLength(2);
		const questionLabels = Object.values(doc.questions)
			.map((q) => q.label)
			.sort();
		expect(questionLabels).toEqual(["Q1 edited", "Q2"]);
	});
});
