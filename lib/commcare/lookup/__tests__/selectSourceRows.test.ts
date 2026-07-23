import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, LookupOptionsSource } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type {
	LookupCellValue,
	LookupDataType,
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupRevision,
	LookupRowId,
	LookupRowValues,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { lookupSelectSourceRowFindings } from "../selectSourceRows";

const TABLE = "018f0000-0000-7000-8000-0000000000a1" as LookupTableId;
const OTHER_TABLE = "018f0000-0000-7000-8000-0000000000a2" as LookupTableId;
const VALUE_COL = "018f0000-0000-7000-8000-0000000000b1" as LookupColumnId;
const LABEL_COL = "018f0000-0000-7000-8000-0000000000b2" as LookupColumnId;
const ABSENT_COL = "018f0000-0000-7000-8000-0000000000bf" as LookupColumnId;

const SOURCE: LookupOptionsSource = {
	kind: "lookup-table",
	tableId: TABLE,
	valueColumnId: VALUE_COL,
	labelColumnId: LABEL_COL,
};

function carrierDoc(source: LookupOptionsSource = SOURCE): BlueprintDoc {
	return buildDoc({
		appName: "Lookup survey",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								id: "status",
								label: "Status",
								optionsSource: source,
							}),
						],
					},
				],
			},
		],
	});
}

function table(opts?: {
	valueType?: LookupDataType;
	labelType?: LookupDataType;
}): LookupTableDefinition {
	return {
		id: TABLE,
		name: "Statuses",
		tag: "statuses",
		definitionRevision: "1" as LookupRevision,
		columns: [
			{
				id: VALUE_COL,
				wireName: "value",
				label: "Value",
				dataType: opts?.valueType ?? "text",
			},
			{
				id: LABEL_COL,
				wireName: "label",
				label: "Label",
				dataType: opts?.labelType ?? "text",
			},
		],
	};
}

function vals(entries: Record<string, LookupCellValue>): LookupRowValues {
	return entries as LookupRowValues;
}

let rowSeq = 0;
function row(values: LookupRowValues): LookupFixtureRow {
	rowSeq += 1;
	return { id: `018f0000-0000-7000-8000-row${rowSeq}` as LookupRowId, values };
}

function snapshot(
	definition: LookupTableDefinition,
	rows: readonly LookupFixtureRow[],
	rowsTableId: LookupTableId = definition.id,
): LookupFixtureDataSnapshot {
	return {
		projectId: "project-1",
		projectRevision: "1" as LookupRevision,
		definitions: [definition],
		rowsByTable: new Map([[rowsTableId, rows]]),
	};
}

function findings(
	definition: LookupTableDefinition,
	rows: readonly LookupFixtureRow[],
) {
	return lookupSelectSourceRowFindings(
		carrierDoc(),
		snapshot(definition, rows),
	);
}

describe("lookupSelectSourceRowFindings — blank values", () => {
	it("flags a missing key and a stored empty text as blank values", () => {
		const errors = findings(table(), [
			row(vals({ [LABEL_COL]: "L1" })), // value key absent
			row(vals({ [VALUE_COL]: "", [LABEL_COL]: "L2" })), // stored empty text
			row(vals({ [VALUE_COL]: "ok", [LABEL_COL]: "L3" })),
		]);
		expect(errors.map((e) => e.code)).toEqual([
			"LOOKUP_SELECT_SOURCE_VALUE_BLANK",
		]);
		expect(errors[0].details).toMatchObject({
			offendingRowCount: "2",
			offendingRowPositions: "1,2",
		});
	});
});

describe("lookupSelectSourceRowFindings — whitespace values", () => {
	it("flags space, tab, and newline values while keeping a blank value out of the whitespace set", () => {
		const errors = findings(table(), [
			row(vals({ [VALUE_COL]: "a b", [LABEL_COL]: "L1" })),
			row(vals({ [VALUE_COL]: "a\tb", [LABEL_COL]: "L2" })),
			row(vals({ [VALUE_COL]: "a\nb", [LABEL_COL]: "L3" })),
			row(vals({ [VALUE_COL]: "", [LABEL_COL]: "L4" })), // blank, not whitespace
		]);
		const byCode = new Map(errors.map((e) => [e.code, e]));
		expect(
			byCode.get("LOOKUP_SELECT_SOURCE_VALUE_WHITESPACE")?.details,
		).toMatchObject({ offendingRowCount: "3", offendingRowPositions: "1,2,3" });
		expect(
			byCode.get("LOOKUP_SELECT_SOURCE_VALUE_BLANK")?.details,
		).toMatchObject({ offendingRowCount: "1", offendingRowPositions: "4" });
	});
});

