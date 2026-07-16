// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/column/IdMappingCard.test.tsx
//
// Reorder + add + remove tests for the id-mapping column card's
// mapping table. The card uses manual move-up / move-down
// buttons rather than drag-and-drop (mapping tables are short,
// authored once; the pragmatic-dnd pipeline is over-engineered
// for the use case). This test pins:
//
//   - Add appends a new empty entry to the table.
//   - Move-up swaps the entry with its predecessor; the first
//     entry's move-up button is disabled.
//   - Move-down swaps the entry with its successor; the last
//     entry's move-down button is disabled.
//   - Remove drops the entry from the table; the next render
//     reflects the new length.
//
// Each operation routes through `idMappingColumn(...)` so the
// emitted Column always parses through `columnSchema`.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseType,
	type Column,
	columnSchema,
	idMappingColumn,
} from "@/lib/domain";
import { ColumnEditor } from "../../../ColumnEditor";

const TEST_UUID = asUuid("00000000-0000-0000-0000-000000000001");

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{
			name: "status",
			label: "Status",
			data_type: "single_select",
			options: [
				{ value: "active", label: "Active" },
				{ value: "inactive", label: "Inactive" },
			],
		},
	],
};

function lastEmittedColumn(onChange: ReturnType<typeof vi.fn>): Column {
	expect(onChange).toHaveBeenCalled();
	const last = onChange.mock.calls.at(-1)?.[0] as Column;
	return last;
}

describe("IdMappingCard — table mutations", () => {
	it("Add mapping appends an empty entry", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", [
			{ value: "active", label: "Active" },
		]);
		const onChange = vi.fn();
		render(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /add value rule/i }));
		const next = lastEmittedColumn(onChange);
		expect(next.kind).toBe("id-mapping");
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.mapping).toHaveLength(2);
		expect(next.mapping[1]).toEqual({ value: "", label: "" });
		expect(() => columnSchema.parse(next)).not.toThrow();
	});

	it("Move down swaps adjacent entries", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", [
			{ value: "a", label: "Alpha" },
			{ value: "b", label: "Beta" },
		]);
		const onChange = vi.fn();
		render(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// Two move-down buttons rendered (one per entry); the last
		// row's button is disabled. Pick the first.
		const moveDownButtons = screen.getAllByRole("button", {
			name: /move rule .* later/i,
		});
		expect((moveDownButtons[1] as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(moveDownButtons[0]);
		const next = lastEmittedColumn(onChange);
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.mapping).toEqual([
			{ value: "b", label: "Beta" },
			{ value: "a", label: "Alpha" },
		]);
	});

	it("Move up swaps adjacent entries", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", [
			{ value: "a", label: "Alpha" },
			{ value: "b", label: "Beta" },
		]);
		const onChange = vi.fn();
		render(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const moveUpButtons = screen.getAllByRole("button", {
			name: /move rule .* earlier/i,
		});
		// First entry's up-button disabled; second entry's enabled.
		expect((moveUpButtons[0] as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(moveUpButtons[1]);
		const next = lastEmittedColumn(onChange);
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.mapping).toEqual([
			{ value: "b", label: "Beta" },
			{ value: "a", label: "Alpha" },
		]);
	});

	it("Remove drops the entry from the table", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", [
			{ value: "a", label: "Alpha" },
			{ value: "b", label: "Beta" },
		]);
		const onChange = vi.fn();
		render(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const removeButtons = screen.getAllByRole("button", {
			name: /remove rule/i,
		});
		fireEvent.click(removeButtons[0]);
		const next = lastEmittedColumn(onChange);
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.mapping).toEqual([{ value: "b", label: "Beta" }]);
	});

	it("Empty mapping table renders the no-entries hint", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", []);
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/no entries/i);
	});

	it("Editing a value commits on blur", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", [
			{ value: "old", label: "Old" },
		]);
		const onChange = vi.fn();
		render(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const valueInput = screen.getByLabelText(
			"Value rule 1 saved value",
		) as HTMLInputElement;
		// Focus the input first — the commit re-sync effect inside
		// the input checks `document.activeElement === inputRef.current`
		// before letting the local draft hold its in-flight value;
		// without focus, the draft would re-sync to the source on
		// every render.
		valueInput.focus();
		fireEvent.change(valueInput, { target: { value: "new" } });
		fireEvent.blur(valueInput);
		const next = lastEmittedColumn(onChange);
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.mapping).toEqual([{ value: "new", label: "Old" }]);
	});

	it("Editing a label commits on blur", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", [
			{ value: "active", label: "Old label" },
		]);
		const onChange = vi.fn();
		render(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const labelInput = screen.getByLabelText(
			"Value rule 1 display label",
		) as HTMLInputElement;
		labelInput.focus();
		fireEvent.change(labelInput, { target: { value: "New label" } });
		fireEvent.blur(labelInput);
		const next = lastEmittedColumn(onChange);
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.mapping).toEqual([{ value: "active", label: "New label" }]);
	});
});
