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
//   - Add opens a local draft and commits only a complete row.
//   - Invalid/duplicate saved values never reach persisted column state.
//   - Move-up swaps the entry with its predecessor; the first
//     entry's move-up button is disabled.
//   - Move-down swaps the entry with its successor; the last
//     entry's move-down button is disabled.
//   - Remove drops the entry from the table; the next render
//     reflects the new length.
//
// Each operation routes through `idMappingColumn(...)` so the
// emitted Column always parses through `columnSchema`.

import {
	fireEvent,
	render as rtlRender,
	screen,
	waitFor,
} from "@testing-library/react";
import { type ReactElement, type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	type CaseType,
	type Column,
	columnSchema,
	type IdMappingEntry,
	idMappingColumn,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { ColumnEditor } from "../../../ColumnEditor";

// The surfaces here spell authored prose against the document; every production
// mount sits inside the builder's provider. Wrapping at `render` reproduces it
// and carries through each `rerender`.
function DocumentProvider({ children }: { readonly children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="test-app">{children}</BlueprintDocProvider>
	);
}

function render(ui: ReactElement) {
	return rtlRender(ui, { wrapper: DocumentProvider });
}

const TEST_UUID = testUuid("00000000-0000-0000-0000-000000000001");

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{
			name: "status",
			label: proseText("Status"),
			data_type: "single_select",
			options: [
				{ value: "active", label: proseText("Active") },
				{ value: "inactive", label: proseText("Inactive") },
			],
		},
	],
};

function lastEmittedColumn(onChange: ReturnType<typeof vi.fn>): Column {
	expect(onChange).toHaveBeenCalled();
	const last = onChange.mock.calls.at(-1)?.[0] as Column;
	return last;
}

function StatefulMappingEditor({ entries }: { entries: IdMappingEntry[] }) {
	const [value, setValue] = useState<Column>(
		idMappingColumn(TEST_UUID, "status", "Status", entries),
	);
	return (
		<ColumnEditor
			value={value}
			onChange={setValue}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
		/>
	);
}

describe("IdMappingCard — table mutations", () => {
	it("uses semantic labels without visible row numbers or code styling", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", [
			{ value: "active", label: "Active" },
		]);
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);

		expect(screen.getByRole("group", { name: "Value 1" })).toBeDefined();
		expect(screen.getByText("Value 1").className).toContain("sr-only");
		expect(screen.getByText("Saved value").className).toContain("text-[13px]");
		expect(screen.getByText("Label shown").className).toContain("text-[13px]");
		expect(
			screen.getByLabelText("Value 1 saved value").className,
		).not.toContain("font-mono");
		// The add affordance is ordinary UI text, not a code chip. It takes
		// the system button's own control text size now rather than pinning
		// a one-off, so assert what the rule actually is: not mono.
		expect(
			screen.getByRole("button", { name: "Add value" }).className,
		).not.toContain("font-mono");
		expect(
			screen.getByRole("button", { name: "Add value" }).className,
		).toContain("nova-add-slot");
	});

	it("keeps a new row local until its saved value is complete", () => {
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
		fireEvent.click(screen.getByRole("button", { name: /add value/i }));
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText("Value 2 saved value"), {
			target: { value: "inactive" },
		});
		fireEvent.change(screen.getByLabelText("Value 2 display label"), {
			target: { value: "Inactive" },
		});
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Save value" }));
		const next = lastEmittedColumn(onChange);
		expect(next.kind).toBe("id-mapping");
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.mapping).toHaveLength(2);
		expect(next.mapping[1]).toEqual({
			value: "inactive",
			label: "Inactive",
		});
		expect(() => columnSchema.parse(next)).not.toThrow();
	});

	it.each([
		["a blank value", ""],
		["a value containing whitespace", "not active"],
		["a duplicate value", "active"],
	] as const)(
		"does not commit %s from the local add row",
		(_label, candidate) => {
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

			fireEvent.click(screen.getByRole("button", { name: /add value/i }));
			if (candidate !== "") {
				fireEvent.change(screen.getByLabelText("Value 2 saved value"), {
					target: { value: candidate },
				});
			}

			const save = screen.getByRole("button", { name: "Save value" });
			expect((save as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(save);
			expect(onChange).not.toHaveBeenCalled();
		},
	);

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
			name: /move value .* later/i,
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
			name: /move value .* earlier/i,
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
			name: /remove value/i,
		});
		fireEvent.click(removeButtons[0]);
		const next = lastEmittedColumn(onChange);
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.mapping).toEqual([{ value: "b", label: "Beta" }]);
	});

	it("moves focus to the next value, previous value, then Add as rows are removed", async () => {
		render(
			<StatefulMappingEditor
				entries={[
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
				]}
			/>,
		);

		fireEvent.click(
			screen.getAllByRole("button", { name: /remove value/i })[0],
		);
		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByLabelText("Value 1 saved value"),
			);
		});

		fireEvent.click(screen.getByRole("button", { name: /remove value/i }));
		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add value" }),
			);
		});
	});

	it("moves focus to the previous value when the final row is removed", async () => {
		render(
			<StatefulMappingEditor
				entries={[
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
				]}
			/>,
		);

		fireEvent.click(
			screen.getAllByRole("button", { name: /remove value/i })[1],
		);
		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByLabelText("Value 1 saved value"),
			);
		});
	});

	it("Empty mapping table explains that no replacement text is shown", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", []);
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(
			/add a saved value and label to show replacement text/i,
		);
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
			"Value 1 saved value",
		) as HTMLInputElement;
		// Focus the input first: the commit re-sync effect inside
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

	it.each([
		["a blank value", ""],
		["a value containing whitespace", "not active"],
		["a duplicate value", "inactive"],
	] as const)(
		"does not persist %s over an existing row",
		(_label, candidate) => {
			const value = idMappingColumn(TEST_UUID, "status", "Status", [
				{ value: "active", label: "Active" },
				{ value: "inactive", label: "Inactive" },
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
				"Value 1 saved value",
			) as HTMLInputElement;
			valueInput.focus();
			fireEvent.change(valueInput, { target: { value: candidate } });
			fireEvent.blur(valueInput);

			expect(onChange).not.toHaveBeenCalled();
			expect(
				screen.getByText(/enter a saved value|cannot contain spaces|already/i),
			).toBeDefined();
		},
	);

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
			"Value 1 display label",
		) as HTMLInputElement;
		labelInput.focus();
		fireEvent.change(labelInput, { target: { value: "New label" } });
		fireEvent.blur(labelInput);
		const next = lastEmittedColumn(onChange);
		if (next.kind !== "id-mapping") throw new Error("expected id-mapping");
		expect(next.mapping).toEqual([{ value: "active", label: "New label" }]);
	});
});
