// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asUuid,
	type CaseProperty,
	type CaseType,
	type Column,
	simpleSearchInputDef,
} from "@/lib/domain";
import { ancestorPath, relationStep } from "@/lib/domain/predicate";
import { CaseListCanvas } from "../canvas/CaseListCanvas";
import { DetailCanvas } from "../canvas/DetailCanvas";
import {
	AddInformationControl,
	DisplayFieldComposer,
} from "../canvas/DisplayFieldComposer";
import { SearchCanvas } from "../canvas/SearchCanvas";
import { SearchInputEditor } from "../inspector/SearchInputEditor";
import { SearchPanelInspectorBody } from "../inspector/SearchPanelInspectorBody";

const session = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => session.canEdit,
}));

function column(uuidSuffix: string, field: string, header: string): Column {
	return {
		uuid: asUuid(`00000000-0000-4000-8000-${uuidSuffix.padStart(12, "0")}`),
		kind: "plain",
		field,
		header,
	};
}

const NAME = column("1", "case_name", "Patient name");
const DOB = column("2", "date_of_birth", "Date of birth");
const DOB_PROPERTY: CaseProperty = {
	name: "date_of_birth",
	label: "Date of birth",
	data_type: "date",
};
const AGE_PROPERTY: CaseProperty = {
	name: "age",
	label: "Age",
	data_type: "int",
};

