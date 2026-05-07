// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/column/cardEdits.test.tsx
//
// Per-card edit tests pinning the AST emission shape for the
// kind-specific extras on each column kind. The smoke test pins
// "mounts without throwing" + "default value parses"; this file
// pins what the card actually emits when the user types into one
// of its non-shared inputs. Catches regressions in:
//
//   - Field+header preservation across an extras edit (e.g. a
//     pattern edit must not drop the header).
//   - The builder routing each card uses (every onChange must
//     route through the typed `dateColumn(...)` /
//     `timeSinceUntilColumn(...)` / `lateFlagColumn(...)` /
//     `phoneColumn(...)` builder so the emitted AST stays in
//     lockstep with the schema).
//
// Tests focus on the kind-specific text inputs (display labels,
// flag values) and threshold inputs. Pattern selection /
// preset switching is covered by `CustomDatePatternInput.test.tsx`
// at the primitive level.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type CaseType,
	type Column,
	dateColumn,
	lateFlagColumn,
	phoneColumn,
	timeSinceUntilColumn,
} from "@/lib/domain";
import { ColumnEditor } from "../../../ColumnEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "phone", label: "Phone", data_type: "text" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
		{ name: "last_visit", label: "Last visit", data_type: "datetime" },
	],
};

/** Render the editor and return the most-recent emitted Column.
 *  Trips the input via `focus → change → blur`; the BlurCommit
 *  inputs gate commits on `document.activeElement === inputRef`
 *  so a bare `change → blur` without prior focus would re-sync
 *  the draft to the source on the effect's next run. */
function emitFromEdit(
	value: Column,
	editFn: (onChange: ReturnType<typeof vi.fn>) => void,
): Column {
	const onChange = vi.fn();
	render(
		<ColumnEditor
			value={value}
			onChange={onChange}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
		/>,
	);
	editFn(onChange);
	expect(onChange).toHaveBeenCalled();
	return onChange.mock.calls.at(-1)?.[0] as Column;
}

describe("DateColumnCard — pattern edits", () => {
	it("clicking a preset commits the preset's pattern verbatim", () => {
		const value = dateColumn("dob", "Birthday", "%d-%b-%Y");
		const next = emitFromEdit(value, () => {
			fireEvent.click(screen.getByRole("button", { name: /^short$/i }));
		});
		expect(next.kind).toBe("date");
		if (next.kind !== "date") throw new Error("expected date");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.pattern).toBe("short");
	});

	it("editing the custom pattern blur-commits the new pattern", () => {
		// Start from a custom pattern so the free-text input is
		// rendered (preset branches hide it).
		const value = dateColumn("dob", "Birthday", "%d-%b-%Y");
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText(
				"Custom date pattern",
			) as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "%Y-%m" } });
			fireEvent.blur(input);
		});
		if (next.kind !== "date") throw new Error("expected date");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.pattern).toBe("%Y-%m");
	});
});

describe("TimeSinceUntilCard — extras edits", () => {
	it("editing the display label blur-commits the new value", () => {
		const value = timeSinceUntilColumn("dob", "Age", 7, "days", "Old");
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText("Display label") as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "Aged out" } });
			fireEvent.blur(input);
		});
		if (next.kind !== "time-since-until")
			throw new Error("expected time-since-until");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Age");
		expect(next.threshold).toBe(7);
		expect(next.unit).toBe("days");
		expect(next.displayLabel).toBe("Aged out");
	});

	it("editing the threshold blur-commits the new number", () => {
		const value = timeSinceUntilColumn("dob", "Age", 7, "days", "Old");
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText("Threshold") as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "30" } });
			fireEvent.blur(input);
		});
		if (next.kind !== "time-since-until")
			throw new Error("expected time-since-until");
		expect(next.threshold).toBe(30);
		expect(next.unit).toBe("days");
	});
});

describe("LateFlagCard — flagDisplayValue edit", () => {
	it("editing the flag value blur-commits the new value", () => {
		const value = lateFlagColumn("dob", "Status", 30, "days", "Overdue");
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText(
				"Flag display value",
			) as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "OVERDUE!" } });
			fireEvent.blur(input);
		});
		if (next.kind !== "late-flag") throw new Error("expected late-flag");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Status");
		expect(next.threshold).toBe(30);
		expect(next.unit).toBe("days");
		expect(next.flagDisplayValue).toBe("OVERDUE!");
	});

	it("editing the threshold preserves field+header+unit+flagValue", () => {
		const value = lateFlagColumn("dob", "Status", 30, "days", "Overdue");
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText("Threshold") as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "14" } });
			fireEvent.blur(input);
		});
		if (next.kind !== "late-flag") throw new Error("expected late-flag");
		expect(next.threshold).toBe(14);
		expect(next.unit).toBe("days");
		expect(next.flagDisplayValue).toBe("Overdue");
	});
});

describe("PhoneColumnCard — header edit", () => {
	it("editing the header blur-commits the new value via phoneColumn", () => {
		const value = phoneColumn("phone", "Phone");
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText("Column header") as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "Contact number" } });
			fireEvent.blur(input);
		});
		expect(next.kind).toBe("phone");
		if (next.kind !== "phone") throw new Error("expected phone");
		expect(next.field).toBe("phone");
		expect(next.header).toBe("Contact number");
	});
});
