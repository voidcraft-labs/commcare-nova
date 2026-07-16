// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asUuid,
	type CaseType,
	type Column,
	simpleSearchInputDef,
} from "@/lib/domain";
import { ancestorPath, relationStep } from "@/lib/domain/predicate";
import { CaseListCanvas } from "../canvas/CaseListCanvas";
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
				sampleRow={undefined}
				selectedUuid={null}
				brokenColumns={new Set()}
				onSelect={() => {}}
				onMove={onMove}
				onRemove={() => {}}
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

	it("keeps the last result with friendly disabled guidance", () => {
		const onHide = vi.fn();
		render(
			<DisplayFieldComposer
				columns={[NAME]}
				surface="list"
				sampleRow={undefined}
				selectedUuid={null}
				brokenColumns={new Set()}
				onSelect={() => {}}
				onMove={() => {}}
				onRemove={onHide}
			/>,
		);

		expect(screen.queryByText("Hide")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "More options for Patient name" }),
		);
		const keepItem = screen.getByRole("menuitem", {
			name: /keep at least one result add another first/i,
		});
		expect(keepItem.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(keepItem);
		expect(onHide).not.toHaveBeenCalled();
	});

	it("removes a result once another remains", () => {
		const onRemove = vi.fn();
		render(
			<DisplayFieldComposer
				columns={[NAME, DOB]}
				surface="list"
				sampleRow={undefined}
				selectedUuid={null}
				brokenColumns={new Set()}
				onSelect={() => {}}
				onMove={() => {}}
				onRemove={onRemove}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "More options for Patient name" }),
		);
		fireEvent.click(
			screen.getByRole("menuitem", { name: "Remove from results" }),
		);
		expect(onRemove).toHaveBeenCalledWith(NAME);
	});

	it("allows removing the last detail field", () => {
		const onRemove = vi.fn();
		render(
			<DisplayFieldComposer
				columns={[NAME]}
				surface="detail"
				sampleRow={undefined}
				selectedUuid={null}
				brokenColumns={new Set()}
				onSelect={() => {}}
				onMove={() => {}}
				onRemove={onRemove}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "More options for Patient name" }),
		);
		fireEvent.click(
			screen.getByRole("menuitem", { name: "Remove from details" }),
		);
		expect(onRemove).toHaveBeenCalledWith(NAME);
	});

	it("offers removed information only after the author asks to add", () => {
		const hidden = column("3", "date_of_birth", "");
		const onShow = vi.fn();
		render(
			<AddInformationControl
				columns={[hidden]}
				brokenColumns={new Set()}
				onShow={onShow}
				onCreate={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		expect(screen.queryByText("Date of birth")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Add information" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Date of birth" }));
		expect(onShow).toHaveBeenCalledWith(hidden);
		expect(screen.queryByText("date_of_birth")).toBeNull();
	});

	it("keeps search-field membership in the center composition", () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000004"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const onRemoveInput = vi.fn();

		render(
			<SearchCanvas
				searchInputs={[input]}
				searchConfig={undefined}
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
				onSelect={() => {}}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
				onRemoveInput={onRemoveInput}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "More options for Patient name" }),
		);
		fireEvent.click(
			screen.getByRole("menuitem", { name: "Remove from search" }),
		);

		expect(onRemoveInput).toHaveBeenCalledWith(input.uuid);
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
				onRemoveInput={() => {}}
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

	it("confirms before removing a customized search screen", () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000005"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const onRemoveInput = vi.fn();

		render(
			<SearchCanvas
				searchInputs={[input]}
				searchConfig={{ searchScreenTitle: "Find a patient" }}
				caseTypes={[]}
				currentCaseType="patient"
				selection={null}
				onSelect={() => {}}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
				onRemoveInput={onRemoveInput}
				finalInputRemovalNeedsConfirmation
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "More options for Patient name" }),
		);
		fireEvent.click(
			screen.getByRole("menuitem", {
				name: /remove search screen.*also removes its screen settings/i,
			}),
		);
		expect(
			screen.getByRole("heading", { name: "Remove the search screen?" }),
		).toBeDefined();
		expect(
			screen.getByText(/results fields and cases included rule/i),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Keep search" }));
		expect(onRemoveInput).not.toHaveBeenCalled();

		fireEvent.click(
			screen.getByRole("button", { name: "More options for Patient name" }),
		);
		fireEvent.click(
			screen.getByRole("menuitem", {
				name: /remove search screen.*also removes its screen settings/i,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove search" }));
		expect(onRemoveInput).toHaveBeenCalledWith(input.uuid, {
			discardSearchSettings: true,
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
				onRemoveInput={() => {}}
				hasSearchSurface={false}
			/>,
		);

		expect(
			screen.getByText(/add a search field when people need to narrow/i),
		).toBeDefined();
		expect(screen.getByText("People go straight to results")).toBeDefined();
		expect(
			screen.queryByRole("button", { name: "Edit screen text" }),
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
				onRemoveInput={() => {}}
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
				onRemoveInput={() => {}}
				hasSearchSurface={false}
				hasAutomaticResultsFilter
			/>,
		);

		expect(screen.getByText("People go straight to results")).toBeDefined();
		expect(screen.getByText(/cases included rule narrows/i)).toBeDefined();
		expect(screen.queryByText("Unused title")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /edit screen text/i }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /edit search button/i }),
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
		const message = "Open Cases included and repair its condition.";

		render(
			<CaseListCanvas
				config={{ columns: [], searchInputs: [] }}
				caseType={undefined}
				brokenColumns={new Set()}
				preview={{ kind: "paused", message }}
				selection={null}
				onSelect={() => {}}
				onAddColumn={() => {}}
				addColumnDisabledReason={undefined}
				onMoveColumn={() => {}}
				onColumnsChange={() => {}}
				onRemoveColumn={() => {}}
				onShowColumn={() => {}}
				onOpenOptions={() => {}}
				generateSampleData={{
					status: { kind: "idle" },
					run: async () => {},
				}}
			/>,
		);

		expect(screen.getByText(message)).toBeDefined();
		expect(
			screen.getByRole("heading", { name: "Design the results" }),
		).toBeDefined();
		expect(screen.queryByText(/arrange fields/i)).toBeNull();
	});
});
