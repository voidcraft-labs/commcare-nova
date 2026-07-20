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
//     `intervalColumn(...)` / `phoneColumn(...)` builder so the
//     emitted AST stays in lockstep with the schema).
//
// Tests focus on the kind-specific text inputs (display labels,
// flag values) and threshold inputs. Pattern selection /
// preset switching is covered by `CustomDatePatternInput.test.tsx`
// at the primitive level.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseType,
	type Column,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	imageMapColumn,
	intervalColumn,
	phoneColumn,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
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

const TEST_UUID = asUuid("00000000-0000-0000-0000-000000000001");

const SURFACE_SLOTS = {
	sort: { direction: "asc" as const, priority: 0 },
	visibleInList: true,
	visibleInDetail: true,
	listOrder: "results-position",
	detailOrder: "details-position",
};

const ORDERED_COLUMN_KINDS: readonly Column[] = [
	plainColumn(TEST_UUID, "name", "Name", SURFACE_SLOTS),
	phoneColumn(TEST_UUID, "phone", "Phone", SURFACE_SLOTS),
	dateColumn(TEST_UUID, "dob", "Birthday", "short", SURFACE_SLOTS),
	idMappingColumn(TEST_UUID, "name", "Name", [], SURFACE_SLOTS),
	imageMapColumn(TEST_UUID, "name", "Name", [], SURFACE_SLOTS),
	intervalColumn(
		TEST_UUID,
		"dob",
		"Age",
		7,
		"days",
		"always",
		"Old",
		SURFACE_SLOTS,
	),
	calculatedColumn(TEST_UUID, "Summary", term(literal("Ready")), SURFACE_SLOTS),
];

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

describe("display-item edits preserve independent screen positions", () => {
	it.each(ORDERED_COLUMN_KINDS.map((column) => [column.kind, column] as const))(
		"%s label edits retain Results and Details order",
		(_kind, value) => {
			const next = emitFromEdit(value, () => {
				const input = screen.getByLabelText(
					"Display label",
				) as HTMLInputElement;
				input.focus();
				fireEvent.change(input, { target: { value: "Updated label" } });
				fireEvent.blur(input);
			});

			expect(next.listOrder).toBe(SURFACE_SLOTS.listOrder);
			expect(next.detailOrder).toBe(SURFACE_SLOTS.detailOrder);
			expect(next.sort).toEqual(SURFACE_SLOTS.sort);
			expect(next.visibleInList).toBe(true);
			expect(next.visibleInDetail).toBe(true);
		},
	);
});

describe("DateColumnCard — pattern edits", () => {
	it("describes the year-month-day outcome with a visible example", () => {
		const value = dateColumn(TEST_UUID, "dob", "Birthday", "%Y-%m-%d");
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Year-month-day" }),
		).toBeDefined();
		expect(screen.getByText("Example")).toBeDefined();
		expect(screen.getByText("“2026-07-07”")).toBeDefined();
	});

	it("clicking a preset commits the preset's pattern verbatim", () => {
		const value = dateColumn(TEST_UUID, "dob", "Birthday", "%d-%b-%Y");
		const next = emitFromEdit(value, () => {
			fireEvent.click(screen.getByRole("button", { name: /^short$/i }));
		});
		expect(next.kind).toBe("date");
		if (next.kind !== "date") throw new Error("expected date");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Birthday");
		expect(next.pattern).toBe("%m/%d/%Y");
	});

	it("does not rewrite an imported preset id when its active choice is clicked", () => {
		const onChange = vi.fn();
		render(
			<ColumnEditor
				value={dateColumn(TEST_UUID, "dob", "Birthday", "short")}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Short" }));

		expect(onChange).not.toHaveBeenCalled();
	});

	it("editing the custom pattern blur-commits the new pattern", () => {
		const value = dateColumn(TEST_UUID, "dob", "Birthday", "%d-%b-%Y");
		const next = emitFromEdit(value, () => {
			const input = screen.getByRole("textbox", {
				name: "Custom date style",
			}) as HTMLInputElement;
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

describe("IntervalCard — extras edits (always-display)", () => {
	it("states that overdue text replaces the interval", () => {
		const value = intervalColumn(
			TEST_UUID,
			"dob",
			"Age",
			7,
			"days",
			"always",
			"Old",
		);
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);

		expect(container.textContent).toMatch(
			/Replaces the interval after it becomes overdue/,
		);
	});

	it("editing the decoration text blur-commits via intervalColumn", () => {
		const value = intervalColumn(
			TEST_UUID,
			"dob",
			"Age",
			7,
			"days",
			"always",
			"Old",
		);
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText(
				/Text when overdue/i,
			) as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "Aged out" } });
			fireEvent.blur(input);
		});
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Age");
		expect(next.threshold).toBe(7);
		expect(next.unit).toBe("days");
		expect(next.display).toBe("always");
		expect(next.text).toBe("Aged out");
	});

	it("editing the threshold preserves the rest of the slots", () => {
		const value = intervalColumn(
			TEST_UUID,
			"dob",
			"Age",
			7,
			"days",
			"always",
			"Old",
		);
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText("Overdue after") as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "30" } });
			fireEvent.blur(input);
		});
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.threshold).toBe(30);
		expect(next.unit).toBe("days");
		expect(next.display).toBe("always");
		expect(next.text).toBe("Old");
	});
});

describe("IntervalCard — extras edits (flag-display)", () => {
	it("editing the flag text blur-commits via intervalColumn", () => {
		const value = intervalColumn(
			TEST_UUID,
			"dob",
			"Status",
			30,
			"days",
			"flag",
			"Overdue",
		);
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText(/Flag text/i) as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "OVERDUE!" } });
			fireEvent.blur(input);
		});
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.field).toBe("dob");
		expect(next.header).toBe("Status");
		expect(next.threshold).toBe(30);
		expect(next.unit).toBe("days");
		expect(next.display).toBe("flag");
		expect(next.text).toBe("OVERDUE!");
	});

	it("editing the threshold preserves field+header+unit+text", () => {
		const value = intervalColumn(
			TEST_UUID,
			"dob",
			"Status",
			30,
			"days",
			"flag",
			"Overdue",
		);
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText("Overdue after") as HTMLInputElement;
			input.focus();
			fireEvent.change(input, { target: { value: "14" } });
			fireEvent.blur(input);
		});
		if (next.kind !== "interval") throw new Error("expected interval");
		expect(next.threshold).toBe(14);
		expect(next.unit).toBe("days");
		expect(next.display).toBe("flag");
		expect(next.text).toBe("Overdue");
	});
});

describe("PhoneColumnCard — header edit", () => {
	it("editing the header blur-commits the new value via phoneColumn", () => {
		const value = phoneColumn(TEST_UUID, "phone", "Phone");
		const next = emitFromEdit(value, () => {
			const input = screen.getByLabelText("Display label") as HTMLInputElement;
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
