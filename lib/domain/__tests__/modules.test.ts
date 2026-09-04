import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { emptyCaseListConfig } from "@/lib/domain";
// lib/domain/__tests__/modules.test.ts
//
// Schema-parse coverage for the `caseListConfig` shape. The schema
// declares the case-list collections, optional filter, bounded selection, and
// presentation metadata
// with sort, visibility, and calculated arms carried on columns.
// Every schema in this file is `.strict()`, so unknown keys are
// rejected at parse rather than stripped silently.
//
// The contracts pinned below:
//
//   1. Empty `caseListConfig` is valid (a module that authors a
//      case list but hasn't filled in any of its sub-fields).
//   2. Every column kind round-trips through `safeParse` with a
//      `uuid` and the per-kind required slots (the calculated arm
//      has no `field` slot — the expression is the source).
//   3. The `interval` kind preserves `display: "always"` AND
//      `display: "flag"` arms.
//   4. `Column.sort` round-trips with direction + priority.
//   5. Visibility flags and independent Results / Details sequences
//      round-trip.
//   6. The `SearchInputDef` discriminated union round-trips both
//      arms; the simple arm requires `property`; the advanced arm
//      requires `predicate`.
//   7. `caseListConfig.selection` has one multiple-selection spelling and a
//      maximum from 1 through 100; absence is the single-case projection.
//   8. Unknown top-level keys are rejected at
//      parse — `safeParse` returns `success: false`.

import { describe, expect, it } from "vitest";
import {
	type AdvancedSearchInputDef,
	advancedSearchInputDef,
	type CaseSearchConfig,
	type Column,
	calculatedColumn,
	caseListConfigSchema,
	caseSearchConfigHasAuthoredSettings,
	caseSearchConfigSchema,
	caseSelectionCanFlowBetweenModules,
	caseSelectionCardinality,
	caseSelectionMaximum,
	columnSchema,
	dateColumn,
	effectiveCaseSearchConfig,
	idMappingColumn,
	idMappingEntry,
	intervalColumn,
	joinMultiSelectSearchAnswer,
	MULTI_SELECT_SEARCH_ANSWER_DELIMITER,
	moduleSchema,
	phoneColumn,
	plainColumn,
	type SimpleSearchInputDef,
	searchInputDefSchema,
	simpleSearchInputDef,
	splitMultiSelectSearchAnswer,
} from "../modules";
import { asMediaAssetId } from "../multimedia";
import { eq, literal, sessionUser, term } from "../predicate";
import type { Uuid } from "../uuid";

