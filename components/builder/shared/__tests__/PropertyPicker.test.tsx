// @vitest-environment happy-dom

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import { PredicateEditProvider } from "../editorContext";
import { PropertyPicker } from "../primitives/PropertyPicker";

const LONG_PROPERTY_LABEL =
	"Preferred follow up location from the most recent household assessment";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "patient_dob", label: "Date of birth", data_type: "date" },
		{ name: "home_phone", label: "Telephone", data_type: "text" },
		{ name: "enrollment_status", label: "Status", data_type: "text" },
		{
			name: "preferred_follow_up_location",
			label: LONG_PROPERTY_LABEL,
			data_type: "text",
		},
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
				ariaLabel="Information from"
				{...props}
			/>
		</PredicateEditProvider>,
	);
}

describe("PropertyPicker search", () => {
	it("uses Case information as its default accessible label", () => {
		renderPicker({ ariaLabel: undefined });
		expect(
			screen.getByRole("button", { name: "Case information: Status" }),
		).toBeDefined();
	});

	it("uses body-sized controls with readable metadata and empty states", async () => {
		renderPicker();

		const trigger = screen.getByRole("button", {
			name: "Information from: Status",
		});
		expect(trigger.className).toContain("text-[14px]");
		expect(trigger.className).toContain("h-auto");
		expect(trigger.textContent).not.toContain("enrollment_status");
		fireEvent.click(trigger);

		const search = await screen.findByRole("searchbox", {
			name: "Search information",
		});
		const positioner = document.querySelector(
			'[data-slot="dropdown-menu-positioner"]',
		);
		expect(positioner?.getAttribute("style")).toContain("--available-width");
		expect(search.className).toContain("text-[14px]");
		const dateChoice = screen.getByRole("menuitem", {
			name: /^Date of birth\s+Date$/,
		});
		expect(within(dateChoice).getByText("Date").className).toContain(
			"text-[12px]",
		);

		fireEvent.change(search, { target: { value: "nothing-like-this" } });
		const empty = screen.getByRole("status");
		expect(
			within(empty).getByText("No matching information").className,
		).toContain("font-medium");
		expect(within(empty).getByText("Try a different search")).toBeDefined();
		expect(empty.textContent).not.toContain("nothing-like-this");
	});

	it("describes unavailable saved information without exposing data-model terms", () => {
		renderPicker({ value: "removed_field" });

		expect(
			screen.getByRole("button", {
				name: /Information from: Unavailable information/i,
			}),
		).toBeDefined();
		expect(
			screen.getByLabelText("This information is no longer available"),
		).toBeDefined();
		expect(screen.queryByText("removed_field")).toBeNull();
	});

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

		const empty = screen.getByRole("status");
		expect(within(empty).getByText("No matching information")).toBeDefined();
		expect(within(empty).getByText("Try a different search")).toBeDefined();
		expect(empty.textContent).not.toContain("nothing-like-this");
		const createAction = screen.getByRole("menuitem", {
			name: "Create a new question",
		});
		expect(createAction.closest(".overflow-y-auto")).toBeNull();

		fireEvent.click(createAction);
		await waitFor(() => expect(onCreateNew).toHaveBeenCalledTimes(1));
	});

	it("wraps complete authored labels in the trigger and choice list", async () => {
		renderPicker({ value: "preferred_follow_up_location" });

		const trigger = screen.getByRole("button", {
			name: `Information from: ${LONG_PROPERTY_LABEL}`,
		});
		const selectedLabel = within(trigger).getByText(LONG_PROPERTY_LABEL);
		expect(trigger.className).toContain("whitespace-normal");
		expect(selectedLabel.className).toContain("break-words");
		expect(selectedLabel.className).not.toContain("truncate");

		fireEvent.click(trigger);
		const choice = await screen.findByRole("menuitem", {
			name: new RegExp(LONG_PROPERTY_LABEL, "i"),
		});
		const choiceLabel = within(choice).getByText(LONG_PROPERTY_LABEL);
		expect(choice.className).toContain("whitespace-normal");
		expect(choiceLabel.className).toContain("break-words");
		expect(choiceLabel.className).not.toContain("truncate");
	});
});