describe("lookupSelectSourceRowFindings — duplicate values", () => {
	it("flags duplicate int values after lexicalization", () => {
		const errors = findings(table({ valueType: "int" }), [
			row(vals({ [VALUE_COL]: 7, [LABEL_COL]: "L1" })),
			row(vals({ [VALUE_COL]: 7, [LABEL_COL]: "L2" })),
			row(vals({ [VALUE_COL]: 8, [LABEL_COL]: "L3" })),
		]);
		expect(errors.map((e) => e.code)).toEqual([
			"LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE",
		]);
		expect(errors[0].details).toMatchObject({
			firstDuplicateValue: "7",
			duplicateValueCount: "1",
			offendingRowCount: "2",
			offendingRowPositions: "1,2",
		});
	});

	it("treats distinct code points as distinct values (uppercase A is not lowercase a)", () => {
		const errors = findings(table(), [
			row(vals({ [VALUE_COL]: "A", [LABEL_COL]: "L1" })),
			row(vals({ [VALUE_COL]: "a", [LABEL_COL]: "L2" })),
		]);
		expect(errors).toEqual([]);
	});

	it("does not fold a trailing-space value into its trimmed twin", () => {
		const errors = findings(table(), [
			row(vals({ [VALUE_COL]: "x ", [LABEL_COL]: "L1" })), // whitespace, not a value
			row(vals({ [VALUE_COL]: "x", [LABEL_COL]: "L2" })),
		]);
		const codes = errors.map((e) => e.code);
		expect(codes).toContain("LOOKUP_SELECT_SOURCE_VALUE_WHITESPACE");
		expect(codes).not.toContain("LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE");
	});

	it("keeps duplicate labels valid when their values are distinct", () => {
		const errors = findings(table(), [
			row(vals({ [VALUE_COL]: "v1", [LABEL_COL]: "Same" })),
			row(vals({ [VALUE_COL]: "v2", [LABEL_COL]: "Same" })),
		]);
		expect(errors).toEqual([]);
	});
});

describe("lookupSelectSourceRowFindings — blank labels", () => {
	it("flags a missing label and a whitespace-only label, but not a padded nonblank label", () => {
		const errors = findings(table(), [
			row(vals({ [VALUE_COL]: "v1" })), // label key absent
			row(vals({ [VALUE_COL]: "v2", [LABEL_COL]: "  " })), // whitespace-only
			row(vals({ [VALUE_COL]: "v3", [LABEL_COL]: "  ok  " })), // valid
		]);
		expect(errors.map((e) => e.code)).toEqual([
			"LOOKUP_SELECT_SOURCE_LABEL_BLANK",
		]);
		expect(errors[0].details).toMatchObject({
			offendingRowCount: "2",
			offendingRowPositions: "1,2",
		});
	});
});

describe("lookupSelectSourceRowFindings — absent from snapshot", () => {
	it("yields no findings when the table is absent from the definitions", () => {
		const otherDefinition: LookupTableDefinition = {
			...table(),
			id: OTHER_TABLE,
		};
		const errors = lookupSelectSourceRowFindings(
			carrierDoc(),
			snapshot(otherDefinition, [
				row(vals({ [LABEL_COL]: "L1" })), // would be blank if it were checked
			]),
		);
		expect(errors).toEqual([]);
	});

	it("yields no findings when the table has no rows entry in the snapshot", () => {
		const errors = lookupSelectSourceRowFindings(
			carrierDoc(),
			snapshot(table(), [], OTHER_TABLE), // rows keyed under a different id
		);
		expect(errors).toEqual([]);
	});

	it("yields no findings when the referenced value column is absent from the table", () => {
		const errors = lookupSelectSourceRowFindings(
			carrierDoc({ ...SOURCE, valueColumnId: ABSENT_COL }),
			snapshot(table(), [row(vals({ [LABEL_COL]: "L1" }))]),
		);
		expect(errors).toEqual([]);
	});
});

describe("lookupSelectSourceRowFindings — reported-position cap", () => {
	it("caps reported positions at five while offendingRowCount reports the true total", () => {
		const rows = Array.from({ length: 7 }, () =>
			row(vals({ [LABEL_COL]: "L" })),
		); // seven blank values, valid labels
		const errors = findings(table(), rows);
		expect(errors.map((e) => e.code)).toEqual([
			"LOOKUP_SELECT_SOURCE_VALUE_BLANK",
		]);
		expect(errors[0].details?.offendingRowCount).toBe("7");
		expect(errors[0].details?.offendingRowPositions).toBe("1,2,3,4,5");
		expect(errors[0].details?.offendingRowIds.split(",")).toHaveLength(5);
	});
});
