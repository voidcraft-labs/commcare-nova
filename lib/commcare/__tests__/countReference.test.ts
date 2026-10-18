import { describe, expect, it } from "vitest";
import type {
	FormStructure,
	FormStructureField,
} from "@/lib/domain/expression/formStructure";
import type { Expression } from "@/lib/domain/expression/types";
import {
	directRepeatCountReference,
	planRepeatCountCarriers,
} from "@/lib/domain/repeatCount";
import { asUuid, type Uuid } from "@/lib/domain/uuid";
import { planRepeatCountNames } from "../xform/repeatCountNames";

const formUuid = asUuid("11111111-1111-4111-8111-111111111111");
const question = asUuid("22222222-2222-4222-8222-222222222222");
const first = asUuid("33333333-3333-4333-8333-333333333333");
const second = asUuid("44444444-4444-4444-8444-444444444444");
const occupied = asUuid("55555555-5555-4555-8555-555555555555");
const direct: Expression = {
	kind: "term",
	term: { kind: "field", uuid: question },
};
const computed: Expression = {
	kind: "term",
	term: { kind: "literal", value: 2 },
};
function structure(expressionAt: FormStructure["expressionAt"]): FormStructure {
	const fields = new Map<Uuid, FormStructureField>([
		[question, { uuid: question, id: "n", kind: "int", parent: formUuid }],
		[
			occupied,
			{ uuid: occupied, id: "nova_count_a", kind: "text", parent: formUuid },
		],
		[
			first,
			{
				uuid: first,
				id: "a",
				kind: "repeat",
				repeatMode: "count_bound",
				parent: formUuid,
			},
		],
		[
			second,
			{
				uuid: second,
				id: "a_1",
				kind: "repeat",
				repeatMode: "count_bound",
				parent: formUuid,
			},
		],
	]);
	return {
		formUuid,
		moduleUuid: formUuid,
		type: "survey",
		fields,
		fieldOrder: new Map([[formUuid, [...fields.keys()]]]),
		connect: {},
		links: new Map(),
		expressionAt,
	};
}

describe("repeat count identity and carrier planning", () => {
	it("only reads a bare absolute question directly", () => {
		const fields = new Map([[question, { kind: "int" as const }]]);
		expect(directRepeatCountReference(direct, fields)).toBe(question);
		for (const spelling of ["relative", "current"] as const)
			expect(
				directRepeatCountReference(
					{ kind: "term", term: { kind: "field", uuid: question, spelling } },
					fields,
				),
			).toBeUndefined();
		expect(
			directRepeatCountReference(
				direct,
				new Map([[question, { kind: "hidden" }]]),
			),
		).toBeUndefined();
		expect(directRepeatCountReference(computed, fields)).toBeUndefined();
	});
	it("reserves every potential carrier name without reading pending expressions", () => {
		const form = structure(() => {
			throw new Error("Names cannot depend on expression parsing.");
		});
		const names = planRepeatCountNames(form);
		expect(names.get(first)).toBe("nova_count_a_1");
		expect(names.get(second)).toBe("nova_count_a_1_1");
		expect(planRepeatCountNames(form)).toBe(names);
	});
	it("evaluates each count lazily and materializes a referenced direct count", () => {
		const reads: Uuid[] = [];
		const form = structure((slot) => {
			reads.push(slot.uuid);
			return slot.uuid === first ? direct : computed;
		});
		const carriers = planRepeatCountCarriers(form, new Set([first]));
		expect(reads).toEqual([]);
		expect(carriers.forRepeat(question)).toBeUndefined();
		expect(reads).toEqual([]);
		expect(carriers.forRepeat(first)).toEqual({
			expression: direct,
			directReference: question,
			materialized: true,
		});
		carriers.forRepeat(first);
		expect(reads).toEqual([first]);
		expect(carriers.forRepeat(second)).toEqual({
			expression: computed,
			materialized: true,
		});
		expect(reads).toEqual([first, second]);
		expect(
			planRepeatCountCarriers(form, new Set()).forRepeat(first)?.materialized,
		).toBe(false);
	});
});
