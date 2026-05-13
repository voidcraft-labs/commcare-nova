// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/column/preservedColumnSwap.test.tsx
//
// Round-trip tests for the column kind-replace logic. Drives the
// real "Change" menu in the rendered editor — open menu, click
// the target kind, capture the emitted Column. Pins the
// kind-replace UX's contract end-to-end.
//
// Three preservation tiers:
//
//   - **Universal header + uuid + slots** — every kind transition
//     preserves the header, uuid, and optional common slots
//     (`sort`, `visibleInList`, `visibleInDetail`).
//   - **Field preservation** — non-calc-to-non-calc transitions
//     preserve `field`. Calc has no field, so transitions involving
//     calc seed the field from the target schema (when leaving
//     calc) or drop it (when entering calc).
//   - **Twin transitions** — `interval(always)` ↔ `interval(flag)`
//     would be a same-kind transition (disabled by the menu); twin
//     transitions for kind-specific extras occur within the
//     interval card's display toggle, not via kind swap.
//   - **Non-twin transitions** — kind-specific extras (date
//     pattern, mapping table, threshold, expression) reset to the
//     target schema's defaults.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseType,
	type Column,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	intervalColumn,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { ColumnEditor } from "../../../ColumnEditor";

const TEST_UUID = asUuid("00000000-0000-0000-0000-000000000001");

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};

/** Escape regex metacharacters so callers can pass plain
 *  registry-description strings without thinking about regex
 *  syntax. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Render the editor, open the "Change" menu, click the option
 *  whose description substring matches `targetDescription`, and
 *  return the emitted Column. Matches against `description` to
 *  disambiguate label collisions. */
function swapTo(value: Column, targetDescription: string): Column {
	const onChange = vi.fn();
	render(
		<ColumnEditor
			value={value}
			onChange={onChange}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
			sortedColumnCount={0}
			sortPriorityPosition={undefined}
		/>,
	);
	const trigger = screen.getByRole("button", { name: /change column type/i });
	fireEvent.click(trigger);
	const pattern = new RegExp(escapeRegex(targetDescription), "i");
	const targetItem = screen.getByRole("menuitem", { name: pattern });
	fireEvent.click(targetItem);
	expect(onChange).toHaveBeenCalledTimes(1);
	return onChange.mock.calls[0][0] as Column;
}

describe("preservedColumnSwap — universal field + header preservation", () => {
	it("Plain → Interval preserves field + header", () => {
		const next = swapTo(
			plainColumn(TEST_UUID, "dob", "Birthday"),
			"Show a relative interval against a date property",
		);
		expect(next.kind).toBe("interval");
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("Plain → Date preserves field + header", () => {
		const next = swapTo(
			plainColumn(TEST_UUID, "dob", "Birthday"),
			"Format a date / datetime property",
		);
		expect(next.kind).toBe("date");
		if (next.kind !== "date") throw new Error("expected date");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("Interval → Plain preserves field + header", () => {
		const next = swapTo(
			intervalColumn(TEST_UUID, "dob", "Birthday", 30, "days", "flag", "Old"),
			"Render the property value as plain text",
		);
		expect(next.kind).toBe("plain");
		if (next.kind !== "plain") throw new Error("expected plain");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("ID Mapping → Plain preserves field + header (mapping table dropped)", () => {
		const next = swapTo(
			idMappingColumn(TEST_UUID, "name", "Name", [{ value: "x", label: "X" }]),
			"Render the property value as plain text",
		);
		expect(next.kind).toBe("plain");
		if (next.kind !== "plain") throw new Error("expected plain");
		expect(next.field).toBe("name");
		expect(next.header).toBe("Name");
	});
});

describe("preservedColumnSwap — calc transitions", () => {
	it("Plain → Calculated drops the field; preserves header + uuid", () => {
		const next = swapTo(
			plainColumn(TEST_UUID, "name", "Name column"),
			"Project a derived per-row value from an expression",
		);
		expect(next.kind).toBe("calculated");
		if (next.kind !== "calculated") throw new Error("expected calculated");
		expect(next.header).toBe("Name column");
		expect(next.uuid).toBe(TEST_UUID);
	});

	it("Calculated → Plain seeds the field from the target schema", () => {
		const next = swapTo(
			calculatedColumn(TEST_UUID, "Computed", term(literal("hi"))),
			"Render the property value as plain text",
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
	it("Plain → Interval reseeds threshold + unit + display + text from defaults", () => {
		const next = swapTo(
			plainColumn(TEST_UUID, "dob", "Birthday"),
			"Show a relative interval against a date property",
		);
		expect(next.kind).toBe("interval");
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		// Defaults from the registry — see the `interval` entry in
		// `columnEditorSchemas.ts`.
		expect(next.threshold).toBe(7);
		expect(next.unit).toBe("days");
		expect(next.display).toBe("always");
	});

	it("Date → ID Mapping resets pattern but preserves field + header", () => {
		const next = swapTo(
			dateColumn(TEST_UUID, "dob", "Birthday", "%d-%b-%Y"),
			"Look up a label for each property value",
		);
		expect(next.kind).toBe("id-mapping");
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.mapping).toEqual([]);
	});
});
