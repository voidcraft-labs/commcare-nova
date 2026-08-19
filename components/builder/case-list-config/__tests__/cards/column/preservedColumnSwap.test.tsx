// components/builder/case-list-config/__tests__/cards/column/preservedColumnSwap.test.tsx
//
// Unit tests for `preservedColumnSwap`: the pure column
// kind-replace transformation in `ColumnEditor`. Given a current
// Column, a target kind, and the editor context, it returns the
// rebuilt Column under the target kind, or `undefined` when the
// target cannot be built from declared compatible information. The
// transformation enforces three preservation tiers:
//
//   - **Universal header + uuid + common slots**: every kind
//     transition threads `header`, `uuid`, and the optional common
//     slots (`sort`, visibility, and tile presentation) through
//     verbatim. They're identity / surface-visibility shape, not
//     kind-specific.
//   - **Field preservation**: the non-calc kinds all carry
//     `field: string`, so a swap among them preserves `field`
//     verbatim. Calc has no field: swapping TO calc drops it;
//     swapping FROM calc seeds the new field from the target
//     schema's default factory (the case type's first applicable
//     property).
//   - **Kind-specific extras**: date pattern, mapping table,
//     interval threshold/unit/display/text, and calc expression
//     carry over across structural-twin (same-kind) transitions and
//     reset to the target schema's `defaultValue(ctx)` otherwise.
//
// Why test the function directly instead of driving the rendered
// "Change" menu: the contract is the emitted Column shape, not the
// menu chrome. Asserting on the pure transformation pins the
// contract without mounting a Base UI floating tree (which schedules
// microtask / rAF work that leaks under `--detect-async-leaks`). The
// non-twin reset values (threshold 7, unit "days", display "always",
// empty mapping, the seeded `case_name` field) all originate in
// `columnCardSchemas[target].defaultValue(ctx)`, so calling the pure
// function with the same `ctx` reproduces them exactly.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type CaseType,
	type Column,
	type ColumnKind,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	imageMapColumn,
	intervalColumn,
	linkColumn,
	phoneColumn,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { preservedColumnSwap } from "../../../ColumnEditor";
import {
	type ColumnEditContext,
	columnCardSchemas,
} from "../../../columnEditorSchemas";

const TEST_UUID = testUuid("00000000-0000-0000-0000-000000000001");

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: proseText("Name"), data_type: "text" },
		{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
	],
};

// The exact `ColumnEditContext` `ColumnEditor` assembles from its
// props and hands to `preservedColumnSwap`: the case-type schema
// plus the current scope. The default-value factories the swap
// invokes for non-twin extras / field seeding read these.
const CTX: ColumnEditContext = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
};
const TILE = tileCell(2, 1, 5, 2, {
	horizontalAlign: "right",
	verticalAlign: "middle",
	fontSize: "large",
	showBorder: true,
	showShading: true,
});

const TILED_SOURCE_COLUMNS: readonly Column[] = [
	plainColumn(TEST_UUID, "case_name", "Name", { tile: TILE }),
	phoneColumn(TEST_UUID, "case_name", "Phone", { tile: TILE }),
	dateColumn(TEST_UUID, "dob", "Birthday", "%Y-%m-%d", { tile: TILE }),
	idMappingColumn(TEST_UUID, "case_name", "Name", [], { tile: TILE }),
	imageMapColumn(TEST_UUID, "case_name", "Image", [], { tile: TILE }),
	intervalColumn(TEST_UUID, "dob", "Age", 7, "days", "always", "Old", {
		tile: TILE,
	}),
	linkColumn(TEST_UUID, "case_name", "Photo", "Open", { tile: TILE }),
	calculatedColumn(TEST_UUID, "Summary", term(literal("Ready")), {
		tile: TILE,
	}),
];
// Read off the card registry rather than restated here. A hand-kept
// list silently stops covering a kind the moment one is added, which
// is exactly how a display that the menu offered but the swap could
// not build went unnoticed.
const TARGET_KINDS = Object.keys(columnCardSchemas) as ColumnKind[];

// Displays that read the value as words, so a date property cannot
// reach them; the rest of the pairs are compatible by construction.
const TEXT_ONLY_TARGETS: ReadonlySet<ColumnKind> = new Set(["phone", "link"]);

function swapped(
	source: Column,
	target: ColumnKind,
	ctx: ColumnEditContext = CTX,
): Column {
	const next = preservedColumnSwap(source, target, ctx);
	expect(next).toBeDefined();
	if (next === undefined) throw new Error(`expected ${target} swap`);
	return next;
}

