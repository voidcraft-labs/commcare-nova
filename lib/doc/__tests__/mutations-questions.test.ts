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

	it("rewrites XPath references when a question moves into a group", () => {
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
		// Path changed from `/data/source` to `/data/grp/source` — the
		// path-to-path rewriter updates matching absolute-path references.
		expect(next.questions[Q("ref")]?.calculate).toBe("/data/grp/source + 1");
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
