import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutation } from "@/lib/doc/mutations";
import type {
	BlueprintDoc,
	FormEntity,
	ModuleEntity,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);

function module_(uuid: Uuid, name: string): ModuleEntity {
	return { uuid, name } as ModuleEntity;
}
function form_(uuid: Uuid, name: string): FormEntity {
	return { uuid, name, type: "survey" } as FormEntity;
}
function field_(uuid: Uuid, id: string): QuestionEntity {
	return { uuid, id, kind: "text" } as never as QuestionEntity;
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

	it("inserts at index when provided", () => {
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