// Sample uuids — sequential nibbles so test failure diffs are easy
// to read at a glance (each column / input gets a distinct uuid).
const u = (n: number): Uuid =>
	testUuid(`00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);

describe("moduleSchema — caseListConfig presence", () => {
	it("parses a module without caseListConfig (survey-only module)", () => {
		const parsed = moduleSchema.safeParse({
			uuid: u(1),
			id: "survey",
			name: "Survey",
		});
		expect(parsed.success).toBe(true);
	});

	it("parses a module with empty caseListConfig", () => {
		const parsed = moduleSchema.safeParse({
			uuid: u(1),
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListConfig: emptyCaseListConfig(),
		});
		expect(parsed.success).toBe(true);
	});

	it("stores a typed display condition", () => {
		const displayCondition = eq(sessionUser("username"), literal("alice"));
		const parsed = moduleSchema.safeParse({
			uuid: u(1),
			id: "patients",
			name: "Patients",
			displayCondition,
		});
		expect(parsed.success).toBe(true);
		if (parsed.success)
			expect(parsed.data.displayCondition).toEqual(displayCondition);
	});

	it("rejects unknown top-level keys", () => {
		// `moduleSchema` is `.strict()`, so any key outside the declared
		// slot set fails to parse rather than stripping silently. A
		// stale generator emitting a legacy field (e.g. `caseListColumns`)
		// or a typo (`__unknown_*`) cannot reach the typed surface — the
		// schema rejects the whole payload up front.
		const parsed = moduleSchema.safeParse({
			uuid: u(1),
			id: "patients",
			name: "Patients",
			caseType: "patient",
			__unknown_a: "alpha",
			__unknown_b: { nested: 42 },
			__unknown_c: ["mixed", "shapes", 99],
			// One legacy slot named inline as a regression backstop —
			// confirms a real-world untypable-name doesn't smuggle past
			// the strict gate.
			caseListColumns: [{ field: "name", header: "Name" }],
		});
		expect(parsed.success).toBe(false);
	});
});

describe("caseListConfigSchema — canonical shape", () => {
	it("parses with empty columns + searchInputs", () => {
		const parsed = caseListConfigSchema.safeParse(emptyCaseListConfig());
		expect(parsed.success).toBe(true);
	});

	it("rejects unknown top-level keys", () => {
		// `caseListConfigSchema` is `.strict()`. Any unknown
		// top-level key fails to parse rather than stripping silently,
		// so a stale generator emitting an unknown field (e.g.
		// `detailColumns`) or a typo cannot reach the typed surface.
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			searchInputs: [],
			__unknown_a: "alpha",
			__unknown_b: { nested: 42 },
			__unknown_c: ["mixed", "shapes", 99],
			// One obsolete slot named inline as a regression backstop —
			// confirms a real-world array-shaped key doesn't smuggle
			// past the strict gate.
			detailColumns: [{ kind: "plain", field: "phone", header: "Phone" }],
		});
		expect(parsed.success).toBe(false);
	});

	it.each([1, 100])(
		"round-trips multiple selection with maximum %i",
		(maximum) => {
			const config = {
				...emptyCaseListConfig(),
				selection: { kind: "multiple", maximum } as const,
			};
			const parsed = caseListConfigSchema.safeParse(config);
			expect(parsed.success).toBe(true);
			if (parsed.success) expect(parsed.data).toEqual(config);
			expect(caseSelectionCardinality({ caseListConfig: config })).toBe(
				"multiple",
			);
			expect(caseSelectionMaximum({ caseListConfig: config })).toBe(maximum);
		},
	);

	it.each([0, 101, 1.5, -0])(
		"rejects a noncanonical multiple-selection maximum (%s)",
		(maximum) => {
			expect(
				caseListConfigSchema.safeParse({
					...emptyCaseListConfig(),
					selection: { kind: "multiple", maximum },
				}).success,
			).toBe(false);
		},
	);

	it("projects absent selection as one case", () => {
		expect(
			caseSelectionCardinality({ caseListConfig: emptyCaseListConfig() }),
		).toBe("single");
		expect(
			caseSelectionMaximum({ caseListConfig: emptyCaseListConfig() }),
		).toBe(1);
		expect(caseSelectionCardinality({})).toBe("single");
		expect(caseSelectionMaximum({})).toBe(1);
	});

	it("proves inherited selection from authored shapes, not the current count", () => {
		const multiple = (caseType: string, maximum: number) => ({
			caseType,
			caseListConfig: {
				...emptyCaseListConfig(),
				selection: { kind: "multiple" as const, maximum },
			},
		});

		expect(
			caseSelectionCanFlowBetweenModules(
				multiple("patient", 5),
				multiple("patient", 5),
			),
		).toBe(true);
		expect(
			caseSelectionCanFlowBetweenModules(
				multiple("patient", 5),
				multiple("patient", 4),
			),
		).toBe(false);
		expect(
			caseSelectionCanFlowBetweenModules(
				multiple("patient", 5),
				multiple("visit", 5),
			),
		).toBe(false);
		expect(
			caseSelectionCanFlowBetweenModules(
				{ caseType: "patient", caseListConfig: emptyCaseListConfig() },
				multiple("patient", 5),
			),
		).toBe(false);
	});
});

describe("columnSchema — eight discriminated arms", () => {
	it("parses every column kind with its required slots + a uuid", () => {
		const arms: readonly Column[] = [
			{
				uuid: u(1),
				kind: "plain",
				field: "case_name",
				header: "Name",
			},
			{
				uuid: u(2),
				kind: "date",
				field: "opened_on",
				header: "Opened",
				// CCHQ wire-form date pattern (strftime-style); same
				// shape as `formatDateSchema.pattern` on the
				// ValueExpression side.
				pattern: "%Y-%m-%d",
			},
			{
				uuid: u(3),
				kind: "phone",
				field: "phone",
				header: "Phone",
			},
			{
				uuid: u(4),
				kind: "id-mapping",
				field: "region_code",
				header: "Region",
				mapping: [{ value: "1", label: "North" }],
			},
			{
				uuid: u(5),
				kind: "image-map",
				field: "status",
				header: "Status",
				mapping: [{ value: "open", assetId: asMediaAssetId(u(20)) }],
			},
			{
				uuid: u(6),
				kind: "interval",
				field: "last_visit",
				header: "Last visit",
				threshold: 7,
				unit: "days",
				display: "always",
				text: "Overdue",
			},
			{
				uuid: u(7),
				kind: "calculated",
				header: "Days since last visit",
				expression: { kind: "today" },
			},
		];
		for (const arm of arms) {
			const parsed = columnSchema.safeParse(arm);
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data).toEqual(arm);
			}
		}
	});

	it("preserves both interval-display arms (always + flag)", () => {
		const alwaysArm = columnSchema.safeParse({
			uuid: u(1),
			kind: "interval",
			field: "last_visit",
			header: "Last visit",
			threshold: 7,
			unit: "days",
			display: "always",
			text: "Overdue",
		});
		expect(alwaysArm.success).toBe(true);
		if (alwaysArm.success && alwaysArm.data.kind === "interval") {
			expect(alwaysArm.data.display).toBe("always");
		}

		const flagArm = columnSchema.safeParse({
			uuid: u(2),
			kind: "interval",
			field: "next_visit",
			header: "Late",
			threshold: 30,
			unit: "days",
			display: "flag",
			text: "OVERDUE",
		});
		expect(flagArm.success).toBe(true);
		if (flagArm.success && flagArm.data.kind === "interval") {
			expect(flagArm.data.display).toBe("flag");
		}
	});

	it("rejects an unknown column kind 'time-since-until'", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "time-since-until",
			field: "last_visit",
			header: "Last visit",
			threshold: 7,
			unit: "days",
			displayLabel: "Overdue",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an unknown column kind 'late-flag'", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "late-flag",
			field: "next_visit",
			header: "Late",
			threshold: 30,
			unit: "days",
			flagDisplayValue: "OVERDUE",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an unknown column kind 'search-only'", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "search-only",
			field: "phone",
			header: "Phone",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an interval column missing display", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "interval",
			field: "last_visit",
			header: "Last visit",
			threshold: 7,
			unit: "days",
			text: "Overdue",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an interval column missing text", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "interval",
			field: "last_visit",
			header: "Last visit",
			threshold: 7,
			unit: "days",
			display: "flag",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an id-mapping column missing the mapping table", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "id-mapping",
			field: "region_code",
			header: "Region",
		});
		expect(parsed.success).toBe(false);
	});

	it.each(["", " ", "two words"])(
		"rejects a blank or whitespace-bearing mapping value: %j",
		(value) => {
			expect(
				columnSchema.safeParse({
					uuid: u(1),
					kind: "id-mapping",
					field: "region_code",
					header: "Region",
					mapping: [{ value, label: "North" }],
				}).success,
			).toBe(false);
		},
	);

	it("rejects duplicate mapping values", () => {
		expect(
			columnSchema.safeParse({
				uuid: u(1),
				kind: "id-mapping",
				field: "region_code",
				header: "Region",
				mapping: [
					{ value: "north", label: "North" },
					{ value: "north", label: "Northern" },
				],
			}).success,
		).toBe(false);
	});

	it.each(["id-mapping", "image-map"] as const)(
		"accepts an empty %s table as a complete no-mapped-output display",
		(kind) => {
			expect(
				columnSchema.safeParse({
					uuid: u(1),
					kind,
					field: "status",
					header: "Status",
					mapping: [],
				}).success,
			).toBe(true);
		},
	);

	it.each(["", " ", "two words"])(
		"rejects a blank or whitespace-bearing image-map value: %j",
		(value) => {
			expect(
				columnSchema.safeParse({
					uuid: u(1),
					kind: "image-map",
					field: "status",
					header: "Status",
					mapping: [{ value, assetId: asMediaAssetId(u(20)) }],
				}).success,
			).toBe(false);
		},
	);

	it("rejects duplicate image-map values", () => {
		expect(
			columnSchema.safeParse({
				uuid: u(1),
				kind: "image-map",
				field: "status",
				header: "Status",
				mapping: [
					{ value: "open", assetId: asMediaAssetId(u(20)) },
					{ value: "open", assetId: asMediaAssetId(u(21)) },
				],
			}).success,
		).toBe(false);
	});

	it("rejects a date column with an empty pattern", () => {
		// Schema constraint: both column and ValueExpression patterns reject
		// empty input before any runtime compiler sees it.
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "date",
			field: "opened_on",
			header: "Opened",
			pattern: "",
		});
		expect(parsed.success).toBe(false);
	});

	it.each(["%Q", "Date %"])(
		"rejects a date column pattern JavaRosa cannot evaluate: %s",
		(pattern) => {
			const parsed = columnSchema.safeParse({
				uuid: u(1),
				kind: "date",
				field: "opened_on",
				header: "Opened",
				pattern,
			});
			expect(parsed.success).toBe(false);
		},
	);

	it("rejects an unknown column kind", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "rainbow",
			field: "x",
			header: "X",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects any column missing uuid", () => {
		const parsed = columnSchema.safeParse({
			kind: "plain",
			field: "name",
			header: "Name",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an extraneous field slot on a calculated column (calc has no field)", () => {
		// The calculated arm has no `field` slot — the expression is
		// the source. The arm is `.strict()` (inherited from
		// `columnBase`), so a payload carrying `field` fails to parse
		// rather than stripping. A stale caller mixing the plain-arm
		// shape with the calculated arm is rejected up front.
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "calculated",
			header: "Days since last visit",
			expression: { kind: "today" },
			field: "should_be_rejected",
		});
		expect(parsed.success).toBe(false);
	});
});

describe("Column.sort — column-level sort directive", () => {
	it("round-trips a column with sort direction + priority", () => {
		const input = plainColumn(u(1), "case_name", "Name", {
			sort: { direction: "asc", priority: 0 },
		});
		const parsed = columnSchema.safeParse(input);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data).toEqual(input);
			expect(parsed.data.sort).toEqual({ direction: "asc", priority: 0 });
		}
	});

	it("round-trips a calculated column with sort", () => {
		const input = calculatedColumn(
			u(1),
			"Days since last visit",
			{ kind: "today" },
			{ sort: { direction: "desc", priority: 1 } },
		);
		const parsed = columnSchema.safeParse(input);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data).toEqual(input);
			expect(parsed.data.sort).toEqual({ direction: "desc", priority: 1 });
		}
	});

	it("rejects a sort with negative priority", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "plain",
			field: "name",
			header: "Name",
			sort: { direction: "asc", priority: -1 },
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a sort with non-integer priority", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "plain",
			field: "name",
			header: "Name",
			sort: { direction: "asc", priority: 1.5 },
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a sort with an unknown direction", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "plain",
			field: "name",
			header: "Name",
			sort: { direction: "sideways", priority: 0 },
		});
		expect(parsed.success).toBe(false);
	});

	it("admits two columns at the same priority — tie-break is a layer concern, not a schema one", () => {
		// The tie-break rule (display order in `caseListConfig.columns`)
		// binds at the whole-document validator / preview / wire layers.
		// The member-level structural schema does not duplicate that contextual
		// uniqueness rule.
		const config = resolveCaseListConfig({
			columns: [
				plainColumn(u(1), "a", "A", {
					sort: { direction: "asc", priority: 0 },
				}),
				plainColumn(u(2), "b", "B", {
					sort: { direction: "asc", priority: 0 },
				}),
			],
			searchInputs: [],
		});
		const parsed = caseListConfigSchema.safeParse(config);
		expect(parsed.success).toBe(true);
	});
});

describe("Column.visibleInList / visibleInDetail — visibility flags", () => {
	it("round-trips visibleInList: true / false", () => {
		const visibleTrue = plainColumn(u(1), "case_name", "Name", {
			visibleInList: true,
		});
		const visibleFalse = plainColumn(u(2), "phone", "Phone", {
			visibleInList: false,
		});
		const parsedTrue = columnSchema.safeParse(visibleTrue);
		const parsedFalse = columnSchema.safeParse(visibleFalse);
		expect(parsedTrue.success).toBe(true);
		expect(parsedFalse.success).toBe(true);
		if (parsedTrue.success) expect(parsedTrue.data.visibleInList).toBe(true);
		if (parsedFalse.success) expect(parsedFalse.data.visibleInList).toBe(false);
	});

	it("round-trips visibleInDetail: true / false", () => {
		const visibleTrue = plainColumn(u(1), "case_name", "Name", {
			visibleInDetail: true,
		});
		const visibleFalse = plainColumn(u(2), "phone", "Phone", {
			visibleInDetail: false,
		});
		const parsedTrue = columnSchema.safeParse(visibleTrue);
		const parsedFalse = columnSchema.safeParse(visibleFalse);
		expect(parsedTrue.success).toBe(true);
		expect(parsedFalse.success).toBe(true);
		if (parsedTrue.success) expect(parsedTrue.data.visibleInDetail).toBe(true);
		if (parsedFalse.success)
			expect(parsedFalse.data.visibleInDetail).toBe(false);
	});

	it("preserves slot absence — defaulting is a wire-emitter concern", () => {
		// When the user never authors a visibility flag, the schema
		// preserves the slot's absence — the wire emitter applies the
		// "absent ≡ visible" default, but the schema doesn't bake the
		// default into the persisted shape.
		const input = plainColumn(u(1), "case_name", "Name");
		const parsed = columnSchema.safeParse(input);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			const data = parsed.data as Record<string, unknown>;
			expect(data.visibleInList).toBeUndefined();
			expect(data.visibleInDetail).toBeUndefined();
		}
	});

	it("rejects a non-boolean visibility flag", () => {
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "plain",
			field: "name",
			header: "Name",
			visibleInList: "yes",
		});
		expect(parsed.success).toBe(false);
	});
});

describe("Column builders — helper construction", () => {
	it("plainColumn → schema round-trip", () => {
		const built = plainColumn(u(1), "case_name", "Name");
		const parsed = columnSchema.safeParse(built);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(built);
	});

	it("dateColumn → schema round-trip", () => {
		const built = dateColumn(u(1), "opened_on", "Opened", "%Y-%m-%d");
		const parsed = columnSchema.safeParse(built);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(built);
	});

	it("phoneColumn → schema round-trip", () => {
		const built = phoneColumn(u(1), "phone", "Phone");
		const parsed = columnSchema.safeParse(built);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(built);
	});

	it("idMappingColumn → schema round-trip", () => {
		const built = idMappingColumn(u(1), "region_code", "Region", [
			idMappingEntry("1", "North"),
			idMappingEntry("2", "South"),
		]);
		const parsed = columnSchema.safeParse(built);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(built);
	});

	it("intervalColumn → schema round-trip on both display arms", () => {
		const alwaysArm = intervalColumn(
			u(1),
			"last_visit",
			"Last visit",
			7,
			"days",
			"always",
			"Overdue",
		);
		const flagArm = intervalColumn(
			u(2),
			"next_visit",
			"Late",
			30,
			"days",
			"flag",
			"OVERDUE",
		);
		const parsedAlways = columnSchema.safeParse(alwaysArm);
		const parsedFlag = columnSchema.safeParse(flagArm);
		expect(parsedAlways.success).toBe(true);
		expect(parsedFlag.success).toBe(true);
		if (parsedAlways.success) expect(parsedAlways.data).toEqual(alwaysArm);
		if (parsedFlag.success) expect(parsedFlag.data).toEqual(flagArm);
	});

	it("calculatedColumn → schema round-trip with no field slot", () => {
		const built = calculatedColumn(u(1), "Days since visit", { kind: "today" });
		const parsed = columnSchema.safeParse(built);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data).toEqual(built);
			const data = parsed.data as Record<string, unknown>;
			expect(data.field).toBeUndefined();
		}
	});

	it("builders omit absent optional slots — round-trip equality stays clean", () => {
		// The builder convention is that absent-equivalent values OMIT
		// keys from the constructed object so saved docs that omitted
		// the slot round-trip equal to a freshly-built one. Without
		// this, the editor would persist `sort: undefined` shapes that
		// fail `expect(parsed).toEqual(input)`.
		const built = plainColumn(u(1), "case_name", "Name", {
			sort: undefined,
			visibleInList: undefined,
			visibleInDetail: undefined,
		});
		const data = built as Record<string, unknown>;
		expect(data.sort).toBeUndefined();
		expect(Object.hasOwn(data, "sort")).toBe(false);
		expect(Object.hasOwn(data, "visibleInList")).toBe(false);
		expect(Object.hasOwn(data, "visibleInDetail")).toBe(false);
	});
});

describe("searchInputDefSchema — exact four-arm union", () => {
	it("round-trips a simple input with property + mode + via", () => {
		const input: SimpleSearchInputDef = {
			uuid: u(1),
			kind: "simple",
			name: "patient_name",
			label: "Patient name",
			type: "text",
			property: "full_name",
			mode: { kind: "fuzzy" },
		};
		const parsed = searchInputDefSchema.safeParse(input);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(input);
	});

	it("round-trips an advanced input with predicate", () => {
		const input: AdvancedSearchInputDef = {
			uuid: u(1),
			kind: "advanced",
			name: "complex_filter",
			label: "Complex",
			type: "text",
			predicate: { kind: "match-all" },
		};
		const parsed = searchInputDefSchema.safeParse(input);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(input);
	});

	it("rejects a simple input missing property (property is required on simple arm)", () => {
		const parsed = searchInputDefSchema.safeParse({
			uuid: u(1),
			kind: "simple",
			name: "patient_name",
			label: "Patient name",
			type: "text",
		});
		expect(parsed.success).toBe(false);
	});

	it.each(["", " "])("rejects a blank simple property: %j", (property) => {
		expect(
			searchInputDefSchema.safeParse({
				uuid: u(1),
				kind: "simple",
				name: "patient_name",
				label: "Patient name",
				type: "text",
				property,
			}).success,
		).toBe(false);
	});

	it("rejects an advanced input missing predicate", () => {
		const parsed = searchInputDefSchema.safeParse({
			uuid: u(1),
			kind: "advanced",
			name: "complex_filter",
			label: "Complex",
			type: "text",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an advanced input shipping `xpath` instead of `predicate`", () => {
		// The advanced arm declares `predicate` as a required slot and
		// is `.strict()`, so a payload shipping `xpath` (a stale name)
		// fails on both axes — the missing required slot AND the
		// unknown `xpath` key. Either failure mode rejects the parse.
		const parsed = searchInputDefSchema.safeParse({
			uuid: u(1),
			kind: "advanced",
			name: "complex_filter",
			label: "Complex",
			type: "text",
			xpath: { kind: "match-all" },
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects any search input missing uuid", () => {
		const parsed = searchInputDefSchema.safeParse({
			kind: "simple",
			name: "patient_name",
			label: "Patient name",
			type: "text",
			property: "name",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an unknown kind", () => {
		const parsed = searchInputDefSchema.safeParse({
			uuid: u(1),
			kind: "ancient",
			name: "patient_name",
			label: "Patient name",
			type: "text",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects the removed select widget and multi-select mode", () => {
		const parsed = searchInputDefSchema.safeParse({
			uuid: u(1),
			kind: "simple",
			name: "tags",
			label: "Tags",
			type: "select",
			property: "tags",
			mode: { kind: "multi-select-contains", quantifier: "any" },
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a scalar default on either date-range arm", () => {
		const simple = searchInputDefSchema.safeParse({
			uuid: u(1),
			kind: "simple",
			name: "window",
			label: "Window",
			type: "date-range",
			property: "visit_date",
			mode: { kind: "range" },
			default: { kind: "today" },
		});
		const advanced = searchInputDefSchema.safeParse({
			uuid: u(2),
			kind: "advanced",
			name: "window",
			label: "Window",
			type: "date-range",
			predicate: { kind: "match-all" },
			default: { kind: "today" },
		});
		expect(simple.success).toBe(false);
		expect(advanced.success).toBe(false);
	});
});

describe("multi-select search answer delimiter", () => {
	// `commcare-core session/RemoteQuerySessionManager.java::ANSWER_DELIMITER`
	// and Web Apps' `query.js::selectDelimiter` both spell it `#,#`.
	it("is CommCare's three-character separator, never a space", () => {
		expect(MULTI_SELECT_SEARCH_ANSWER_DELIMITER).toBe("#,#");
	});

	it("round-trips tokens, including one holding a space", () => {
		const tokens = ["north", "south west", "east"];
		const answer = joinMultiSelectSearchAnswer(tokens);
		expect(answer).toBe("north#,#south west#,#east");
		expect(splitMultiSelectSearchAnswer(answer)).toEqual(tokens);
	});

	it("drops blank tokens when splitting and yields none for a blank answer", () => {
		expect(splitMultiSelectSearchAnswer("")).toEqual([]);
		expect(splitMultiSelectSearchAnswer("#,#north#,#")).toEqual(["north"]);
		expect(joinMultiSelectSearchAnswer([])).toBe("");
	});
});

