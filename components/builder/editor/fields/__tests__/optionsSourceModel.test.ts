import { describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
	selectOptionsSourceSchema,
} from "@/lib/domain";
import { eq, literal, tableColumn } from "@/lib/domain/predicate";
import {
	beginOptionsSource,
	completeLookupSource,
	freshInlineSource,
	withoutFilter,
} from "../optionsSourceModel";

const tableId = lookupTableIdSchema.parse(
	"00000000-0000-7000-8000-000000000501",
);
const code = lookupColumnIdSchema.parse("00000000-0000-7000-8000-000000000502");
const label = lookupColumnIdSchema.parse(
	"00000000-0000-7000-8000-000000000503",
);
const table = {
	id: tableId,
	name: "Facilities",
	columns: [
		{ id: code, wireName: "code", label: "Code", dataType: "text" as const },
		{ id: label, wireName: "label", label: "Label", dataType: "text" as const },
	],
};
const bound = {
	kind: "lookup" as const,
	tableId,
	valueColumnId: code,
	labelColumnId: label,
};
describe("actual options-source staging model", () => {
	it("starts one unbound table arm and never infers the two column roles", () => {
		const source = freshInlineSource();
		const original = structuredClone(source);
		const transition = beginOptionsSource(source, tableId, [table]);
		expect(transition).toEqual({
			kind: "draft",
			draft: { kind: "lookup", tableId },
		});
		expect(source).toEqual(original);
		if (transition.kind !== "draft") throw new Error("Expected draft");
		expect(completeLookupSource(transition.draft, table)).toBeUndefined();
	});
	it("completes only the exact current table and two current column identities", () => {
		expect(
			completeLookupSource({ ...bound, labelColumnId: undefined }, table),
		).toBeUndefined();
		expect(
			completeLookupSource(bound, {
				...table,
				columns: table.columns.slice(0, 1),
			}),
		).toBeUndefined();
		expect(completeLookupSource(bound, undefined)).toBeUndefined();
		const filter = eq(tableColumn(tableId, code), literal("north"));
		const complete = completeLookupSource({ ...bound, filter }, table);
		expect(complete).toEqual({ ...bound, filter });
		expect(selectOptionsSourceSchema.safeParse(complete).success).toBe(true);
		expect(complete?.filter).toBe(filter);
	});
	it("selecting the committed source discards a staged alternative without editing it", () => {
		const inline = freshInlineSource();
		expect(beginOptionsSource(inline, "inline", [table])).toEqual({
			kind: "draft",
			draft: null,
		});
		expect(beginOptionsSource(bound, tableId, [table])).toEqual({
			kind: "draft",
			draft: null,
		});
		expect(beginOptionsSource(bound, null, [table])).toEqual({
			kind: "unchanged",
		});
	});
	it("returning to inline creates fresh schema-admitted option identities and no dormant receiver", () => {
		const first = beginOptionsSource(bound, "inline", [table]);
		const second = beginOptionsSource(bound, "inline", [table]);
		if (
			first.kind !== "draft" ||
			first.draft?.kind !== "inline" ||
			second.kind !== "draft" ||
			second.draft?.kind !== "inline"
		)
			throw new Error("Expected inline drafts");
		expect(selectOptionsSourceSchema.safeParse(first.draft).success).toBe(true);
		expect(
			new Set(
				[...first.draft.options, ...second.draft.options].map(
					(option) => option.uuid,
				),
			).size,
		).toBe(4);
		expect(first.draft).not.toHaveProperty("tableId");
	});
	it("names a missing table and removes only the optional filter key", () => {
		expect(beginOptionsSource(bound, tableId, [])).toMatchObject({
			kind: "refused",
		});
		const filter = eq(tableColumn(tableId, code), literal("north"));
		const source = { ...bound, filter };
		expect(withoutFilter(source)).toEqual(bound);
		expect(source.filter).toBe(filter);
	});
});
