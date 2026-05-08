// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/column/ColumnEditor.test.tsx
//
// Validity + applicability tests for the top-level ColumnEditor.
// Pins two behaviors:
//
//   1. Per-kind property-type applicability — Date / Interval
//      require a date-typed property; Phone requires a text-shaped
//      property. When the resolved property's data type doesn't
//      satisfy the kind, the editor surfaces an inline error AND
//      propagates `valid: false` to the parent's `onValidityChange`
//      callback. Calculated columns have no `field`, so the
//      applicability check is skipped — calc always reports valid
//      regardless of the surrounding case-type's properties.
//
//   2. Round-trip preservation — every card's mutation paths
//      route through the per-kind builders; constructed columns
//      always parse through `columnSchema`. Persisted columns
//      with non-default values (custom date pattern, populated
//      mapping table, non-default threshold + unit) round-trip
//      through the editor untouched.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseType,
	calculatedColumn,
	columnSchema,
	dateColumn,
	idMappingColumn,
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

const TEST_UUID = asUuid("00000000-0000-0000-0000-000000000001");

describe("ColumnEditor — applicability errors", () => {
	it("reports invalid + surfaces inline error for Interval (flag) on a text property", async () => {
		const onValidityChange = vi.fn();
		const value = intervalColumn(
			TEST_UUID,
			"name",
			"Header",
			7,
			"days",
			"flag",
			"Overdue",
		);
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
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
		const value = dateColumn(TEST_UUID, "name", "Header", "%Y-%m-%d");
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
		expect(container.textContent).toMatch(/date-typed property/i);
	});

	it("reports invalid + surfaces inline error for Phone on a date property", async () => {
		const onValidityChange = vi.fn();
		const value = phoneColumn(TEST_UUID, "dob", "Phone");
		const { container } = render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
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
		const value = phoneColumn(TEST_UUID, "phone", "Contact");
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});

	it("reports invalid + surfaces inline error for Interval (always) on a non-date property", async () => {
		const onValidityChange = vi.fn();
		const value = intervalColumn(
			TEST_UUID,
			"name",
			"Header",
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
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
		expect(container.textContent).toMatch(/date-typed property/i);
	});

	it("reports valid for Interval (flag) on a date property", async () => {
		const onValidityChange = vi.fn();
		const value = intervalColumn(
			TEST_UUID,
			"dob",
			"Header",
			7,
			"days",
			"flag",
			"Overdue",
		);
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});

	it("reports valid for Plain on any property", async () => {
		const onValidityChange = vi.fn();
		const value = plainColumn(TEST_UUID, "status", "Header");
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});

	it("reports valid for Calculated regardless of case-type properties", async () => {
		// Calculated columns have no `field`; the per-kind applicability
		// check is skipped. The editor reports valid even on a
		// case-type with properties that wouldn't fit a non-calc kind.
		const onValidityChange = vi.fn();
		const value = calculatedColumn(TEST_UUID, "Computed", term(literal("hi")));
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
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
		const value = intervalColumn(
			TEST_UUID,
			"",
			"Header",
			7,
			"days",
			"flag",
			"Overdue",
		);
		render(
			<ColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
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
		const value = dateColumn(TEST_UUID, "dob", "Birthday", "%d-%b-%Y");
		const onChange = vi.fn();
		const { rerender } = render(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
			/>,
		);
		expect(onChange).not.toHaveBeenCalled();
		rerender(
			<ColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
			/>,
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(() => columnSchema.parse(value)).not.toThrow();
	});

	it("preserves an authored id-mapping table across mount", () => {
		const value = idMappingColumn(TEST_UUID, "status", "Status", [
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
				sortedColumnCount={0}
				sortPriorityPosition={undefined}
			/>,
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(() => columnSchema.parse(value)).not.toThrow();
	});

	it("preserves interval threshold + unit + display + text", () => {
		const value = intervalColumn(
			TEST_UUID,
			"dob",
			"Age (months)",
			6,
			"months",
			"always",
			"Old",
		);
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
		expect(onChange).not.toHaveBeenCalled();
		expect(() => columnSchema.parse(value)).not.toThrow();
	});

	it("preserves a calculated column's expression across mount", () => {
		const value = calculatedColumn(TEST_UUID, "Header", term(literal("hi")));
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
		expect(onChange).not.toHaveBeenCalled();
		expect(() => columnSchema.parse(value)).not.toThrow();
	});
});
