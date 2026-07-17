// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import { PredicateEditProvider } from "../editorContext";
import { PropertyPicker } from "../primitives/PropertyPicker";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "patient_dob", label: "Date of birth", data_type: "date" },
		{ name: "home_phone", label: "Telephone", data_type: "text" },
		{ name: "enrollment_status", label: "Status", data_type: "text" },
	],
};

function renderPicker(
	props: Partial<React.ComponentProps<typeof PropertyPicker>> = {},
) {
	return render(
		<PredicateEditProvider
			caseTypes={[PATIENT]}
			currentCaseType="patient"
			knownInputs={[]}
			validityIndex={new Map()}
		>
			<PropertyPicker
				value="enrollment_status"
				onChange={() => {}}
				displayLabels
				ariaLabel="Information from"
				{...props}
			/>
		</PredicateEditProvider>,
	);
}

describe("PropertyPicker search", () => {
	it("focuses an accessible search and matches friendly labels or stored names", async () => {
		renderPicker();

		fireEvent.click(
			screen.getByRole("button", { name: "Information from: Status" }),
		);
		const search = await screen.findByRole("searchbox", {
			name: "Search information",
		});
		await waitFor(() => expect(document.activeElement).toBe(search));

		fireEvent.change(search, { target: { value: "birth" } });
		expect(
			screen.getByRole("menuitem", { name: /^Date of birth\s+Date$/ }),
		).toBeDefined();
		expect(
			screen.queryByRole("menuitem", { name: /^Telephone\s+Text$/ }),
		).toBeNull();

		fireEvent.change(search, { target: { value: "home_phone" } });
		expect(
			screen.getByRole("menuitem", { name: /^Telephone\s+Text$/ }),
		).toBeDefined();
		expect(
			screen.queryByRole("menuitem", { name: /^Date of birth\s+Date$/ }),
		).toBeNull();
	});

	it("keeps the optional create action reachable when no choice matches", async () => {
		const onCreateNew = vi.fn();
		renderPicker({
			onCreateNew,
			createNewLabel: "Create a new question",
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Information from: Status" }),
		);
		const search = await screen.findByRole("searchbox", {
			name: "Search information",
		});
		fireEvent.change(search, { target: { value: "nothing-like-this" } });

		expect(
			screen.getByText("No information matches “nothing-like-this”."),
		).toBeDefined();
		const createAction = screen.getByRole("menuitem", {
			name: "Create a new question",
		});
		expect(createAction.closest(".overflow-y-auto")).toBeNull();

		fireEvent.click(createAction);
		await waitFor(() => expect(onCreateNew).toHaveBeenCalledTimes(1));
	});
});
