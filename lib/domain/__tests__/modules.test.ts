// lib/domain/__tests__/modules.test.ts
//
// Schema-parse coverage for the `caseListConfig` shape. The schema
// declares three slots — `columns`, `filter?`, `searchInputs` —
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
//   5. Visibility flags (`visibleInList`, `visibleInDetail`) round-
//      trip both true and false (and absent — the schema preserves
//      slot presence; defaulting is a wire-emitter concern).
//   6. The `SearchInputDef` discriminated union round-trips both
//      arms; the simple arm requires `property`; the advanced arm
//      requires `predicate`.
//   7. `caseListConfig` carries only `columns`, `filter?`, and
//      `searchInputs`. Unknown top-level keys are rejected at
//      parse — `safeParse` returns `success: false`.

import { describe, expect, it } from "vitest";
import {
	type AdvancedSearchInputDef,
	advancedSearchInputDef,
	type CaseSearchConfig,
	type Column,
	calculatedColumn,
	caseListConfigSchema,
	caseSearchConfigSchema,
	columnSchema,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	intervalColumn,
	moduleSchema,
	phoneColumn,
	plainColumn,
	type SimpleSearchInputDef,
	searchInputDefSchema,
	simpleSearchInputDef,
} from "../modules";
import { asUuid, type Uuid } from "../uuid";

// Sample uuids — sequential nibbles so test failure diffs are easy
// to read at a glance (each column / input gets a distinct uuid).
const u = (n: number): Uuid =>
	asUuid(`00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);

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
			caseListConfig: { columns: [], searchInputs: [] },
		});
		expect(parsed.success).toBe(true);
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

describe("caseListConfigSchema — three-slot shape", () => {
	it("parses with empty columns + searchInputs", () => {
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			searchInputs: [],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects unknown top-level keys", () => {
		// `caseListConfigSchema` is `.strict()` and declares exactly
		// three slots — `columns`, `filter?`, `searchInputs`. Any other
		// top-level key fails to parse rather than stripping silently,
		// so a stale generator emitting a legacy field (e.g.
		// `detailColumns`) or a typo cannot reach the typed surface.
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			searchInputs: [],
			__unknown_a: "alpha",
			__unknown_b: { nested: 42 },
			__unknown_c: ["mixed", "shapes", 99],
			// One legacy slot named inline as a regression backstop —
			// confirms a real-world array-shaped key doesn't smuggle
			// past the strict gate.
			detailColumns: [{ kind: "plain", field: "phone", header: "Phone" }],
		});
		expect(parsed.success).toBe(false);
	});
});

describe("columnSchema — six discriminated arms", () => {
	it("parses every column kind with its required slots + a uuid", () => {
		const arms: readonly Column[] = [
			{
				uuid: u(1),
				kind: "plain",
				field: "name",
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
				kind: "interval",
				field: "last_visit",
				header: "Last visit",
				threshold: 7,
				unit: "days",
				display: "always",
				text: "Overdue",
			},
			{
				uuid: u(6),
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

	it("rejects a date column with an empty pattern", () => {
		// Schema constraint: `dateColumnSchema.pattern` is
		// `z.string().min(1)` — symmetric with `formatDateSchema.pattern`
		// on the ValueExpression side. An empty pattern would render
		// the property's raw ISO string at the wire boundary.
		const parsed = columnSchema.safeParse({
			uuid: u(1),
			kind: "date",
			field: "opened_on",
			header: "Opened",
			pattern: "",
		});
		expect(parsed.success).toBe(false);
	});

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
		const input = plainColumn(u(1), "name", "Name", {
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
		// binds at the saga / preview / wire layers. The schema does
		// not enforce uniqueness — transient editor states (undo,
		// partial save) might transiently collide and the schema must
		// not reject them.
		const config = {
			columns: [
				plainColumn(u(1), "a", "A", {
					sort: { direction: "asc", priority: 0 },
				}),
				plainColumn(u(2), "b", "B", {
					sort: { direction: "asc", priority: 0 },
				}),
			],
			searchInputs: [],
		};
		const parsed = caseListConfigSchema.safeParse(config);
		expect(parsed.success).toBe(true);
	});
});

describe("Column.visibleInList / visibleInDetail — visibility flags", () => {
	it("round-trips visibleInList: true / false", () => {
		const visibleTrue = plainColumn(u(1), "name", "Name", {
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
		const visibleTrue = plainColumn(u(1), "name", "Name", {
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
		const input = plainColumn(u(1), "name", "Name");
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
		const built = plainColumn(u(1), "name", "Name");
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
		const built = plainColumn(u(1), "name", "Name", {
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

describe("searchInputDefSchema — discriminated union", () => {
	it("round-trips a simple input with property + mode + via", () => {
		const input: SimpleSearchInputDef = {
			uuid: u(1),
			kind: "simple",
			name: "patient_name",
			label: "Patient name",
			type: "text",
			property: "name",
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

	it("preserves multi-select-contains quantifier on the simple arm", () => {
		const parsed = searchInputDefSchema.safeParse({
			uuid: u(1),
			kind: "simple",
			name: "tags",
			label: "Tags",
			type: "select",
			property: "tags",
			mode: { kind: "multi-select-contains", quantifier: "any" },
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects multi-select-contains without a quantifier", () => {
		const parsed = searchInputDefSchema.safeParse({
			uuid: u(1),
			kind: "simple",
			name: "tags",
			label: "Tags",
			type: "select",
			property: "tags",
			mode: { kind: "multi-select-contains" },
		});
		expect(parsed.success).toBe(false);
	});
});

describe("SearchInputDef builders — helper construction", () => {
	it("simpleSearchInputDef → schema round-trip", () => {
		const built = simpleSearchInputDef(
			u(1),
			"patient_name",
			"Patient name",
			"text",
			"name",
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
			"name",
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
			"name",
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
		const config = {
			columns: [
				plainColumn(u(1), "name", "Name", {
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
					"name",
					{ mode: { kind: "fuzzy" } },
				),
				advancedSearchInputDef(u(11), "complex", "Complex", "text", {
					kind: "match-all",
				}),
			],
		};
		const parsed = caseListConfigSchema.safeParse(config);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).toEqual(config);
	});
});

describe("caseSearchConfigSchema — claim flow + display labels", () => {
	it("round-trips a fully-populated config (every slot set)", () => {
		// Round-trips every authored slot: `claimCondition`,
		// `blacklistedOwnerIds`, the five display labels, and
		// `searchButtonDisplayCondition`. The `toEqual(config)`
		// assertion pins that the schema preserves all eight slots
		// without drift across a strict-mode parse.
		const config: CaseSearchConfig = {
			claimCondition: { kind: "match-all" },
			// `blacklistedOwnerIds` is a `ValueExpression`; the `term` arm
			// wraps a `Term` (here a string literal) so the value
			// satisfies the `ValueExpression` shape.
			blacklistedOwnerIds: {
				kind: "term",
				term: { kind: "literal", value: "owner-a owner-b" },
			},
			searchScreenTitle: "Search for a patient",
			searchScreenSubtitle: "Use **fuzzy** match for partial names",
			emptyListText: "No matching patients",
			searchButtonLabel: "Search",
			searchAgainButtonLabel: "Search again",
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
			claimCondition: undefined,
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.claimCondition).toBeUndefined();
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
			caseListConfig: { columns: [], searchInputs: [] },
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
