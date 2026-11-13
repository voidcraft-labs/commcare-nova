import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import { HASHTAG_SEGMENT_SOURCE } from "@/lib/domain/hashtagSegments";
import {
	type LookupColumnId,
	type LookupRowId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { LOOKUP_MAX_CELL_BYTES, LOOKUP_REVISION_MAX } from "../constants";
import {
	compareLookupRevisions,
	createLookupRowInputSchema,
	createLookupTableInputSchema,
	lookupColumnLabelSchema,
	lookupOrderKeySchema,
	lookupRevisionSchema,
	lookupRowValuesSchema,
	lookupStorageMeasurementSchema,
	lookupTableNameSchema,
	lookupTagSchema,
	lookupWireNameSchema,
	maxLookupRevision,
	parseLookupRevision,
} from "../schema";
import type {
	LookupColumnMutationInput,
	LookupRowMutationInput,
} from "../types";

const TABLE_ID = "01890f45-0000-7000-8000-000000000001";
const COLUMN_ID = "01890f45-0000-7000-8000-000000000002";

describe("lookup revisions", () => {
	it("parses only canonical nonnegative signed-int64 strings", () => {
		expect(parseLookupRevision("0")).toBe("0");
		expect(parseLookupRevision(LOOKUP_REVISION_MAX.toString())).toBe(
			"9223372036854775807",
		);
		for (const malformed of [
			"",
			"-1",
			"+1",
			"01",
			"1.0",
			" 1",
			"1 ",
			"nope",
			"9".repeat(10_000),
			1,
			BigInt("1"),
			"9223372036854775808",
		]) {
			expect(lookupRevisionSchema.safeParse(malformed).success).toBe(false);
		}
	});

	it("compares numerically rather than lexically", () => {
		const two = parseLookupRevision("2");
		const ten = parseLookupRevision("10");
		expect(compareLookupRevisions(two, ten)).toBe(-1);
		expect(compareLookupRevisions(ten, two)).toBe(1);
		expect(maxLookupRevision(two, ten)).toBe(ten);
		const precise = parseLookupRevision("9007199254740992");
		const next = parseLookupRevision("9007199254740993");
		expect(compareLookupRevisions(precise, next)).toBe(-1);
		expect(compareLookupRevisions(next, precise)).toBe(1);
		expect(compareLookupRevisions(next, next)).toBe(0);
		expect(maxLookupRevision(next, precise)).toBe(next);
	});
});

describe("lookup identity schemas", () => {
	it("keeps resource identities distinct across public input slots", () => {
		expectTypeOf<
			LookupColumnMutationInput["tableId"]
		>().toEqualTypeOf<LookupTableId>();
		expectTypeOf<
			LookupColumnMutationInput["columnId"]
		>().toEqualTypeOf<LookupColumnId>();
		expectTypeOf<
			LookupRowMutationInput["rowId"]
		>().toEqualTypeOf<LookupRowId>();
		expectTypeOf<
			LookupColumnMutationInput["tableId"]
		>().not.toEqualTypeOf<LookupColumnId>();
		expectTypeOf<
			LookupColumnMutationInput["columnId"]
		>().not.toEqualTypeOf<LookupRowId>();
		expectTypeOf<
			LookupRowMutationInput["rowId"]
		>().not.toEqualTypeOf<LookupTableId>();
	});

	it("uses the domain-owned identity parsers", () => {
		expect(lookupTableIdSchema.parse(TABLE_ID)).toBe(TABLE_ID);
		expect(lookupColumnIdSchema.parse(COLUMN_ID)).toBe(COLUMN_ID);
		expect(lookupTableIdSchema.safeParse(TABLE_ID.toUpperCase()).success).toBe(
			false,
		);
		expect(
			lookupColumnIdSchema.safeParse(COLUMN_ID.toUpperCase()).success,
		).toBe(false);
		expect(
			lookupRowIdSchema.safeParse("01890f45-0000-4000-8000-000000000001")
				.success,
		).toBe(false);
	});

	it("pins table tags and column wire names to the Nova wire grammar", () => {
		for (const value of ["patients", "Patient_2026", "_private"]) {
			expect(lookupTagSchema.parse(value)).toBe(value);
			expect(lookupWireNameSchema.parse(value)).toBe(value);
		}
		// The same lists the migration's own test inserts, so the schema and
		// the database checks agree on every one.
		for (const value of ["health-facility-v2", "XMLcodes", "a-b_c"]) {
			expect(lookupTagSchema.parse(value)).toBe(value);
		}
		for (const value of ["geo-lat", "XMLcode", "xMl_column"]) {
			expect(lookupWireNameSchema.parse(value)).toBe(value);
		}
		for (const value of [
			"health-facility.v2",
			"geo.lat",
			"xmlcodes",
			"xml",
			"1a",
			"-a",
			"a b",
			"ñ",
			"",
		]) {
			expect(lookupTagSchema.safeParse(value).success).toBe(false);
			expect(lookupWireNameSchema.safeParse(value).success).toBe(false);
		}
		expect(lookupTagSchema.safeParse("a".repeat(33)).success).toBe(false);
		expect(lookupWireNameSchema.safeParse("a".repeat(256)).success).toBe(false);
	});

	it("says what a name may hold, and that only a lowercase xml start is CommCare HQ's", () => {
		expect(
			lookupTagSchema.safeParse("geo.lat").error?.issues.map((i) => i.message),
		).toEqual([
			"Table tag starts with a letter or an underscore, then holds only unaccented letters, digits, underscores and hyphens.",
		]);
		expect(
			lookupWireNameSchema
				.safeParse("xmlcode")
				.error?.issues.map((i) => i.message),
		).toEqual([
			'Column wire name can\'t start with lowercase "xml", which CommCare HQ keeps for itself. A capital first letter works.',
		]);
	});

	it("admits only wire names that are one hashtag segment, so #row/<wireName> is always one reference", () => {
		const segment = new RegExp(`^${HASHTAG_SEGMENT_SOURCE}$`);
		const nameCharacter = fc.constantFrom(..."abcXYZ019_-.é ".split(""));
		fc.assert(
			fc.property(
				fc.array(nameCharacter, { minLength: 1, maxLength: 12 }),
				(characters) => {
					const name = characters.join("");
					if (lookupWireNameSchema.safeParse(name).success) {
						expect(segment.test(name)).toBe(true);
					}
				},
			),
			{ seed: 20261113, numRuns: 500 },
		);
	});

	it("accepts only nonempty canonical base-62 order keys", () => {
		for (const key of ["V", "0V", "aZ9"]) {
			expect(lookupOrderKeySchema.parse(key)).toBe(key);
		}
		for (const key of ["", "0", "A0", "A-", "é"]) {
			expect(lookupOrderKeySchema.safeParse(key).success).toBe(false);
		}
	});
});

describe("lookup input schemas", () => {
	it("trims display strings, requires an initial schema, and rejects duplicate wire names", () => {
		const parsed = createLookupTableInputSchema.parse({
			name: "  Household roster  ",
			tag: "households",
			columns: [{ wireName: "name", label: "  Name  ", dataType: "text" }],
		});
		expect(parsed.name).toBe("Household roster");
		expect(parsed.columns[0].label).toBe("Name");
		expect(
			createLookupTableInputSchema.safeParse({
				name: "Roster",
				tag: "roster",
				columns: [],
			}).success,
		).toBe(false);
		expect(
			createLookupTableInputSchema.safeParse({
				name: "Roster",
				tag: "roster",
				columns: [
					{ wireName: "name", label: "Name", dataType: "text" },
					{ wireName: "name", label: "Other", dataType: "int" },
				],
			}).success,
		).toBe(false);
	});

	it("accepts canonical UUID-keyed primitive rows and rejects every other JSON shape", () => {
		expect(lookupRowValuesSchema.parse({ [COLUMN_ID]: "" })).toEqual({
			[COLUMN_ID]: "",
		});
		expect(
			lookupRowValuesSchema.safeParse({ [COLUMN_ID.toUpperCase()]: "" })
				.success,
		).toBe(false);
		for (const value of [null, true, false, [], {}, Number.NaN, Infinity]) {
			expect(
				lookupRowValuesSchema.safeParse({ [COLUMN_ID]: value }).success,
			).toBe(false);
		}
		expect(
			lookupRowValuesSchema.safeParse({ not_a_uuid: "value" }).success,
		).toBe(false);
	});

	it("rejects NUL, unpaired surrogates, and cells over 64 KiB", () => {
		for (const value of [
			"before\0after",
			"\ud800",
			"before\ud800",
			"é".repeat(LOOKUP_MAX_CELL_BYTES / 2 + 1),
		]) {
			expect(
				lookupRowValuesSchema.safeParse({ [COLUMN_ID]: value }).success,
			).toBe(false);
		}
		expect(
			lookupRowValuesSchema.safeParse({
				[COLUMN_ID]: "é".repeat(LOOKUP_MAX_CELL_BYTES / 2),
			}).success,
		).toBe(true);
	});

	it("rejects database-unsafe display names and labels", () => {
		for (const value of ["before\0after", "\ud800", "after\udfff"]) {
			expect(lookupTableNameSchema.safeParse(value).success).toBe(false);
			expect(lookupColumnLabelSchema.safeParse(value).success).toBe(false);
		}
		expect(lookupTableNameSchema.safeParse("😀".repeat(120)).success).toBe(
			true,
		);
		expect(lookupTableNameSchema.safeParse("😀".repeat(121)).success).toBe(
			false,
		);
	});

	it("runtime-parses row action indices and revision strings", () => {
		expect(
			createLookupRowInputSchema.parse({
				tableId: TABLE_ID,
				expectedTableRevision: "17",
				toIndex: 0,
				values: { [COLUMN_ID]: "Ada" },
			}),
		).toMatchObject({ expectedTableRevision: "17", toIndex: 0 });
		expect(
			createLookupRowInputSchema.safeParse({
				tableId: TABLE_ID,
				expectedTableRevision: 17,
				toIndex: 0,
				values: {},
			}).success,
		).toBe(false);
	});

	it.each([-1, 0.5, 5001])(
		"rejects invalid row position %s with an otherwise valid revision",
		(toIndex) => {
			expect(
				createLookupRowInputSchema.safeParse({
					tableId: TABLE_ID,
					expectedTableRevision: "17",
					toIndex,
					values: {},
				}).success,
			).toBe(false);
		},
	);

	it("accepts only exact Postgres-derived byte measurements", () => {
		expect(
			lookupStorageMeasurementSchema.parse({
				rowValueBytes: [2, 3],
				dataBytes: 5,
			}),
		).toEqual({ rowValueBytes: [2, 3], dataBytes: 5 });
		expect(
			lookupStorageMeasurementSchema.safeParse({
				rowValueBytes: [2, 3],
				dataBytes: 6,
			}).success,
		).toBe(false);
	});
});