describe("SearchInputDef builders — helper construction", () => {
	it("simpleSearchInputDef → schema round-trip", () => {
		const built = simpleSearchInputDef(
			u(1),
			"patient_name",
			"Patient name",
			"text",
			"full_name",
			{ mode: { kind: "fuzzy" } },
		);
		const parsed = searchInputDefSchema.safeParse(built);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(built);
	});

	it("advancedSearchInputDef → schema round-trip", () => {
		const built = advancedSearchInputDef(
			u(1),
			"complex_filter",
			"Complex",
			"text",
			{ kind: "match-all" },
		);
		const parsed = searchInputDefSchema.safeParse(built);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(built);
	});

	it("simpleSearchInputDef omits self-path via — round-trip equality stays clean", () => {
		// `selfPath()` is the schema's canonical "no walk" shape and
		// `via: undefined` is structurally equivalent. The builder
		// treats both as omit so a saved doc that omitted the slot
		// round-trips equal to a freshly-built one.
		const built = simpleSearchInputDef(
			u(1),
			"patient_name",
			"Patient name",
			"text",
			"full_name",
			{ via: { kind: "self" } },
		);
		const data = built as Record<string, unknown>;
		expect(Object.hasOwn(data, "via")).toBe(false);
	});

	it("simpleSearchInputDef preserves a non-self via", () => {
		const built = simpleSearchInputDef(
			u(1),
			"village",
			"Village",
			"text",
			"full_name",
			{
				via: {
					kind: "ancestor",
					via: [{ identifier: "parent", throughCaseType: "village" }],
				},
			},
		);
		expect((built as { via?: unknown }).via).toEqual({
			kind: "ancestor",
			via: [{ identifier: "parent", throughCaseType: "village" }],
		});
	});
});