describe("case workspace chrome", () => {
	beforeEach(() => {
		session.canEdit = true;
	});

	it("reorders the visible result directly from its handle", () => {
		const onMove = vi.fn();
		render(
			<DisplayFieldComposer
				columns={[NAME, DOB]}
				surface="list"
				selectedUuid={null}
				brokenColumns={new Set()}
				onSelect={() => {}}
				onMove={onMove}
			/>,
		);

		fireEvent.keyDown(
			screen.getByRole("button", { name: /move patient name in results/i }),
			{ key: "ArrowDown" },
		);

		expect(onMove).toHaveBeenCalledWith(NAME.uuid, 1);
		expect(screen.getByRole("status").textContent).toContain(
			"Patient name moved later in results",
		);
		expect(screen.queryByText(/^1$/)).toBeNull();
	});

	it("keeps membership actions out of the result row", () => {
		const onSelect = vi.fn();
		render(
			<DisplayFieldComposer
				columns={[NAME]}
				surface="list"
				selectedUuid={null}
				brokenColumns={new Set()}
				onSelect={onSelect}
				onMove={() => {}}
			/>,
		);

		expect(screen.queryByRole("button", { name: /more options/i })).toBeNull();
		expect(screen.queryByText(/example value/i)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Patient name" }));
		expect(onSelect).toHaveBeenCalledWith(NAME);
	});

	it("keeps Details focused on composition instead of an arbitrary case", () => {
		render(
			<DetailCanvas
				config={{ columns: [NAME], searchInputs: [] }}
				caseType={undefined}
				brokenColumns={new Set()}
				selection={null}
				onSelect={() => {}}
				onAddDetailField={() => {}}
				onAddCalculated={() => {}}
				addDisabledReason={undefined}
				onMoveColumn={() => {}}
				onShowColumn={() => {}}
				onRepairColumn={() => {}}
			/>,
		);

		expect(screen.getByRole("heading", { name: "Details" })).toBeDefined();
		expect(
			screen.getByRole("heading", { name: "Information shown" }),
		).toBeDefined();
		expect(screen.getByRole("button", { name: "Patient name" })).toBeDefined();
		expect(screen.queryByText(/example case|example value/i)).toBeNull();
	});

	it("keeps Results focused on presentation and default order", () => {
		const sortedName = {
			...NAME,
			sort: { direction: "asc" as const, priority: 0 },
		};
		render(
			<CaseListCanvas
				config={{ columns: [sortedName], searchInputs: [] }}
				caseType={undefined}
				brokenColumns={new Set()}
				selection={null}
				onSelect={() => {}}
				onAddColumn={() => {}}
				onAddCalculated={() => {}}
				addColumnDisabledReason={undefined}
				onMoveColumn={() => {}}
				onColumnsChange={() => {}}
				onShowColumn={() => {}}
				onRepairColumn={() => {}}
				onOpenOptions={() => {}}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Change default order" }),
		).toBeDefined();
		expect(screen.getByText("Which cases appear first")).toBeDefined();
		expect(screen.queryByText("Cases available")).toBeNull();
	});

	it("always asks which information to add instead of choosing a property", () => {
		const onCreate = vi.fn();
		render(
			<AddInformationControl
				surface="detail"
				columns={[]}
				properties={[DOB_PROPERTY]}
				repeatableProperties={[]}
				brokenColumns={new Set()}
				onShow={() => {}}
				onRepair={() => {}}
				onCreate={onCreate}
				onCreateCalculated={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		expect(onCreate).not.toHaveBeenCalled();
		const addInformation = screen.getByRole("button", {
			name: "Add information",
		});
		expect(addInformation.getAttribute("data-case-add")).toBe("detail");
		fireEvent.click(addInformation);
		expect(onCreate).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: /date of birth.*date/i }),
		);
		expect(onCreate).toHaveBeenCalledWith(DOB_PROPERTY);
		expect(screen.queryByText("date_of_birth")).toBeNull();
	});

	it("clears a filtered primary choice before reopening Add information", () => {
		const onCreate = vi.fn();
		const { rerender } = render(
			<AddInformationControl
				surface="detail"
				columns={[]}
				properties={[DOB_PROPERTY, AGE_PROPERTY]}
				repeatableProperties={[]}
				brokenColumns={new Set()}
				onShow={() => {}}
				onRepair={() => {}}
				onCreate={onCreate}
				onCreateCalculated={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add information" }));
		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search case information" }),
			{ target: { value: "date" } },
		);
		fireEvent.click(
			screen.getByRole("button", { name: /date of birth.*date/i }),
		);
		expect(onCreate).toHaveBeenCalledWith(DOB_PROPERTY);

		rerender(
			<AddInformationControl
				surface="detail"
				columns={[]}
				properties={[AGE_PROPERTY]}
				repeatableProperties={[DOB_PROPERTY]}
				brokenColumns={new Set()}
				onShow={() => {}}
				onRepair={() => {}}
				onCreate={onCreate}
				onCreateCalculated={() => {}}
				createDisabledReason={undefined}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add information" }));

		expect(
			(
				screen.getByRole("searchbox", {
					name: "Search case information",
				}) as HTMLInputElement
			).value,
		).toBe("");
		expect(screen.getByRole("button", { name: /^age\b/i })).toBeDefined();
	});

	it("keeps a Details-only repair quiet on Results until Add information opens", () => {
		const hidden = {
			...column("33", "date_of_birth", "Date of birth"),
			visibleInList: false,
			visibleInDetail: true,
		};
		const onShow = vi.fn();
		const onRepair = vi.fn();
		render(
			<AddInformationControl
				surface="list"
				columns={[hidden]}
				properties={[]}
				repeatableProperties={[]}
				brokenColumns={new Set([hidden.uuid])}
				onShow={onShow}
				onRepair={onRepair}
				onCreate={() => {}}
				onCreateCalculated={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		const addInformation = screen.getByRole("button", {
			name: "Add information",
		});
		expect(screen.queryByText("Needs a quick fix")).toBeNull();

		fireEvent.click(addInformation);
		fireEvent.click(
			screen.getByRole("button", {
				name: /date of birth.*needs a quick fix/i,
			}),
		);

		expect(onRepair).toHaveBeenCalledWith(hidden);
		expect(onShow).not.toHaveBeenCalled();
	});

	it("keeps a large saved inventory searchable without giving hidden fields their own section", async () => {
		const hiddenColumns = Array.from({ length: 24 }, (_, index) =>
			column(String(index + 100), `field_${index + 1}`, `Field ${index + 1}`),
		);
		const onShow = vi.fn();
		render(
			<AddInformationControl
				surface="list"
				columns={hiddenColumns}
				properties={[]}
				repeatableProperties={[]}
				brokenColumns={new Set()}
				onShow={onShow}
				onRepair={() => {}}
				onCreate={() => {}}
				onCreateCalculated={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		const addInformation = screen.getByRole("button", {
			name: "Add information",
		});
		fireEvent.click(addInformation);
		expect(await screen.findByText("Common information")).toBeDefined();
		expect(screen.queryByText("Ready to add")).toBeNull();

		const scrollRegion = document.querySelector(
			"[data-add-information-scroll-region]",
		);
		expect(scrollRegion).not.toBeNull();
		expect(scrollRegion?.querySelectorAll("button")).toHaveLength(25);
		expect(screen.queryByText("Create new information")).toBeNull();

		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search case information" }),
			{
				target: { value: "Field 23" },
			},
		);
		const field23 = screen.getByRole("button", {
			name: /field 23.*keeps its current format/i,
		});
		expect(field23).toBeDefined();
		expect(
			screen.queryByRole("button", {
				name: /^field 2 .*keeps its current format$/i,
			}),
		).toBeNull();
		fireEvent.click(field23);
		expect(onShow).toHaveBeenCalledWith(hiddenColumns[22]);

		await waitFor(() =>
			expect(screen.queryByText("Common information")).toBeNull(),
		);
	});

	it("keeps calculated values available as a quiet secondary choice", () => {
		const onCreateCalculated = vi.fn();
		render(
			<AddInformationControl
				surface="detail"
				columns={[]}
				properties={[DOB_PROPERTY]}
				repeatableProperties={[]}
				brokenColumns={new Set()}
				onShow={() => {}}
				onRepair={() => {}}
				onCreate={() => {}}
				onCreateCalculated={onCreateCalculated}
				createDisabledReason={undefined}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add information" }));
		fireEvent.click(
			screen.getByRole("button", {
				name: /calculated value.*combine or transform/i,
			}),
		);
		expect(onCreateCalculated).toHaveBeenCalledTimes(1);
	});

	it("turns an empty information search into a clear recovery path", () => {
		render(
			<AddInformationControl
				surface="detail"
				columns={[]}
				properties={[DOB_PROPERTY]}
				repeatableProperties={[]}
				brokenColumns={new Set()}
				onShow={() => {}}
				onRepair={() => {}}
				onCreate={() => {}}
				onCreateCalculated={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add information" }));
		const search = screen.getByRole("searchbox", {
			name: "Search case information",
		});
		fireEvent.change(search, { target: { value: "nothing matches" } });

		expect(screen.getByRole("status").textContent).toBe(
			"No matching information",
		);
		expect(
			screen.getByText("Try another word, or browse everything again."),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

		expect((search as HTMLInputElement).value).toBe("");
		expect(document.activeElement).toBe(search);
		expect(
			screen.getByRole("button", { name: /date of birth.*date/i }),
		).toBeDefined();
	});

	it("offers a deliberate second-view path without duplicating represented fields in the primary list", () => {
		const onCreate = vi.fn();
		render(
			<AddInformationControl
				surface="detail"
				columns={[]}
				properties={[]}
				repeatableProperties={[DOB_PROPERTY]}
				brokenColumns={new Set()}
				onShow={() => {}}
				onRepair={() => {}}
				onCreate={onCreate}
				onCreateCalculated={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add information" }));
		expect(screen.queryByRole("button", { name: /date of birth/i })).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: /show information another way.*second view/i,
			}),
		);
		expect(
			screen.getByRole("heading", { name: "Show information another way" }),
		).toBeDefined();
		fireEvent.click(
			screen.getByRole("button", {
				name: /date of birth.*second label or format/i,
			}),
		);
		expect(onCreate).toHaveBeenCalledWith(DOB_PROPERTY);
	});

	it("returns from the alternate path to the primary picker when reopened", async () => {
		const onCreate = vi.fn();
		render(
			<AddInformationControl
				surface="detail"
				columns={[]}
				properties={[AGE_PROPERTY]}
				repeatableProperties={[DOB_PROPERTY]}
				brokenColumns={new Set()}
				onShow={() => {}}
				onRepair={() => {}}
				onCreate={onCreate}
				onCreateCalculated={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add information" }));
		fireEvent.click(
			screen.getByRole("button", {
				name: /show information another way.*second view/i,
			}),
		);
		fireEvent.change(
			screen.getByRole("searchbox", {
				name: "Search information already shown",
			}),
			{ target: { value: "date" } },
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: /date of birth.*second label or format/i,
			}),
		);
		expect(onCreate).toHaveBeenCalledWith(DOB_PROPERTY);

		const addInformation = screen.getByRole("button", {
			name: "Add information",
		});
		fireEvent.click(addInformation);
		expect(
			await screen.findByRole("heading", { name: "Add information" }),
		).toBeDefined();
		expect(
			(
				screen.getByRole("searchbox", {
					name: "Search case information",
				}) as HTMLInputElement
			).value,
		).toBe("");

		// `findByRole` lets Base UI's initial-focus microtask settle. Close through
		// the trigger, then observe dismissal so its focus-restore task also drains
		// before the leak detector tears the test down.
		fireEvent.click(addInformation);
		await waitFor(() => {
			expect(
				screen.queryByRole("heading", { name: "Add information" }),
			).toBeNull();
		});
	});

	it("opens Search screen settings without depicting a submit button", () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000004"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const onSelect = vi.fn();

		render(
			<SearchCanvas
				searchInputs={[input]}
				searchConfig={{
					searchScreenTitle: "Find a patient",
					searchButtonLabel: "Find matching cases",
				}}
				caseTypes={[
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: "Patient", data_type: "text" },
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				filter={undefined}
				filterBroken={false}
				selection={null}
				onSelect={onSelect}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Find a patient" }),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: "Find matching cases" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /more options/i })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Screen settings" }));
		expect(onSelect).toHaveBeenCalledWith({ type: "search-panel" });
	});

	it("moves a search field with one identity-keyed gesture", () => {
		const first = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000041"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const second = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000042"),
			"external_id",
			"External ID",
			"text",
			"external_id",
		);
		const onMoveInput = vi.fn();

		render(
			<SearchCanvas
				searchInputs={[first, second]}
				searchConfig={undefined}
				caseTypes={[]}
				currentCaseType="patient"
				filter={undefined}
				filterBroken={false}
				selection={null}
				onSelect={() => {}}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={onMoveInput}
			/>,
		);

		fireEvent.keyDown(
			screen.getByRole("button", { name: /move patient name in search/i }),
			{ key: "ArrowDown" },
		);

		expect(onMoveInput).toHaveBeenCalledWith(first.uuid, 1);
		expect(screen.getByRole("status").textContent).toContain(
			"Patient name moved later in search",
		);
	});

	it("canonicalizes a legacy alias when a custom binding returns to this case", () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000044"),
			"name",
			"Name",
			"text",
			"name",
			{
				via: ancestorPath(relationStep("parent"), relationStep("parent")),
			},
		);
		const onChange = vi.fn();
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[
					{
						name: "patient",
						properties: [
							{ name: "name", label: "Patient name", data_type: "text" },
							{ name: "case_name", label: "Case name", data_type: "text" },
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Search this case instead" }),
		);
		expect(onChange).toHaveBeenCalled();
		const next = onChange.mock.calls[0]?.[0];
		expect(next).toMatchObject({
			property: "case_name",
			name: "case_name",
		});
	});

	it("guides a fresh Search screen to add a field before exposing settings", () => {
		render(
			<SearchCanvas
				searchInputs={[]}
				searchConfig={undefined}
				caseTypes={[]}
				currentCaseType="patient"
				filter={undefined}
				filterBroken={false}
				selection={null}
				onSelect={() => {}}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
				hasSearchSurface={false}
			/>,
		);

		expect(
			screen.getByText(/add a search field when people need to narrow/i),
		).toBeDefined();
		expect(screen.getByText("People go straight to results")).toBeDefined();
		expect(
			screen.queryByRole("button", { name: "Screen settings" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Add search field" }),
		).toBeDefined();
	});

	it("hides search editing affordances in view-only mode", () => {
		session.canEdit = false;
		render(
			<SearchCanvas
				searchInputs={[]}
				searchConfig={undefined}
				caseTypes={[]}
				currentCaseType="patient"
				filter={undefined}
				filterBroken={false}
				selection={null}
				onSelect={() => {}}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
				hasSearchSurface={false}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Add search field" }),
		).toBeNull();
	});

	it("does not depict unused search chrome for automatic filtered results", () => {
		const onSelect = vi.fn();
		render(
			<SearchCanvas
				searchInputs={[]}
				searchConfig={{ searchScreenTitle: "Unused title" }}
				caseTypes={[]}
				currentCaseType="patient"
				filter={undefined}
				filterBroken={false}
				selection={null}
				onSelect={onSelect}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
				hasSearchSurface={false}
				hasAutomaticResultsFilter
			/>,
		);

		expect(screen.getByText("People go straight to results")).toBeDefined();
		expect(
			screen.getByText(/go straight to the available results/i),
		).toBeDefined();
		expect(screen.queryByText("Unused title")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Screen settings" }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Search rules" }));
		expect(onSelect).toHaveBeenCalledWith({ type: "search-panel" });
	});

	it("shows only runtime-relevant settings for automatic search", () => {
		render(
			<SearchPanelInspectorBody
				value={{ searchScreenTitle: "Unused title" }}
				onChange={() => {}}
				caseTypes={[]}
				currentCaseType="patient"
				hasVisibleSearchScreen={false}
			/>,
		);

		expect(screen.getByText(/people go straight to results/i)).toBeDefined();
		expect(screen.queryByText("Title")).toBeNull();
		expect(screen.queryByText("Search button label")).toBeNull();
		expect(
			screen
				.getByRole("button", { name: /automatic search rules/i })
				.getAttribute("aria-expanded"),
		).toBe("true");
		expect(screen.getByText("Ownership exclusions")).toBeDefined();
	});

	it("keeps the always-on rule and search fields together on Search", () => {
		const onSelect = vi.fn();
		render(
			<SearchCanvas
				searchInputs={[]}
				searchConfig={undefined}
				caseTypes={[]}
				currentCaseType="patient"
				filter={undefined}
				filterBroken
				selection={null}
				onSelect={onSelect}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
				hasSearchSurface={false}
			/>,
		);

		expect(screen.getByText("Needs attention")).toBeDefined();
		expect(screen.getByText("This rule needs a quick fix.")).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Fix available cases" }),
		).toBeDefined();
		fireEvent.click(
			screen.getByRole("button", { name: "Fix available cases" }),
		);
		expect(onSelect).toHaveBeenCalledWith({ type: "filter" });
		expect(
			screen.getByRole("heading", { name: "Search", level: 1 }),
		).toBeDefined();
		expect(
			screen.getByRole("heading", { name: "Cases available" }),
		).toBeDefined();
		expect(
			screen.getByRole("heading", { name: "Ways to narrow" }),
		).toBeDefined();
		expect(screen.queryByText(/example result|example value/i)).toBeNull();
	});
});
