// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asUuid,
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
				brokenColumns={new Set()}
				selection={null}
				onSelect={() => {}}
				onAddDetailField={() => {}}
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

	it("names the two Results behavior actions by what they change", () => {
		const sortedName = {
			...NAME,
			sort: { direction: "asc" as const, priority: 0 },
		};
		render(
			<CaseListCanvas
				config={{ columns: [sortedName], searchInputs: [] }}
				caseType={undefined}
				brokenColumns={new Set()}
				filterBroken={false}
				selection={null}
				onSelect={() => {}}
				onAddColumn={() => {}}
				addColumnDisabledReason={undefined}
				onMoveColumn={() => {}}
				onColumnsChange={() => {}}
				onShowColumn={() => {}}
				onRepairColumn={() => {}}
				onOpenOptions={() => {}}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Change cases included" }),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Change default order" }),
		).toBeDefined();
		expect(screen.getAllByText("Change")).toHaveLength(2);
	});

	it("offers removed information only after the author asks to add", () => {
		const hidden = column("3", "date_of_birth", "");
		const onShow = vi.fn();
		render(
			<AddInformationControl
				surface="list"
				columns={[hidden]}
				brokenColumns={new Set()}
				onShow={onShow}
				onRepair={() => {}}
				onCreate={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		expect(screen.queryByText("Date of birth")).toBeNull();
		const addInformation = screen.getByRole("button", {
			name: "Add information",
		});
		expect(addInformation.getAttribute("data-case-add")).toBe("list");
		fireEvent.click(addInformation);
		fireEvent.click(screen.getByRole("menuitem", { name: "Date of birth" }));
		expect(onShow).toHaveBeenCalledWith(hidden);
		expect(screen.queryByText("date_of_birth")).toBeNull();
	});

	it("routes saved information that needs a fix to repair instead of revealing it", () => {
		const hidden = column("33", "date_of_birth", "Date of birth");
		const onShow = vi.fn();
		const onRepair = vi.fn();
		render(
			<AddInformationControl
				surface="list"
				columns={[hidden]}
				brokenColumns={new Set([hidden.uuid])}
				onShow={onShow}
				onRepair={onRepair}
				onCreate={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add information" }));
		fireEvent.click(
			screen.getByRole("menuitem", {
				name: /date of birth.*fix before adding/i,
			}),
		);

		expect(onRepair).toHaveBeenCalledWith(hidden);
		expect(onShow).not.toHaveBeenCalled();
	});

	it("keeps a large recovery inventory searchable with creation outside its scroll region", async () => {
		const hiddenColumns = Array.from({ length: 24 }, (_, index) =>
			column(String(index + 100), `field_${index + 1}`, `Field ${index + 1}`),
		);
		render(
			<AddInformationControl
				surface="list"
				columns={hiddenColumns}
				brokenColumns={new Set()}
				onShow={() => {}}
				onRepair={() => {}}
				onCreate={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		const addInformation = screen.getByRole("button", {
			name: "Add information",
		});
		fireEvent.click(addInformation);
		expect(await screen.findAllByRole("menuitem")).toHaveLength(25);

		const scrollRegion = document.querySelector(
			"[data-add-information-scroll-region]",
		);
		const footer = document.querySelector("[data-add-information-footer]");
		const createItem = screen.getByRole("menuitem", {
			name: "Create new information",
		});
		expect(scrollRegion).not.toBeNull();
		expect(footer).not.toBeNull();
		expect(scrollRegion?.contains(createItem)).toBe(false);
		expect(footer?.contains(createItem)).toBe(true);

		fireEvent.change(
			screen.getByRole("searchbox", { name: "Find information" }),
			{
				target: { value: "Field 23" },
			},
		);
		expect(screen.getByRole("menuitem", { name: "Field 23" })).toBeDefined();
		expect(screen.queryByRole("menuitem", { name: "Field 2" })).toBeNull();

		// Close the floating inventory and let Base UI restore focus before
		// the async-resource detector tears down the test.
		fireEvent.click(addInformation);
		await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
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
		expect(screen.getByText(/cases included rule narrows/i)).toBeDefined();
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

	it("keeps a filter problem findable when no result fields are shown", () => {
		const onSelect = vi.fn();
		render(
			<CaseListCanvas
				config={{ columns: [], searchInputs: [] }}
				caseType={undefined}
				brokenColumns={new Set()}
				filterBroken
				selection={null}
				onSelect={onSelect}
				onAddColumn={() => {}}
				addColumnDisabledReason={undefined}
				onMoveColumn={() => {}}
				onColumnsChange={() => {}}
				onShowColumn={() => {}}
				onRepairColumn={() => {}}
				onOpenOptions={() => {}}
			/>,
		);

		expect(screen.getByText("Needs attention")).toBeDefined();
		expect(screen.getByText("This rule needs a quick fix.")).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Fix cases included" }),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Fix cases included" }));
		expect(onSelect).toHaveBeenCalledWith({ type: "filter" });
		expect(screen.getByRole("heading", { name: "Results" })).toBeDefined();
		expect(screen.queryByText(/arrange fields/i)).toBeNull();
		expect(screen.queryByText(/example result|example value/i)).toBeNull();
	});
});
