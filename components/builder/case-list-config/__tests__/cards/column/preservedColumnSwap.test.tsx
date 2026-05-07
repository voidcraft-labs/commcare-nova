// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/column/preservedColumnSwap.test.tsx
//
// Round-trip tests for the column kind-replace logic. Drives the
// real "Change" menu in the rendered editor — open menu, click
// the target kind, capture the emitted Column. Pins the
// kind-replace UX's contract end-to-end.
//
// Two preservation tiers:
//
//   - **Universal field + header** — every kind transition
//     preserves both slots since every column kind shares the
//     pair.
//   - **Twin transitions** — `time-since-until` ↔ `late-flag`
//     additionally preserve `(threshold, unit)`. Plain → Plain
//     is a no-op (the menu disables the current kind so the
//     no-op transition can't fire spurious onChange).
//   - **Non-twin transitions** — kind-specific extras (date
//     pattern, mapping table, etc.) reset to the target
//     schema's defaults. `field` + `header` always carry over.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type CaseType,
	type Column,
	dateColumn,
	idMappingColumn,
	lateFlagColumn,
	plainColumn,
	timeSinceUntilColumn,
} from "@/lib/domain";
import { ColumnEditor } from "../../../ColumnEditor";

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
 *  disambiguate label collisions (e.g. "Time since / until" vs
 *  any other label sharing a prefix). */
function swapTo(value: Column, targetDescription: string): Column {
	const onChange = vi.fn();
	render(
		<ColumnEditor
			value={value}
			onChange={onChange}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
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
	it("Plain → Late Flag preserves field + header", () => {
		const next = swapTo(
			plainColumn("dob", "Birthday"),
			"Show a flag when the date property exceeds a threshold",
		);
		expect(next.kind).toBe("late-flag");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
	});

	it("Plain → Date preserves field + header", () => {
		const next = swapTo(
			plainColumn("dob", "Birthday"),
			"Format a date / datetime property",
		);
		expect(next.kind).toBe("date");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
	});

	it("Late Flag → Plain preserves field + header", () => {
		const next = swapTo(
			lateFlagColumn("dob", "Birthday", 30, "days", "Old"),
			"Render the property value as plain text",
		);
		expect(next.kind).toBe("plain");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
	});

	it("ID Mapping → Plain preserves field + header (mapping table dropped)", () => {
		const next = swapTo(
			idMappingColumn("name", "Name", [{ value: "x", label: "X" }]),
			"Render the property value as plain text",
		);
		expect(next.kind).toBe("plain");
		expect(next.field).toBe("name");
		expect(next.header).toBe("Name");
	});
});

describe("preservedColumnSwap — twin transitions preserve threshold + unit", () => {
	it("Time Since/Until → Late Flag preserves threshold + unit", () => {
		const next = swapTo(
			timeSinceUntilColumn("dob", "Age", 90, "weeks", "Aged out"),
			"Show a flag when the date property exceeds a threshold",
		);
		expect(next.kind).toBe("late-flag");
		if (next.kind !== "late-flag") throw new Error("expected late-flag");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Age");
		expect(next.threshold).toBe(90);
		expect(next.unit).toBe("weeks");
	});

	it("Late Flag → Time Since/Until preserves threshold + unit", () => {
		const next = swapTo(
			lateFlagColumn("dob", "Age", 14, "months", "Late"),
			"Render a relative interval against the property's date",
		);
		expect(next.kind).toBe("time-since-until");
		if (next.kind !== "time-since-until")
			throw new Error("expected time-since-until");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Age");
		expect(next.threshold).toBe(14);
		expect(next.unit).toBe("months");
	});
});

describe("preservedColumnSwap — non-twin transitions reset extras", () => {
	it("Plain → Time Since/Until reseeds threshold + unit + displayLabel from defaults", () => {
		const next = swapTo(
			plainColumn("dob", "Birthday"),
			"Render a relative interval against the property's date",
		);
		expect(next.kind).toBe("time-since-until");
		if (next.kind !== "time-since-until")
			throw new Error("expected time-since-until");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		// Defaults from the registry — see the `time-since-until` entry
		// in `columnEditorSchemas.ts`.
		expect(next.threshold).toBe(7);
		expect(next.unit).toBe("days");
	});

	it("Date → ID Mapping resets pattern but preserves field + header", () => {
		const next = swapTo(
			dateColumn("dob", "Birthday", "%d-%b-%Y"),
			"Look up a label for each property value",
		);
		expect(next.kind).toBe("id-mapping");
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.mapping).toEqual([]);
	});
});
