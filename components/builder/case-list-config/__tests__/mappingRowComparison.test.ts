/**
 * Contract: turning a mapping row into a condition through its comparison menu commits through
 * the real gate, including a row saved before rows carried identities (an app brought in from
 * HQ, or a document saved earlier), and turning it back keeps its saved value. The plausible
 * failure: the patch carries no identity, and the gate refuses a condition row with none
 * (CASE_LIST_MAPPING_CONDITION), so the author can't convert the row in place.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Column,
	idMappingColumn,
	idMappingEntry,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { mappingComparisonPatch } from "../mappingRowComparison";

const NAME = "00000000-0000-4000-8000-000000000001" as Uuid;
const WATER = "00000000-0000-4000-8000-000000000002" as Uuid;

function app(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "water", label: proseText("Water") }],
			},
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "household", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "water",
								caseWrite: { caseType: "household", property: "water" },
							}),
						],
					},
				],
				caseListConfig: {
					columns: [
						plainColumn(NAME, "case_name", "Name"),
						{
							...idMappingColumn(WATER, "water", "Water", [
								idMappingEntry("tap", "Tap"),
							]),
							behavior: "first-match",
						},
					],
					searchInputs: [],
				},
			},
		],
	});
}

/** The card's row update: the patch merged in, cleared keys dropped. */
function patched(column: Column, patch: object): Column {
	if (column.kind !== "id-mapping") throw new Error("Expected a mapping.");
	const [row] = column.mapping;
	return {
		...column,
		mapping: [
			Object.fromEntries(
				Object.entries({ ...row, ...patch }).filter(([, v]) => v !== undefined),
			) as (typeof column.mapping)[number],
		],
	};
}

function commit(doc: BlueprintDoc, column: Column) {
	const moduleUuid = doc.moduleOrder[0] as Uuid;
	const { uuid: _uuid, ...content } = column;
	return mutationCommitVerdict(
		doc,
		[{ kind: "updateColumn", moduleUuid, uuid: WATER, column: content }],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
}

describe("a mapping row's comparison", () => {
	it("turns a row with no identity into a condition the gate admits", () => {
		const doc = app();
		const moduleUuid = doc.moduleOrder[0] as Uuid;
		const column = doc.modules[moduleUuid]?.caseListConfig?.columns.find(
			(one) => one.uuid === WATER,
		);
		if (column?.kind !== "id-mapping") throw new Error("Expected a mapping.");
		const [row] = column.mapping;
		expect(row?.uuid).toBeUndefined();
		const condition = patched(
			column,
			mappingComparisonPatch(row ?? {}, "condition", false),
		);
		const verdict = commit(doc, condition);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		if (condition.kind !== "id-mapping") throw new Error("Expected a mapping.");
		const [rule] = condition.mapping;
		expect(rule?.uuid).toBeDefined();
		expect(rule?.when).toBeDefined();
		// Back to a saved value: the identity stays, the condition goes.
		expect(mappingComparisonPatch(rule ?? {}, "exact", false)).toEqual({
			value: "",
			when: undefined,
		});
	});
});