describe("preservedColumnSwap — universal field + header preservation", () => {
	it.each(
		TILED_SOURCE_COLUMNS.flatMap((source) =>
			TARGET_KINDS.filter(
				(target) =>
					target === "calculated" ||
					source.kind === "calculated" ||
					(source.field === "dob"
						? !TEXT_ONLY_TARGETS.has(target)
						: target !== "date" && target !== "interval"),
			).map((target) => [source.kind, target, source] as const),
		),
	)(
		"%s → %s preserves the complete tile presentation",
		(_sourceKind, targetKind, source) => {
			expect(swapped(source, targetKind).tile).toEqual(TILE);
		},
	);

	it("refuses an incompatible source/display pair instead of rewriting its field", () => {
		expect(
			preservedColumnSwap(
				plainColumn(TEST_UUID, "case_name", "Name", { tile: TILE }),
				"date",
				CTX,
			),
		).toBeUndefined();
		expect(
			preservedColumnSwap(
				dateColumn(TEST_UUID, "dob", "Birthday", "%Y-%m-%d", {
					tile: TILE,
				}),
				"phone",
				CTX,
			),
		).toBeUndefined();
	});

	it("Plain → Link keeps the property and seeds the schema's link text", () => {
		const next = swapped(plainColumn(TEST_UUID, "case_name", "Photo"), "link");
		expect(next.kind).toBe("link");
		if (next.kind !== "link") throw new Error("expected link");
		expect(next.field).toBe("case_name");
		expect(next.header).toBe("Photo");
		expect(next.uuid).toBe(TEST_UUID);
		expect(next.linkText).toBe(
			columnCardSchemas.link.defaultValue(CTX)?.linkText,
		);
	});

	it("Link → Link keeps the author's own link text", () => {
		const next = swapped(
			linkColumn(TEST_UUID, "case_name", "Photo", "See the photo"),
			"link",
		);
		if (next.kind !== "link") throw new Error("expected link");
		expect(next.linkText).toBe("See the photo");
	});

	it("Link → Plain preserves field + header + uuid", () => {
		const next = swapped(
			linkColumn(TEST_UUID, "case_name", "Photo", "Open"),
			"plain",
		);
		expect(next.kind).toBe("plain");
		if (next.kind !== "plain") throw new Error("expected plain");
		expect(next.field).toBe("case_name");
		expect(next.header).toBe("Photo");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("refuses Link over a date property instead of rewriting its field", () => {
		expect(
			preservedColumnSwap(
				dateColumn(TEST_UUID, "dob", "Birthday", "%Y-%m-%d"),
				"link",
				CTX,
			),
		).toBeUndefined();
	});

	it("Plain → Interval preserves field + header + uuid", () => {
		const next = swapped(plainColumn(TEST_UUID, "dob", "Birthday"), "interval");
		expect(next.kind).toBe("interval");
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("Plain → Date preserves field + header + uuid", () => {
		const next = swapped(plainColumn(TEST_UUID, "dob", "Birthday"), "date");
		expect(next.kind).toBe("date");
		if (next.kind !== "date") throw new Error("expected date");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("Interval → Plain preserves field + header + uuid", () => {
		const next = swapped(
			intervalColumn(TEST_UUID, "dob", "Birthday", 30, "days", "flag", "Old"),
			"plain",
		);
		expect(next.kind).toBe("plain");
		if (next.kind !== "plain") throw new Error("expected plain");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("ID Mapping → Plain preserves field + header (mapping table dropped)", () => {
		const next = swapped(
			idMappingColumn(TEST_UUID, "case_name", "Name", [
				{ value: "x", label: "X" },
			]),
			"plain",
		);
		expect(next.kind).toBe("plain");
		if (next.kind !== "plain") throw new Error("expected plain");
		expect(next.field).toBe("case_name");
		expect(next.header).toBe("Name");
	});
});

describe("preservedColumnSwap — calc transitions", () => {
	it("Plain → Calculated drops the field; preserves header + uuid", () => {
		const next = swapped(
			plainColumn(TEST_UUID, "case_name", "Name column"),
			"calculated",
		);
		expect(next.kind).toBe("calculated");
		if (next.kind !== "calculated") throw new Error("expected calculated");
		expect(next.header).toBe("Name column");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("Calculated → Plain seeds the field from the target schema", () => {
		const next = swapped(
			calculatedColumn(TEST_UUID, "Computed", term(literal("hi"))),
			"plain",
		);
		expect(next.kind).toBe("plain");
		if (next.kind !== "plain") throw new Error("expected plain");
		expect(next.header).toBe("Computed");
		expect(next.uuid).toBe(TEST_UUID);
		// The catalog exposes only Nova's canonical standard name.
		expect(next.field).toBe("case_name");
	});

	it("Calculated → required display seeds a declared honest-unknown property", () => {
		const unknownCtx: ColumnEditContext = {
			currentCaseType: "patient",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "untyped_value",
							label: proseText("Imported value"),
						},
					],
				},
			],
		};
		const source = calculatedColumn(TEST_UUID, "Computed", term(literal("hi")));

		for (const target of ["date", "phone", "interval"] as const) {
			const next = swapped(source, target, unknownCtx);
			if (next.kind === "calculated") {
				throw new Error(`expected field-bearing ${target} column`);
			}
			expect(next.field).toBe("untyped_value");
		}
	});
});

describe("preservedColumnSwap — non-twin transitions reset extras", () => {
	it("Plain → Interval reseeds threshold + unit + display from defaults", () => {
		const next = swapped(plainColumn(TEST_UUID, "dob", "Birthday"), "interval");
		expect(next.kind).toBe("interval");
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		// Extras come from the `interval` schema's `defaultValue(ctx)`:
		// a non-twin (plain) source seeds them fresh rather than carrying
		// over. Calling the pure swap with the same `ctx` reproduces the
		// exact factory output.
		expect(next.threshold).toBe(7);
		expect(next.unit).toBe("days");
		expect(next.display).toBe("always");
	});

	it("Date → ID Mapping resets the mapping table but preserves field + header", () => {
		const next = swapped(
			dateColumn(TEST_UUID, "dob", "Birthday", "%d-%b-%Y"),
			"id-mapping",
		);
		expect(next.kind).toBe("id-mapping");
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		// Non-twin (date) source → empty mapping table from the schema.
		expect(next.mapping).toEqual([]);
	});

	it("returns unavailable instead of inventing a field for a calculated source", () => {
		const noProperties: ColumnEditContext = {
			currentCaseType: "patient",
			caseTypes: [{ name: "patient", properties: [] }],
		};

		expect(
			preservedColumnSwap(
				calculatedColumn(TEST_UUID, "Computed", term(literal("hi"))),
				"plain",
				noProperties,
			),
		).toBeUndefined();
	});
});