describe("caseListConfigSchema — populated round-trip", () => {
	it("round-trips a full config with mixed column kinds + sort + visibility + searchInputs", () => {
		const config = resolveCaseListConfig({
			columns: [
				plainColumn(u(1), "case_name", "Name", {
					sort: { direction: "asc", priority: 0 },
					visibleInList: true,
					visibleInDetail: true,
				}),
				dateColumn(u(2), "opened_on", "Opened", "%Y-%m-%d", {
					visibleInList: true,
					visibleInDetail: false,
				}),
				calculatedColumn(
					u(3),
					"Days since last visit",
					{ kind: "today" },
					{ sort: { direction: "desc", priority: 1 } },
				),
				intervalColumn(
					u(4),
					"next_visit",
					"Status",
					30,
					"days",
					"flag",
					"OVERDUE",
				),
			],
			filter: { kind: "match-all" } as const,
			searchInputs: [
				simpleSearchInputDef(
					u(10),
					"patient_name",
					"Patient name",
					"text",
					"full_name",
					{ mode: { kind: "fuzzy" } },
				),
				advancedSearchInputDef(u(11), "complex", "Complex", "text", {
					kind: "match-all",
				}),
			],
		});
		const parsed = caseListConfigSchema.safeParse(config);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(config);
	});

	it.each([
		{ listColumnOrder: [u(1), u(1)], detailColumnOrder: [u(1), u(2)] },
		{ listColumnOrder: [u(1)], detailColumnOrder: [u(1), u(2)] },
		{ listColumnOrder: [u(1), u(3)], detailColumnOrder: [u(1), u(2)] },
	])("rejects a non-permutation column order", (orders) => {
		expect(
			caseListConfigSchema.safeParse({
				columns: [
					plainColumn(u(1), "name", "Name"),
					plainColumn(u(2), "status", "Status"),
				],
				searchInputs: [],
				...orders,
			}).success,
		).toBe(false);
	});
});

