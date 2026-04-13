import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutation } from "@/lib/doc/mutations";
import type {
	BlueprintDoc,
	FormEntity,
	ModuleEntity,
	Uuid,
} from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

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
