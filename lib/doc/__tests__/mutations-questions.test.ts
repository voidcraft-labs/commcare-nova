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

function question_(
	uuid: Uuid,
	id: string,
	patch: Partial<QuestionEntity> = {},
): QuestionEntity {
	return { uuid, id, type: "text", ...patch } as QuestionEntity;
}

function docWithForm(): BlueprintDoc {
	return {
		appId: "test",
		appName: "A",
		connectType: null,
		caseTypes: null,
		modules: { [M("X")]: { uuid: M("X"), name: "M" } as ModuleEntity },
		forms: {
			[F("1")]: { uuid: F("1"), name: "F", type: "survey" } as FormEntity,
		},
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
