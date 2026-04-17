import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutation } from "@/lib/doc/mutations";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { Form, Module } from "@/lib/domain";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);

function form_(uuid: Uuid, name = "Form"): Form {
	return { uuid, name, type: "survey" } as Form;
}

function docWithModule(modUuid: Uuid): BlueprintDoc {
	return {
		appId: "test",
		appName: "App",
		connectType: null,
		caseTypes: null,
		modules: {
			[modUuid]: { uuid: modUuid, name: "M" } as Module,
		},
		forms: {},
		fields: {},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [] },
		fieldOrder: {},
		fieldParent: {},
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

	it("initializes an empty fieldOrder slot for the new form", () => {
		const next = produce(docWithModule(M("A")), (d) => {
			applyMutation(d, {
				kind: "addForm",
				moduleUuid: M("A"),
				form: form_(F("1")),
			});
		});
		expect(next.fieldOrder[F("1")]).toEqual([]);
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
	it("removes the form, its fieldOrder slot, and entry from module's formOrder", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1")) },
			formOrder: { [M("A")]: [F("1")] },
			fieldOrder: { [F("1")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "removeForm", uuid: F("1") });
		});
		expect(next.forms[F("1")]).toBeUndefined();
		expect(next.fieldOrder[F("1")]).toBeUndefined();
		expect(next.formOrder[M("A")]).toEqual([]);
	});

	it("cascades to fields", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1")) },
			fields: { [Q("a")]: { uuid: Q("a"), id: "a", kind: "text" } as never },
			formOrder: { [M("A")]: [F("1")] },
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "removeForm", uuid: F("1") });
		});
		expect(next.fields[Q("a")]).toBeUndefined();
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
			fieldOrder: { [F("1")]: [], [F("2")]: [] },
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
				[M("X")]: { uuid: M("X"), name: "X" } as Module,
				[M("Y")]: { uuid: M("Y"), name: "Y" } as Module,
			},
			forms: { [F("1")]: form_(F("1")) },
			fields: {},
			moduleOrder: [M("X"), M("Y")],
			formOrder: { [M("X")]: [F("1")], [M("Y")]: [] },
			fieldOrder: { [F("1")]: [] },
			fieldParent: {},
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
			fieldOrder: { [F("1")]: [] },
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

describe("replaceForm", () => {
	it("swaps entity, fields, and fieldOrder atomically", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1"), "Old") },
			fields: {
				[Q("old1")]: { uuid: Q("old1"), id: "old", kind: "text" } as never,
			},
			formOrder: { [M("A")]: [F("1")] },
			fieldOrder: { [F("1")]: [Q("old1")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "replaceForm",
				uuid: F("1"),
				form: { uuid: F("1"), name: "New", type: "registration" } as Form,
				fields: [
					{ uuid: Q("new1"), id: "new1", kind: "text" } as never,
					{ uuid: Q("new2"), id: "new2", kind: "integer" } as never,
				],
				fieldOrder: { [F("1")]: [Q("new1"), Q("new2")] },
			});
		});
		expect(next.forms[F("1")]?.name).toBe("New");
		expect(next.forms[F("1")]?.type).toBe("registration");
		expect(next.fields[Q("old1")]).toBeUndefined();
		expect(next.fields[Q("new1")]?.id).toBe("new1");
		expect(next.fieldOrder[F("1")]).toEqual([Q("new1"), Q("new2")]);
	});

	it("populates nested fieldOrder for groups in the replacement", () => {
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1")) },
			fields: {},
			formOrder: { [M("A")]: [F("1")] },
			fieldOrder: { [F("1")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "replaceForm",
				uuid: F("1"),
				form: form_(F("1")),
				fields: [
					{ uuid: Q("grp"), id: "grp", kind: "group" } as never,
					{ uuid: Q("child"), id: "child", kind: "text" } as never,
				],
				fieldOrder: {
					[F("1")]: [Q("grp")],
					[Q("grp")]: [Q("child")],
				},
			});
		});
		expect(next.fieldOrder[F("1")]).toEqual([Q("grp")]);
		expect(next.fieldOrder[Q("grp")]).toEqual([Q("child")]);
	});

	it("is a no-op when the target form doesn't exist", () => {
		const next = produce(docWithModule(M("A")), (d) => {
			applyMutation(d, {
				kind: "replaceForm",
				uuid: F("missing"),
				form: form_(F("missing")),
				fields: [],
				fieldOrder: { [F("missing")]: [] },
			});
		});
		expect(next.forms[F("missing")]).toBeUndefined();
	});

	it("throws when mut.form.uuid does not match mut.uuid", () => {
		// Reducer contract: the mutation's `uuid` (which form slot to replace)
		// must equal the new form entity's own `.uuid`. A mismatch would
		// install an entity whose self-reported identity disagrees with its
		// key in `draft.forms` — every downstream consumer would read a form
		// with the wrong uuid and break.
		const start: BlueprintDoc = {
			...docWithModule(M("A")),
			forms: { [F("1")]: form_(F("1")) },
			formOrder: { [M("A")]: [F("1")] },
			fieldOrder: { [F("1")]: [] },
		};
		expect(() => {
			produce(start, (d) => {
				applyMutation(d, {
					kind: "replaceForm",
					uuid: F("1"),
					// Wrong uuid on the entity payload — reducer must reject.
					form: form_(F("2")),
					fields: [],
					fieldOrder: { [F("1")]: [] },
				});
			});
		}).toThrow(/replaceForm/);
	});
});
