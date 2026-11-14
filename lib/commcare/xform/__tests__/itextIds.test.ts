/**
 * An itext id is the field's path joined with `-`, then `-` and a role. A
 * hyphen an id holds is written twice, so two fields never share a key: a
 * form holding the root question `a-b` and the question `b` inside group `a`
 * keeps one itext entry for each. A form with no hyphenated id keeps exactly
 * the ids it had before question ids could hold one.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { formItextUnits } from "../itextIds";

interface TreeSpec {
	readonly id: string;
	readonly hint: boolean;
	readonly choices: number;
	readonly children?: readonly TreeSpec[];
}

const IDS = ["a", "b", "a-", "a-b", "b-a", "a--b", "c-1"] as const;

const leaf = fc.record({
	id: fc.constantFrom(...IDS),
	hint: fc.boolean(),
	choices: fc.integer({ min: 0, max: 2 }),
});
const siblings = <T extends { id: string }>(item: fc.Arbitrary<T>) =>
	fc.uniqueArray(item, {
		selector: (spec) => spec.id,
		minLength: 1,
		maxLength: 4,
	});
const tree: fc.Arbitrary<readonly TreeSpec[]> = siblings(
	fc.oneof(
		leaf,
		fc.record({
			id: fc.constantFrom(...IDS),
			hint: fc.constant(false),
			choices: fc.constant(0),
			children: siblings(
				fc.oneof(
					leaf,
					fc.record({
						id: fc.constantFrom(...IDS),
						hint: fc.constant(false),
						choices: fc.constant(0),
						children: siblings(leaf),
					}),
				),
			),
		}),
	),
);

function fieldOf(spec: TreeSpec): ReturnType<typeof f> {
	if (spec.children !== undefined)
		return f({
			kind: "group",
			id: spec.id,
			label: spec.id,
			children: spec.children.map(fieldOf),
		});
	if (spec.choices > 0)
		return f({
			kind: "single_select",
			id: spec.id,
			label: spec.id,
			options: Array.from({ length: spec.choices }, (_, index) => ({
				value: `v${index}`,
				label: `Choice ${index}`,
			})),
		});
	return f({
		kind: "text",
		id: spec.id,
		label: spec.id,
		...(spec.hint ? { hint: `About ${spec.id}` } : {}),
	});
}

function surveyOf(fields: readonly ReturnType<typeof f>[]): {
	doc: BlueprintDoc;
	formUuid: Uuid;
} {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [{ name: "Survey", type: "survey", fields: [...fields] }],
			},
		],
	});
	return { doc, formUuid: doc.formOrder[doc.moduleOrder[0]][0] };
}

describe("fieldItextKey", () => {
	it("gives every declared unit of a form its own itext id", () => {
		fc.assert(
			fc.property(tree, (specs) => {
				const { doc, formUuid } = surveyOf(specs.map(fieldOf));
				const form = formStructure(doc, formUuid);
				if (form === undefined) throw new Error("no form structure");
				let declared = 0;
				for (const field of form.fields.values()) {
					declared += field.proseSlots?.length ?? 0;
					if (field.choices?.kind === "inline")
						declared += field.choices.options.length;
				}
				expect(formItextUnits(form).size).toBe(declared);
			}),
			{ seed: 20261113, numRuns: 200 },
		);
	});

	it("keeps the ids of a form whose question ids hold no hyphen", () => {
		const { doc, formUuid } = surveyOf([
			f({ kind: "text", id: "name", label: "Name", hint: "Full name" }),
			f({
				kind: "group",
				id: "household",
				label: "Household",
				children: [
					f({
						kind: "single_select",
						id: "kind",
						label: "Kind",
						options: [
							{ value: "own", label: "Own" },
							{ value: "rent", label: "Rent" },
						],
					}),
				],
			}),
		]);
		const form = formStructure(doc, formUuid);
		if (form === undefined) throw new Error("no form structure");
		expect([...formItextUnits(form).keys()].sort()).toEqual(
			[
				"name-label",
				"name-hint",
				"household-label",
				"household-kind-label",
				"household-kind-opt0-label",
				"household-kind-opt1-label",
			].sort(),
		);
	});

	it("doubles an id's own hyphen, so a root a-b and a group a's b stay apart", () => {
		const { doc, formUuid } = surveyOf([
			f({ kind: "text", id: "a-b", label: "Root" }),
			f({
				kind: "group",
				id: "a",
				label: "Group",
				children: [f({ kind: "text", id: "b", label: "Nested" })],
			}),
		]);
		const form = formStructure(doc, formUuid);
		if (form === undefined) throw new Error("no form structure");
		expect([...formItextUnits(form).keys()].sort()).toEqual(
			["a--b-label", "a-label", "a-b-label"].sort(),
		);
	});
});