describe("caseSearchConfigSchema — display labels + advanced cluster", () => {
	it("round-trips a fully-populated config (every slot set)", () => {
		// Round-trips every authored slot: `excludedOwnerIds`, the
		// three display labels, and `searchButtonDisplayCondition`. The
		// `toEqual(config)` assertion pins that the schema preserves
		// every slot without drift across a strict-mode parse.
		const config: CaseSearchConfig = {
			// `excludedOwnerIds` is a `ValueExpression`; the `term` arm
			// wraps a `Term` (here a string literal — owner ids joined
			// by spaces) so the value satisfies the `ValueExpression`
			// shape.
			excludedOwnerIds: {
				kind: "term",
				term: { kind: "literal", value: "owner-a owner-b" },
			},
			searchScreenTitle: "Search for a patient",
			searchScreenSubtitle: "Use **fuzzy** match for partial names",
			searchButtonLabel: "Search",
			searchButtonDisplayCondition: { kind: "match-all" },
		};
		const parsed = caseSearchConfigSchema.safeParse(config);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(config);
	});

	it("round-trips an empty config (every slot absent)", () => {
		// All slots are optional — an empty object is the shape the UI
		// persists when an author first creates the caseSearchConfig
		// and hasn't filled in any slot. Distinct from the module-level
		// `caseSearchConfig: undefined` shape (the module has no search
		// authoring at all); the empty object signals "search is on,
		// using runtime defaults for every slot."
		const config: CaseSearchConfig = {};
		const parsed = caseSearchConfigSchema.safeParse(config);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(config);
	});

	it("round-trips the exact owner-only provenance arm", () => {
		const config: CaseSearchConfig = {
			searchActionEnabled: false,
			excludedOwnerIds: term(literal("owner-a")),
		};
		expect(caseSearchConfigSchema.parse(config)).toEqual(config);
		expect(() =>
			caseSearchConfigSchema.parse({ searchActionEnabled: true }),
		).toThrow();
		expect(() =>
			caseSearchConfigSchema.parse({
				...config,
				searchButtonLabel: "Find",
			}),
		).toThrow();
	});

	it("rejects unknown top-level keys (.strict())", () => {
		// `.strict()` rejects unknown keys at parse rather than
		// stripping them silently. The contract holds for any unknown
		// name, so the test inputs varied generic shapes (string,
		// nested object, mixed array) to confirm the rejection isn't
		// gated on a particular value type.
		const parsed = caseSearchConfigSchema.safeParse({
			__unknown_a: "alpha",
			__unknown_b: { nested: 42 },
			__unknown_c: ["mixed", "shapes", 99],
		});
		expect(parsed.success).toBe(false);
	});

	it("admits explicit `undefined` for an optional slot", () => {
		// An optional Zod slot accepts `undefined` as a valid value for
		// the slot regardless of strict mode (strict rejects unknown
		// keys; an explicitly-passed `undefined` against a declared
		// optional slot is not unknown). This test pins that the schema
		// accepts the input shape that an editor reset to "absent" might
		// produce.
		const parsed = caseSearchConfigSchema.safeParse({
			excludedOwnerIds: undefined,
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.excludedOwnerIds).toBeUndefined();
		}
	});
});

