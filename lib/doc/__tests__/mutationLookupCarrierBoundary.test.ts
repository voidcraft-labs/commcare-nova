import { describe, expect, it } from "vitest";
import { canonicalMutationSchema, mutationSchema } from "@/lib/doc/types";
import { asUuid, type LookupColumnId, type LookupTableId } from "@/lib/domain";
import { eq, literal, tableColumn, tableLookup } from "@/lib/domain/predicate";

const FIELD = asUuid("10000000-0000-4000-8000-000000000001");
const PARENT = asUuid("10000000-0000-4000-8000-000000000002");
const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const VALUE = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const LABEL = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;

const source = {
	kind: "lookup" as const,
	tableId: TABLE,
	valueColumnId: VALUE,
	labelColumnId: LABEL,
	filter: eq(tableColumn(TABLE, LABEL), literal("Enabled")),
};

describe("lookup carriers use the one final-shape mutation envelope", () => {
	it("uses the exact same schema for live writes and durable replay", () => {
		expect(canonicalMutationSchema).toBe(mutationSchema);
	});

	it("carries a lookup source directly inside an added select field", () => {
		const payload = {
			kind: "addField",
			parentUuid: PARENT,
			field: {
				uuid: FIELD,
				kind: "single_select",
				id: "facility",
				label: "Facility",
				optionsSource: source,
			},
		};

		expect(mutationSchema.parse(payload)).toEqual(payload);
	});

	it("replaces the nested source and rejects null clearing", () => {
		expect(
			mutationSchema.parse({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: { optionsSource: source },
			}),
		).toMatchObject({ patch: { optionsSource: source } });
		expect(
			mutationSchema.safeParse({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: { optionsSource: null },
			}).success,
		).toBe(false);
	});

	it("admits lookup expressions recursively and rejects the removed top-level bridge", () => {
		const expression = tableLookup(
			TABLE,
			VALUE,
			eq(tableColumn(TABLE, LABEL), literal("Enabled")),
		);
		expect(
			mutationSchema.safeParse({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "text",
				patch: { calculate: expression },
			}).success,
		).toBe(true);
		expect(
			mutationSchema.safeParse({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: {},
				optionsSource: source,
			}).success,
		).toBe(false);
	});
});
