import { describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupMemberIdSchema,
	lookupRowIdSchema,
} from "@/lib/domain/lookupIds";
import { changedLookupText, displayedParts } from "../largeRowModel";

describe("one value in a large lookup row", () => {
	it("fences a local Unicode edit in the stored UTF-8 coordinate system", () => {
		expect(changedLookupText("N🌱aéx", "N🌱bêx", 32)).toEqual({
			startByte: 37,
			endByte: 40,
			replacement: "bê",
		});
		expect(changedLookupText("a🌱", "a🌱🐝", 0)).toEqual({
			startByte: 5,
			endByte: 5,
			replacement: "🐝",
		});
		expect(changedLookupText("x🌱y", "xy", 9)).toEqual({
			startByte: 10,
			endByte: 14,
			replacement: "",
		});
	});
	it("keeps missing, empty, duplicate and numeric values distinct in their actual slots", () => {
		const col = lookupColumnIdSchema.parse(
			"01890f45-0000-7000-8000-000000000001",
		);
		const attr = lookupMemberIdSchema.parse(
			"01890f45-0000-7000-8000-000000000002",
		);
		const id = lookupRowIdSchema.parse("01890f45-0000-7000-8000-000000000003");
		const scalar = lookupColumnIdSchema.parse(
			"01890f45-0000-7000-8000-000000000004",
		);
		expect(displayedParts({ id, cells: [] })).toEqual([]);
		expect(
			displayedParts({ id, cells: [], occurrences: { [col]: [] } }),
		).toEqual([{ kind: "count", count: 0 }]);
		expect(
			displayedParts({
				id,
				cells: [{ columnId: scalar, value: 0 }],
				attributes: { [attr]: "007" },
				occurrences: {
					[col]: [
						{ text: "", properties: { [attr]: "" } },
						{ text: "", properties: {} },
					],
				},
			}),
		).toEqual([
			{
				kind: "value",
				slot: { kind: "cell", columnId: scalar },
				value: 0,
				byteOffset: 0,
			},
			{
				kind: "value",
				slot: { kind: "attribute", attributeId: attr },
				value: "007",
				byteOffset: 0,
			},
			{ kind: "count", count: 2 },
			{
				kind: "value",
				slot: { kind: "occurrence", columnId: col, index: 0 },
				value: "",
				byteOffset: 0,
			},
			{
				kind: "value",
				slot: { kind: "property", columnId: col, index: 0, propertyId: attr },
				value: "",
				byteOffset: 0,
			},
			{
				kind: "value",
				slot: { kind: "occurrence", columnId: col, index: 1 },
				value: "",
				byteOffset: 0,
			},
		]);
	});
});
