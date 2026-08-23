import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { applyMutation } from "@/lib/doc/mutations";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";

import type { Field, Form, Module } from "@/lib/domain";
import { emptyCaseListConfig } from "@/lib/domain";

const M = (s: string) => testUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => testUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => testUuid(`qst${s}-0000-0000-0000-000000000000`);

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

	it("places a child within its parent's contiguous sibling block", () => {
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
				module: {
					...module_(M("B"), "B"),
					parentModuleUuid: M("A"),
				},
				after: null,
			});
		});
		expect(next.moduleOrder).toEqual([M("A"), M("B"), M("C")]);
		expect(next.modules[M("B")]?.parentModuleUuid).toBe(M("A"));
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

	it("refuses a parent removal until its child is removed first", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: module_(M("A"), "A"),
				[M("B")]: {
					...module_(M("B"), "B"),
					parentModuleUuid: M("A"),
				},
			},
			moduleOrder: [M("A"), M("B")],
			formOrder: { [M("A")]: [], [M("B")]: [] },
		};
		const refused = produce(start, (d) => {
			applyMutation(d, { kind: "removeModule", uuid: M("A") });
		});
		expect(refused.moduleOrder).toEqual(start.moduleOrder);

		const removed = produce(start, (d) => {
			applyMutation(d, { kind: "removeModule", uuid: M("B") });
			applyMutation(d, { kind: "removeModule", uuid: M("A") });
		});
		expect(removed.moduleOrder).toEqual([]);
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

	it("leaves the sequence unchanged when an unguarded anchor is gone", () => {
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
			// Live admission rejects this. The reducer remains total for replay,
			// but cannot translate the requested placement into append.
			applyMutation(d, { kind: "moveModule", uuid: M("A"), after: M("gone") });
		});
		expect(next.moduleOrder).toEqual([M("A"), M("B")]);
	});

	it("is a no-op when the module isn't in moduleOrder", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "moveModule", uuid: M("missing"), after: null });
		});
		expect(next.moduleOrder).toEqual([]);
	});

	it("moves a root together with its complete child block", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: module_(M("A"), "A"),
				[M("B")]: {
					...module_(M("B"), "B"),
					parentModuleUuid: M("A"),
				},
				[M("C")]: module_(M("C"), "C"),
			},
			moduleOrder: [M("A"), M("B"), M("C")],
			formOrder: { [M("A")]: [], [M("B")]: [], [M("C")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveModule",
				uuid: M("A"),
				after: M("C"),
			});
		});
		expect(next.moduleOrder).toEqual([M("C"), M("A"), M("B")]);
	});

	it("distinguishes preserved, root, and explicit-parent destinations", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: module_(M("A"), "A"),
				[M("B")]: {
					...module_(M("B"), "B"),
					parentModuleUuid: M("A"),
				},
				[M("C")]: module_(M("C"), "C"),
				[M("D")]: {
					...module_(M("D"), "D"),
					parentModuleUuid: M("C"),
				},
			},
			moduleOrder: [M("A"), M("B"), M("C"), M("D")],
			formOrder: {
				[M("A")]: [],
				[M("B")]: [],
				[M("C")]: [],
				[M("D")]: [],
			},
		};
		const preserved = produce(start, (d) => {
			applyMutation(d, { kind: "moveModule", uuid: M("B"), after: null });
		});
		expect(preserved.modules[M("B")]?.parentModuleUuid).toBe(M("A"));

		const promoted = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveModule",
				uuid: M("B"),
				parentModuleUuid: null,
				after: M("C"),
			});
		});
		expect(promoted.modules[M("B")]?.parentModuleUuid).toBeUndefined();
		expect(promoted.moduleOrder).toEqual([M("A"), M("C"), M("D"), M("B")]);

		const reparented = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveModule",
				uuid: M("B"),
				parentModuleUuid: M("C"),
				after: M("D"),
			});
		});
		expect(reparented.modules[M("B")]?.parentModuleUuid).toBe(M("C"));
		expect(reparented.moduleOrder).toEqual([M("A"), M("C"), M("D"), M("B")]);
	});

	it("does not let a stale narrow reorder undo a peer reparent", () => {
		const start: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[M("A")]: module_(M("A"), "A"),
				[M("B")]: {
					...module_(M("B"), "B"),
					parentModuleUuid: M("A"),
				},
				[M("C")]: module_(M("C"), "C"),
			},
			moduleOrder: [M("A"), M("B"), M("C")],
			formOrder: { [M("A")]: [], [M("B")]: [], [M("C")]: [] },
		};
		const merged = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveModule",
				uuid: M("B"),
				parentModuleUuid: M("C"),
				after: null,
			});
			// This command was authored while B still belonged to A. Its absent
			// parent intent must preserve B's fresh sibling group under C.
			applyMutation(d, { kind: "moveModule", uuid: M("B"), after: null });
		});
		expect(merged.modules[M("B")]?.parentModuleUuid).toBe(M("C"));
		expect(merged.moduleOrder).toEqual([M("A"), M("C"), M("B")]);
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
				patch: {},
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
				patch: {},
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
