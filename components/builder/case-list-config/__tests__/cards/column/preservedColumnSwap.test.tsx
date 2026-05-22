// components/builder/case-list-config/__tests__/cards/column/preservedColumnSwap.test.tsx
//
// Unit tests for `preservedColumnSwap` — the pure column
// kind-replace transformation in `ColumnEditor`. Given a current
// Column, a target kind, and the editor context, it returns the
// rebuilt Column under the target kind. The transformation is total
// (no `null` arm) and enforces three preservation tiers:
//
//   - **Universal header + uuid + common slots** — every kind
//     transition threads `header`, `uuid`, and the optional common
//     slots (`sort`, `visibleInList`, `visibleInDetail`) through
//     verbatim. They're identity / surface-visibility shape, not
//     kind-specific.
//   - **Field preservation** — the five non-calc kinds all carry
//     `field: string`, so a swap among them preserves `field`
//     verbatim. Calc has no field: swapping TO calc drops it;
//     swapping FROM calc seeds the new field from the target
//     schema's default factory (the case type's first applicable
//     property).
//   - **Kind-specific extras** — date pattern, mapping table,
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
// empty mapping, the seeded `name` field) all originate in
// `columnCardSchemas[target].defaultValue(ctx)`, so calling the pure
// function with the same `ctx` reproduces them exactly.

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseType,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	intervalColumn,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { preservedColumnSwap } from "../../../ColumnEditor";
import type { ColumnEditContext } from "../../../columnEditorSchemas";

const TEST_UUID = asUuid("00000000-0000-0000-0000-000000000001");

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};

// The exact `ColumnEditContext` `ColumnEditor` assembles from its
// props and hands to `preservedColumnSwap` — the case-type schema
// plus the current scope. The default-value factories the swap
// invokes for non-twin extras / field seeding read these.
const CTX: ColumnEditContext = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
};

describe("preservedColumnSwap — universal field + header preservation", () => {
	it("Plain → Interval preserves field + header + uuid", () => {
		const next = preservedColumnSwap(
			plainColumn(TEST_UUID, "dob", "Birthday"),
			"interval",
			CTX,
		);
		expect(next.kind).toBe("interval");
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("Plain → Date preserves field + header + uuid", () => {
		const next = preservedColumnSwap(
			plainColumn(TEST_UUID, "dob", "Birthday"),
			"date",
			CTX,
		);
		expect(next.kind).toBe("date");
		if (next.kind !== "date") throw new Error("expected date");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("Interval → Plain preserves field + header + uuid", () => {
		const next = preservedColumnSwap(
			intervalColumn(TEST_UUID, "dob", "Birthday", 30, "days", "flag", "Old"),
			"plain",
			CTX,
		);
		expect(next.kind).toBe("plain");
		if (next.kind !== "plain") throw new Error("expected plain");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("ID Mapping → Plain preserves field + header (mapping table dropped)", () => {
		const next = preservedColumnSwap(
			idMappingColumn(TEST_UUID, "name", "Name", [{ value: "x", label: "X" }]),
			"plain",
			CTX,
		);
		expect(next.kind).toBe("plain");
		if (next.kind !== "plain") throw new Error("expected plain");
		expect(next.field).toBe("name");
		expect(next.header).toBe("Name");
	});
});

describe("preservedColumnSwap — calc transitions", () => {
	it("Plain → Calculated drops the field; preserves header + uuid", () => {
		const next = preservedColumnSwap(
			plainColumn(TEST_UUID, "name", "Name column"),
			"calculated",
			CTX,
		);
		expect(next.kind).toBe("calculated");
		if (next.kind !== "calculated") throw new Error("expected calculated");
		expect(next.header).toBe("Name column");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("Calculated → Plain seeds the field from the target schema", () => {
		const next = preservedColumnSwap(
			calculatedColumn(TEST_UUID, "Computed", term(literal("hi"))),
			"plain",
			CTX,
		);
		expect(next.kind).toBe("plain");
		if (next.kind !== "plain") throw new Error("expected plain");
		expect(next.header).toBe("Computed");
		expect(next.uuid).toBe(TEST_UUID);
		// The seed picks the case type's first property — `name`.
		expect(next.field).toBe("name");
	});
});

describe("preservedColumnSwap — non-twin transitions reset extras", () => {
	it("Plain → Interval reseeds threshold + unit + display from defaults", () => {
		const next = preservedColumnSwap(
			plainColumn(TEST_UUID, "dob", "Birthday"),
			"interval",
			CTX,
		);
		expect(next.kind).toBe("interval");
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		// Extras come from the `interval` schema's `defaultValue(ctx)` —
		// a non-twin (plain) source seeds them fresh rather than carrying
		// over. Calling the pure swap with the same `ctx` reproduces the
		// exact factory output.
		expect(next.threshold).toBe(7);
		expect(next.unit).toBe("days");
		expect(next.display).toBe("always");
	});

	it("Date → ID Mapping resets the mapping table but preserves field + header", () => {
		const next = preservedColumnSwap(
			dateColumn(TEST_UUID, "dob", "Birthday", "%d-%b-%Y"),
			"id-mapping",
			CTX,
		);
		expect(next.kind).toBe("id-mapping");
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		// Non-twin (date) source → empty mapping table from the schema.
		expect(next.mapping).toEqual([]);
	});
});
