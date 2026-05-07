// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/column/ColumnEditor.test.tsx
//
// Validity + applicability tests for the top-level ColumnEditor.
// Pins two behaviors:
//
//   1. Per-kind property-type applicability — Late Flag / Date /
//      Time-Since-Until require a date-typed property; Phone
//      requires a text-shaped property. When the resolved
//      property's data type doesn't satisfy the kind, the editor
//      surfaces an inline error AND propagates `valid: false` to
//      the parent's `onValidityChange` callback.
//
//   2. Round-trip preservation — every card's mutation paths
//      route through the per-kind builders; constructed columns
//      always parse through `columnSchema`. Persisted columns
//      with non-default values (custom date pattern, populated
//      mapping table, non-default threshold + unit) round-trip
//      through the editor untouched.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type CaseType,
	columnSchema,
	dateColumn,
	idMappingColumn,
	lateFlagColumn,
	phoneColumn,
	plainColumn,
	timeSinceUntilColumn,
} from "@/lib/domain";
import { ColumnEditor } from "../../../ColumnEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "phone", label: "Phone", data_type: "text" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
		{ name: "last_seen", label: "Last seen", data_type: "datetime" },
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

describe("ColumnEditor — applicability errors", () => {
	it("reports invalid + surfaces inline error for Late Flag on a text property", async () => {
		const onValidityChange = vi.fn();
		// Late Flag column referencing a text property — applicability
		// requires a date type, so the editor flags the mismatch.
		const value = lateFlagColumn("name", "Header", 7, "days", "Overdue");
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
		expect(container.textContent).toMatch(/date-typed property/i);
	});

	it("reports invalid + surfaces inline error for Date on a text property", async () => {
		const onValidityChange = vi.fn();
		const value = dateColumn("name", "Header", "%Y-%m-%d");
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
		expect(container.textContent).toMatch(/date-typed property/i);
	});

	it("reports invalid + surfaces inline error for Phone on a date property", async () => {
		// Phone column referencing a date property — Phone requires
		// a text-shaped property, so the editor flags the mismatch
		// AND propagates the verdict to onValidityChange. Mirrors the
		// date-side mismatch tests with the opposite shape.
		const onValidityChange = vi.fn();
		const value = phoneColumn("dob", "Phone");
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
		expect(container.textContent).toMatch(/text-typed property/i);
	});

	it("reports valid for Phone on a text property", async () => {
		const onValidityChange = vi.fn();
		const value = phoneColumn("phone", "Contact");
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});

	it("reports invalid + surfaces inline error for Time Since/Until on a non-date property", async () => {
		const onValidityChange = vi.fn();
		const value = timeSinceUntilColumn("name", "Header", 7, "days", "Overdue");
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
		expect(container.textContent).toMatch(/date-typed property/i);
	});

	it("reports valid for Late Flag on a date property", async () => {
		const onValidityChange = vi.fn();
		const value = lateFlagColumn("dob", "Header", 7, "days", "Overdue");
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});

	it("reports valid for Plain on any property", async () => {
		const onValidityChange = vi.fn();
		const value = plainColumn("status", "Header");
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});

	it("stays permissive while the field is unset (empty string)", async () => {
		// An empty `field` slot means "no property selected yet" —
		// the kind picker should stay permissive so the user can
		// finish authoring. The editor reports valid until a
		// concrete property is chosen.
		const onValidityChange = vi.fn();
		const value = lateFlagColumn("", "Header", 7, "days", "Overdue");
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});
});

describe("ColumnEditor — round-trip preservation", () => {
	it("preserves a custom date pattern across mount / re-render", () => {
		const value = dateColumn("dob", "Birthday", "%d-%b-%Y");
		const onChange = vi.fn();
		const { rerender } = render(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// No spurious onChange on mount — the editor doesn't rewrite
		// authored ASTs.
		expect(onChange).not.toHaveBeenCalled();
		// Re-render with the same value — still no rewrite.
		rerender(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(onChange).not.toHaveBeenCalled();
		// Verify the value parses through the schema as-is.
		expect(() => columnSchema.parse(value)).not.toThrow();
	});

	it("preserves an authored id-mapping table across mount", () => {
		const value = idMappingColumn("status", "Status", [
			{ value: "active", label: "Active patient" },
			{ value: "inactive", label: "Discharged" },
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
		expect(onChange).not.toHaveBeenCalled();
		expect(() => columnSchema.parse(value)).not.toThrow();
	});

	it("preserves time-since-until threshold + unit + displayLabel", () => {
		const value = timeSinceUntilColumn(
			"dob",
			"Age (months)",
			6,
			"months",
			"Old",
		);
		const onChange = vi.fn();
		render(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(() => columnSchema.parse(value)).not.toThrow();
	});
});
