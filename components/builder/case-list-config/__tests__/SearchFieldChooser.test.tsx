import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { emptyCaseListConfig } from "@/lib/domain";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
// @vitest-environment happy-dom

import {
	fireEvent,
	render as rtlRender,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { CaseProperty } from "@/lib/domain";
import { AddSearchFieldControl } from "../canvas/SearchCanvas";
import { seedSearchInputForProperty } from "../seeds";

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

/** Every fixture property below is labeled with literal prose, so a
 *  context-free projection spells exactly what a document-aware one would. */
const projectProse = proseTemplateText;

const CASE_NAME: CaseProperty = {
	name: "case_name",
	label: proseText("case_name"),
	data_type: "text",
};
const EXTERNAL_ID: CaseProperty = {
	name: "external_id",
	label: proseText("external_id"),
	data_type: "text",
};
const DATE_OF_BIRTH: CaseProperty = {
	name: "date_of_birth",
	label: proseText("Date of birth"),
	data_type: "date",
};
const COMMUNITY: CaseProperty = {
	name: "community",
	label: proseText("Community"),
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
	it("asks which information to search and puts case name first", async () => {
		const onChoose = vi.fn();
		render(
			<AddSearchFieldControl
				properties={[COMMUNITY, EXTERNAL_ID, CASE_NAME]}
				onChoose={onChoose}
				onChooseHidden={() => {}}
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
		expect(onChoose).not.toHaveBeenCalled();
		await closeChooser();
	});

	it("filters while typing, explains no matches, and restores the search", async () => {
		render(
			<AddSearchFieldControl
				properties={[CASE_NAME, DATE_OF_BIRTH, COMMUNITY]}
				onChoose={() => {}}
				onChooseHidden={() => {}}
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
				onChooseHidden={() => {}}
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
						label: proseText("Program status"),
						data_type: "text",
					},
					{
						name: "followup_status",
						label: proseText("Program status"),
						data_type: "text",
					},
				]}
				onChoose={() => {}}
				onChooseHidden={() => {}}
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
				onChooseHidden={() => {}}
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
				onChooseHidden={() => {}}
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
			emptyCaseListConfig(),
			COMMUNITY,
			projectProse,
		);
		expect(text).toMatchObject({
			kind: "simple",
			property: "community",
			label: "Community",
			type: "text",
			mode: { kind: "fuzzy" },
		});

		const date = seedSearchInputForProperty(
			emptyCaseListConfig(),
			DATE_OF_BIRTH,
			projectProse,
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

	it("keeps repeated internal names unique", () => {
		const first = seedSearchInputForProperty(
			emptyCaseListConfig(),
			CASE_NAME,
			projectProse,
		);
		const second = seedSearchInputForProperty(
			resolveCaseListConfig({ columns: [], searchInputs: [first] }),
			CASE_NAME,
			projectProse,
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
