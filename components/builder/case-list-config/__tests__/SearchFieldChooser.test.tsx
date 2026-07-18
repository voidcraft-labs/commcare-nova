// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseProperty } from "@/lib/domain";
import { AddSearchFieldControl } from "../canvas/SearchCanvas";
import { seedSearchInputForProperty } from "../seeds";

const CASE_NAME: CaseProperty = {
	name: "case_name",
	label: "case_name",
	data_type: "text",
};
const LEGACY_NAME: CaseProperty = {
	name: "name",
	label: "name",
	data_type: "text",
};
const EXTERNAL_ID: CaseProperty = {
	name: "external_id",
	label: "external_id",
	data_type: "text",
};
const LEGACY_EXTERNAL_ID: CaseProperty = {
	name: "external-id",
	label: "external-id",
	data_type: "text",
};
const DATE_OF_BIRTH: CaseProperty = {
	name: "date_of_birth",
	label: "Date of birth",
	data_type: "date",
};
const COMMUNITY: CaseProperty = {
	name: "community",
	label: "Community",
	data_type: "text",
};

function propertyOptions(): HTMLElement[] {
	return screen.queryAllByRole("option");
}

async function closeChooser(): Promise<void> {
	fireEvent.click(screen.getByRole("combobox", { name: "Add search field" }));
	await waitFor(() => {
		expect(document.querySelector('[data-slot="combobox-content"]')).toBeNull();
	});
}

async function openChooser(): Promise<HTMLInputElement> {
	fireEvent.click(screen.getByRole("combobox", { name: "Add search field" }));
	return screen.findByRole("combobox", {
		name: "Search case information",
	}) as Promise<HTMLInputElement>;
}

describe("AddSearchFieldControl", () => {
	it("asks which information to search, collapses aliases, and puts case name first", async () => {
		const onChoose = vi.fn();
		render(
			<AddSearchFieldControl
				properties={[
					LEGACY_EXTERNAL_ID,
					COMMUNITY,
					LEGACY_NAME,
					EXTERNAL_ID,
					CASE_NAME,
				]}
				onChoose={onChoose}
				disabledReason={undefined}
			/>,
		);

		await openChooser();

		expect(
			screen.getByText("Choose the case information people can search"),
		).toBeDefined();
		expect(propertyOptions().map((option) => option.textContent)).toEqual([
			expect.stringContaining("Case name"),
			expect.stringContaining("Community"),
			expect.stringContaining("External ID"),
		]);
		const visibleCopy = document.querySelector(
			'[data-slot="combobox-content"]',
		)?.textContent;
		expect(visibleCopy).toContain("Case name");
		expect(visibleCopy).toContain("External ID");
		expect(visibleCopy).not.toContain("case_name");
		expect(visibleCopy).not.toContain("external-id");
		expect(onChoose).not.toHaveBeenCalled();
		await closeChooser();
	});

	it("filters while typing, explains no matches, and restores the search", async () => {
		render(
			<AddSearchFieldControl
				properties={[CASE_NAME, DATE_OF_BIRTH, COMMUNITY]}
				onChoose={() => {}}
				disabledReason={undefined}
			/>,
		);
		const search = await openChooser();

		fireEvent.change(search, { target: { value: "date" } });
		expect((search as HTMLInputElement).value).toBe("date");
		expect(propertyOptions()).toHaveLength(1);
		expect(propertyOptions()[0]?.textContent).toContain("Date of birth");

		fireEvent.change(search, { target: { value: "nothing here" } });
		expect(screen.getByRole("status").textContent).toContain(
			"No matching information",
		);
		expect(screen.getByText("Try a different search")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
		expect((search as HTMLInputElement).value).toBe("");
		expect(document.activeElement).toBe(search);
		expect(propertyOptions()).toHaveLength(3);
		await closeChooser();
	});

	it("commits only the property the author chooses", async () => {
		const onChoose = vi.fn();
		render(
			<AddSearchFieldControl
				properties={[CASE_NAME, DATE_OF_BIRTH]}
				onChoose={onChoose}
				disabledReason={undefined}
			/>,
		);
		await openChooser();
		fireEvent.click(
			screen.getByRole("option", { name: /date of birth.*date/i }),
		);

		expect(onChoose).toHaveBeenCalledOnce();
		expect(onChoose).toHaveBeenCalledWith(DATE_OF_BIRTH);
		await waitFor(() => {
			expect(
				document.querySelector('[data-slot="combobox-content"]'),
			).toBeNull();
		});
	});

	it("shows duplicate labels with friendly disambiguation only when needed", async () => {
		render(
			<AddSearchFieldControl
				properties={[
					{
						name: "intake_status",
						label: "Program status",
						data_type: "text",
					},
					{
						name: "followup_status",
						label: "Program status",
						data_type: "text",
					},
				]}
				onChoose={() => {}}
				disabledReason={undefined}
			/>,
		);
		await openChooser();

		expect(
			screen.getByRole("option", {
				name: /program status.*intake status/i,
			}),
		).toBeDefined();
		expect(
			screen.getByRole("option", {
				name: /program status.*followup status/i,
			}),
		).toBeDefined();
		await closeChooser();
	});

	it("uses the structural disabled reason and explains a propertyless case type", () => {
		const { rerender } = render(
			<AddSearchFieldControl
				properties={[CASE_NAME]}
				onChoose={() => {}}
				disabledReason="Search already has the maximum number of fields"
			/>,
		);
		let trigger = screen.getByRole("button", { name: "Add search field" });
		expect(trigger.hasAttribute("disabled")).toBe(true);
		expect(
			screen.getByText("Search already has the maximum number of fields"),
		).toBeDefined();

		rerender(
			<AddSearchFieldControl
				properties={[]}
				onChoose={() => {}}
				disabledReason={undefined}
			/>,
		);
		trigger = screen.getByRole("button", { name: "Add search field" });
		expect(trigger.hasAttribute("disabled")).toBe(true);
		expect(
			screen.getByText("Add case information before adding fields"),
		).toBeDefined();
	});
});

describe("seedSearchInputForProperty", () => {
	it("keeps established widget and match defaults after explicit selection", () => {
		const text = seedSearchInputForProperty(
			{ columns: [], searchInputs: [] },
			COMMUNITY,
		);
		expect(text).toMatchObject({
			kind: "simple",
			property: "community",
			label: "Community",
			type: "text",
			mode: { kind: "fuzzy" },
		});

		const date = seedSearchInputForProperty(
			{ columns: [], searchInputs: [] },
			DATE_OF_BIRTH,
		);
		expect(date).toMatchObject({
			kind: "simple",
			property: "date_of_birth",
			label: "Date of birth",
			type: "date",
		});
		if (date.kind !== "simple")
			throw new Error("Expected a simple search field");
		expect(date.mode).toBeUndefined();
	});

	it("canonicalizes legacy choices and keeps repeated internal names unique", () => {
		const first = seedSearchInputForProperty(
			{ columns: [], searchInputs: [] },
			LEGACY_NAME,
		);
		const second = seedSearchInputForProperty(
			{ columns: [], searchInputs: [first] },
			LEGACY_NAME,
		);

		expect(first).toMatchObject({
			property: "case_name",
			name: "case_name",
			label: "Case name",
		});
		expect(second).toMatchObject({
			property: "case_name",
			name: "case_name_2",
			label: "Case name",
		});
	});
});