describe("moduleSchema — caseSearchConfig presence", () => {
	it("parses a module without caseSearchConfig", () => {
		// Module without the slot — every existing module documents this
		// absent state, and the schema must accept it cleanly so the slot
		// stays purely additive.
		const parsed = moduleSchema.safeParse({
			uuid: u(1),
			id: "patients",
			name: "Patients",
			caseType: "patient",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			const data = parsed.data as Record<string, unknown>;
			expect(data.caseSearchConfig).toBeUndefined();
			expect(Object.hasOwn(data, "caseSearchConfig")).toBe(false);
		}
	});

	it("parses a module with caseSearchConfig + caseListConfig together", () => {
		const parsed = moduleSchema.safeParse({
			uuid: u(1),
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListConfig: emptyCaseListConfig(),
			caseSearchConfig: {
				searchScreenTitle: "Search for a patient",
			},
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.caseSearchConfig).toEqual({
				searchScreenTitle: "Search for a patient",
			});
		}
	});
});

describe("effectiveCaseSearchConfig", () => {
	it("keeps an ordinary always-on case-list filter from inventing search", () => {
		expect(
			effectiveCaseSearchConfig({
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [],
					filter: { kind: "match-all" },
				}),
			}),
		).toBeUndefined();
	});

	it("gives search inputs the friendly default search config", () => {
		expect(
			effectiveCaseSearchConfig({
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [
						simpleSearchInputDef(u(40), "name", "Name", "text", "case_name"),
					],
				}),
			}),
		).toEqual({});
	});

	it("preserves explicitly authored filter-only search settings", () => {
		const config = { searchScreenTitle: "Find a patient" };
		expect(
			effectiveCaseSearchConfig({
				caseListConfig: emptyCaseListConfig(),
				caseSearchConfig: config,
			}),
		).toBe(config);
	});

	it("does not invent Search for an owner-only config born without an action", () => {
		expect(
			effectiveCaseSearchConfig({
				caseListConfig: emptyCaseListConfig(),
				caseSearchConfig: {
					searchActionEnabled: false,
					excludedOwnerIds: term(literal("owner-a")),
				},
			}),
		).toBeUndefined();
	});

	it("preserves an authored Never condition instead of inferring owner-only provenance", () => {
		const authored = {
			excludedOwnerIds: term(literal("owner-a")),
			searchButtonDisplayCondition: { kind: "match-none" as const },
		};
		expect(
			effectiveCaseSearchConfig({
				caseListConfig: emptyCaseListConfig(),
				caseSearchConfig: authored,
			}),
		).toBe(authored);
	});

	it("rejects owner-only provenance paired with Search inputs", () => {
		expect(() =>
			effectiveCaseSearchConfig({
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [
						simpleSearchInputDef(u(41), "name", "Name", "text", "case_name"),
					],
				}),
				caseSearchConfig: {
					searchActionEnabled: false,
					excludedOwnerIds: term(literal("owner-a")),
				},
			}),
		).toThrow("Owner-only");
	});

	it("preserves an authored Never condition when inputs make Search explicit", () => {
		expect(
			effectiveCaseSearchConfig({
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [
						simpleSearchInputDef(u(42), "name", "Name", "text", "case_name"),
					],
				}),
				caseSearchConfig: {
					excludedOwnerIds: term(literal("owner-a")),
					searchButtonDisplayCondition: { kind: "match-none" },
				},
			}),
		).toEqual({
			excludedOwnerIds: term(literal("owner-a")),
			searchButtonDisplayCondition: { kind: "match-none" },
		});
	});
});

