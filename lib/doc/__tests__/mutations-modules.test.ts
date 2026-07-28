import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutation } from "@/lib/doc/mutations";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { Field, Form, Module } from "@/lib/domain";
import { emptyCaseListConfig } from "@/lib/domain";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);

function module_(uuid: Uuid, name: string): Module {
	return { uuid, name } as Module;
}
function form_(uuid: Uuid, name: string): Form {
	return { uuid, name, type: "survey" } as Form;
}
function field_(uuid: Uuid, id: string): Field {
	return { uuid, id, kind: "text" } as never as Field;
}

function emptyDoc(): BlueprintDoc {
	return {
		appId: "test",
		appName: "App",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
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

	it("inserts after the module it names", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: module_(M("A"), "A"),
				[M("C")]: module_(M("C"), "C"),
			},
			moduleOrder: [M("A"), M("C")],
			formOrder: { [M("A")]: [], [M("C")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "addModule",
				module: module_(M("B"), "B"),
				after: M("A"),
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

	it("cascades to forms and fields", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: { [M("A")]: module_(M("A"), "A") },
			forms: { [F("1")]: form_(F("1"), "F") },
			fields: { [Q("x")]: field_(Q("x"), "x") },
			moduleOrder: [M("A")],
			formOrder: { [M("A")]: [F("1")] },
			fieldOrder: { [F("1")]: [Q("x")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "removeModule", uuid: M("A") });
		});
		expect(next.forms[F("1")]).toBeUndefined();
		expect(next.fields[Q("x")]).toBeUndefined();
		expect(next.fieldOrder[F("1")]).toBeUndefined();
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
			applyMutation(d, { kind: "moveModule", uuid: M("A"), after: M("C") });
		});
		expect(next.moduleOrder).toEqual([M("B"), M("C"), M("A")]);
	});

	it("appends when the anchor is gone", () => {
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
			// A peer removed the anchor before this move replayed. Appending keeps
			// the reducer total, so historical replay never fails.
			applyMutation(d, { kind: "moveModule", uuid: M("A"), after: M("gone") });
		});
		expect(next.moduleOrder).toEqual([M("B"), M("A")]);
	});

	it("is a no-op when the module isn't in moduleOrder", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "moveModule", uuid: M("missing"), after: null });
		});
		expect(next.moduleOrder).toEqual([]);
	});
});

describe("renameModule", () => {
	it("updates the module's name (user-visible identifier)", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: { uuid: M("A"), name: "Original" } as Module,
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
				patch: { caseType: "patient" },
			});
		});
		expect(next.modules[M("A")]?.caseType).toBe("patient");
		expect(next.modules[M("A")]?.name).toBe("A"); // Other fields preserved
	});

	it("ignores updates to unknown module uuids", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, {
				kind: "updateModule",
				uuid: M("missing"),
				patch: { caseType: "patient" },
			});
		});
		expect(next.modules[M("missing")]).toBeUndefined();
	});
});

describe("updateModule.ensureCaseListConfig", () => {
	it("materializes the required empty shape when the config is absent", () => {
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
				patch: { caseListConfig: emptyCaseListConfig() },
				ensureCaseListConfig: true,
			});
		});
		expect(next.modules[M("A")]?.caseListConfig).toEqual(emptyCaseListConfig());
	});

	it("is idempotent and preserves a peer-populated config", () => {
		const existing = {
			columns: [
				{
					uuid: Q("col"),
					kind: "plain" as const,
					field: "case_name",
					header: "Name",
				},
			],
			listColumnOrder: [Q("col")],
			detailColumnOrder: [Q("col")],
			searchInputs: [],
			filter: { kind: "match-all" as const },
		};
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: { ...module_(M("A"), "A"), caseListConfig: existing },
			},
			moduleOrder: [M("A")],
			formOrder: { [M("A")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "updateModule",
				uuid: M("A"),
				patch: { caseListConfig: emptyCaseListConfig() },
				ensureCaseListConfig: true,
			});
		});
		expect(next.modules[M("A")]?.caseListConfig).toEqual(existing);
	});
});

describe("case-list column membership", () => {
	/** A module whose case list holds two columns, both on both screens. */
	function moduleWithColumns(): BlueprintDoc {
		const first = Q("col1");
		const second = Q("col2");
		return {
			...emptyDoc(),
			modules: {
				[M("A")]: {
					...module_(M("A"), "A"),
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								uuid: first,
								kind: "plain",
								field: "case_name",
								header: "Name",
							},
							{ uuid: second, kind: "plain", field: "age", header: "Age" },
						],
						listColumnOrder: [first, second],
						detailColumnOrder: [second, first],
						searchInputs: [],
					},
				} as Module,
			},
			moduleOrder: [M("A")],
			formOrder: { [M("A")]: [] },
		};
	}

	it("addColumn lands the column where each surface said", () => {
		const added = Q("col3");
		const next = produce(moduleWithColumns(), (d) => {
			applyMutation(d, {
				kind: "addColumn",
				moduleUuid: M("A"),
				column: {
					uuid: added,
					kind: "plain",
					field: "village",
					header: "Village",
				},
				afterInList: null,
				afterInDetail: Q("col2"),
			});
		});
		const config = next.modules[M("A")]?.caseListConfig;
		expect(config?.listColumnOrder).toEqual([added, Q("col1"), Q("col2")]);
		expect(config?.detailColumnOrder).toEqual([Q("col2"), added, Q("col1")]);
	});

	it("removeColumn takes the column out of BOTH sequences", () => {
		// A uuid left in a sequence is a member of neither screen and a member of
		// both orders — the disagreement `assembleBlueprint` refuses to persist,
		// and an anchor a later add could name.
		const next = produce(moduleWithColumns(), (d) => {
			applyMutation(d, {
				kind: "removeColumn",
				moduleUuid: M("A"),
				uuid: Q("col2"),
			});
		});
		const config = next.modules[M("A")]?.caseListConfig;
		expect(config?.columns.map((column) => column.uuid)).toEqual([Q("col1")]);
		expect(config?.listColumnOrder).toEqual([Q("col1")]);
		expect(config?.detailColumnOrder).toEqual([Q("col1")]);
	});
});
