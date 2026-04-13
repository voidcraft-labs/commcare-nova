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