describe("caseSearchConfigHasAuthoredSettings", () => {
	it("treats own keys with undefined values as empty", () => {
		expect(
			caseSearchConfigHasAuthoredSettings({
				searchScreenTitle: undefined,
				excludedOwnerIds: undefined,
			}),
		).toBe(false);
	});

	it("treats the exact owner-only arm as meaningful state", () => {
		expect(
			caseSearchConfigHasAuthoredSettings({
				searchActionEnabled: false,
				excludedOwnerIds: term(literal("owner-a")),
			}),
		).toBe(true);
	});

	it("recognizes display and advanced overrides", () => {
		expect(
			caseSearchConfigHasAuthoredSettings({ searchButtonLabel: "Find" }),
		).toBe(true);
		expect(
			caseSearchConfigHasAuthoredSettings({
				excludedOwnerIds: term(literal("x")),
			}),
		).toBe(true);
	});
});

describe("columnSchema — link", () => {
	const base = {
		uuid: "00000000-0000-4000-8000-000000000001",
		kind: "link" as const,
		field: "photo_url",
		header: "Photo",
	};

	it("accepts a complete link column", () => {
		expect(
			columnSchema.safeParse({ ...base, linkText: "Open photo" }).success,
		).toBe(true);
	});

	it("refuses a square bracket in the link text", () => {
		// The cell is emitted as `[<linkText>](<value>)`. A bracket inside
		// the label closes it early and the row shows raw markdown instead
		// of a link, so the state is refused rather than emitted.
		for (const linkText of ["See [photo]", "a] b", "[x"]) {
			expect(columnSchema.safeParse({ ...base, linkText }).success).toBe(false);
		}
	});

	it("refuses an empty link text", () => {
		// `[](url)` renders as a link with nothing to click.
		expect(columnSchema.safeParse({ ...base, linkText: "" }).success).toBe(
			false,
		);
	});

	it("refuses a link column with no link text at all", () => {
		expect(columnSchema.safeParse(base).success).toBe(false);
	});
});
