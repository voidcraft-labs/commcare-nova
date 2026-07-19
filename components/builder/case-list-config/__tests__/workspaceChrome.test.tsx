// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	advancedSearchInputDef,
	asUuid,
	type CaseProperty,
	type CaseType,
	type Column,
	caseSearchConfigAfterFinalInputRemoval,
	fuzzyDateMode,
	multiSelectContainsMode,
	rangeMode,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	eq,
	literal,
	matchAll,
	not,
	prop,
	relationStep,
	sessionContext,
	term,
	today,
} from "@/lib/domain/predicate";
import { AssignedCasesSetting } from "../canvas/AssignedCasesSetting";
import { CaseListCanvas } from "../canvas/CaseListCanvas";
import { DetailCanvas } from "../canvas/DetailCanvas";
import {
	AddInformationControl,
	DisplayFieldComposer,
} from "../canvas/DisplayFieldComposer";
import { SearchCanvas } from "../canvas/SearchCanvas";
import { SearchConditionCanvas } from "../canvas/SearchConditionCanvas";
import { SearchInputEditor } from "../inspector/SearchInputEditor";
import { SearchPanelInspectorBody } from "../inspector/SearchPanelInspectorBody";

const session = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => session.canEdit,
}));

// This suite exercises the case-workspace chrome, not TipTap. Keep the
// unrelated markdown editor out of focused Search-panel tests so its deferred
// DOM-observer setup cannot outlive the test that mounted the inspector.
vi.mock("@/components/builder/inspector/OptionalMarkdownRow", () => ({
	OptionalMarkdownRow: () => null,
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
const SEARCH_CONDITION_CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		properties: [{ name: "status", label: "Status", data_type: "text" }],
	},
];
const FIRST_SEARCH_CONDITION = eq(prop("patient", "status"), literal(""));

/** Base UI Select commits from the pointer press that begins the option click. */
function pressSelectOption(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
}

/** Let Base UI finish popup scroll-lock release and collapsible transitions. */
async function settleBaseUiTransitions(): Promise<void> {
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	});
}

/** Happy DOM does not synthesize a button's browser-owned click from Enter.
 * Model that native activation sequence explicitly while still checking that
 * the disclosure exposes a real, focus-retaining button to keyboard users. */
function pressFocusedButtonWithEnter(button: HTMLElement): void {
	button.focus();
	fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
	fireEvent.click(button, { detail: 0 });
	fireEvent.keyUp(button, { key: "Enter", code: "Enter" });
}

describe("case workspace chrome", () => {
	beforeEach(() => {
		session.canEdit = true;
	});

	it("keeps the assigned-case rule and zero-input Search action settings when the final field is removed", () => {
		const excludedOwnerIds = term(sessionContext("userid"));
		expect(
			caseSearchConfigAfterFinalInputRemoval(
				{
					excludedOwnerIds,
					searchScreenTitle: "Find a client",
					searchScreenSubtitle: "Use any known information",
					searchButtonLabel: "Find",
					searchButtonDisplayCondition: FIRST_SEARCH_CONDITION,
				},
				false,
			),
		).toEqual({
			excludedOwnerIds,
			searchButtonLabel: "Find",
			searchButtonDisplayCondition: FIRST_SEARCH_CONDITION,
		});
	});

	it.each([
		false,
		true,
	])("keeps zero-input Search action settings with Cases available=%s", (hasCasesAvailableCondition) => {
		expect(
			caseSearchConfigAfterFinalInputRemoval(
				{
					searchScreenTitle: "Find a client",
					searchButtonLabel: "Find",
					searchButtonDisplayCondition: FIRST_SEARCH_CONDITION,
				},
				hasCasesAvailableCondition,
			),
		).toEqual({
			searchButtonLabel: "Find",
			searchButtonDisplayCondition: FIRST_SEARCH_CONDITION,
		});
	});

	it("drops copy that belonged only to the removed Search screen", () => {
		expect(
			caseSearchConfigAfterFinalInputRemoval(
				{
					searchScreenTitle: "Find a client",
					searchScreenSubtitle: "Use any known information",
				},
				false,
			),
		).toBeUndefined();
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
			"Patient name moved later in Results",
		);
		expect(screen.queryByText(/^1$/)).toBeNull();
	});

	it("groups displayed information as one named ordered list", () => {
		render(
			<DisplayFieldComposer
				columns={[NAME, DOB]}
				surface="list"
				selectedUuid={null}
				brokenColumns={new Set()}
				onSelect={() => {}}
				onMove={() => {}}
			/>,
		);

		const list = screen.getByRole("list", { name: "Results information" });
		const items = within(list).getAllByRole("listitem");
		expect(list.tagName).toBe("OL");
		expect(items).toHaveLength(2);
		expect(Array.from(list.children)).toEqual(items);
		expect(within(items[0]).getByText("Patient name")).toBeDefined();
		expect(within(items[1]).getByText("Date of birth")).toBeDefined();
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
		const selectField = screen.getByRole("button", { name: "Patient name" });
		expect(selectField.getAttribute("data-case-column-select")).toBe(NAME.uuid);
		expect(selectField.classList.contains("focus-visible:ring-inset")).toBe(
			true,
		);
		fireEvent.click(selectField);
		expect(onSelect).toHaveBeenCalledWith(NAME);
	});

	it("renders read-only information as content instead of a disabled control", () => {
		session.canEdit = false;
		const onSelect = vi.fn();
		render(
			<DisplayFieldComposer
				columns={[NAME]}
				surface="list"
				selectedUuid={null}
				brokenColumns={new Set([NAME.uuid])}
				onSelect={onSelect}
				onMove={() => {}}
			/>,
		);

		expect(screen.getByText("Patient name")).toBeDefined();
		expect(screen.getByText("May not appear")).toBeDefined();
		expect(screen.queryByText("Needs attention")).toBeNull();
		expect(screen.queryByRole("button", { name: "Patient name" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /move patient name/i }),
		).toBeNull();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("wraps essential information names instead of truncating them", () => {
		const longLabel =
			"Preferred client name as recorded during the most recent household visit";
		render(
			<DisplayFieldComposer
				columns={[{ ...NAME, header: longLabel }]}
				surface="list"
				selectedUuid={null}
				brokenColumns={new Set()}
				onSelect={() => {}}
				onMove={() => {}}
			/>,
		);

		const label = screen.getByText(longLabel);
		expect(label.className).toContain("break-words");
		expect(label.className).toContain("whitespace-normal");
		expect(label.className).not.toContain("truncate");
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

	it("describes empty Details without instructing viewers to edit", () => {
		session.canEdit = false;
		render(
			<DetailCanvas
				config={{ columns: [], searchInputs: [] }}
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

		expect(
			screen.getByText("People see no extra information after choosing a case"),
		).toBeDefined();
		expect(
			screen.getByText("People see this information after opening a case"),
		).toBeDefined();
		expect(
			screen.getByText(
				"People can review more information here after opening a case",
			),
		).toBeDefined();
		expect(
			screen.queryByText("Choose what people see after opening a case"),
		).toBeNull();
		expect(screen.queryByText(/Drag to reorder/i)).toBeNull();
	});

	it("describes Results without edit instructions to viewers", () => {
		session.canEdit = false;
		const patient: CaseType = {
			name: "patient",
			properties: [{ name: "case_name", label: "Patient", data_type: "text" }],
		};
		render(
			<CaseListCanvas
				config={{ columns: [NAME], searchInputs: [] }}
				caseType={patient}
				caseTypes={[patient]}
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
				filterBroken={false}
				onFilterChange={() => ({ ok: true })}
				onClearFilter={() => ({ ok: true })}
				searchConfig={undefined}
				caseSearchEnabled={false}
				onExcludedOwnerIdsChange={() => {}}
				appId="app-1"
			/>,
		);

		expect(
			screen.getByText("People use this information to compare cases"),
		).toBeDefined();
		expect(
			screen.getByText("People recognize and compare cases here"),
		).toBeDefined();
		expect(
			screen.getByText(
				"Your app’s rules determine which cases can appear in Results",
			),
		).toBeDefined();
		expect(
			screen.getByText(
				"This order determines which cases appear first in Results",
			),
		).toBeDefined();
		expect(screen.queryByText(/^Choose /)).toBeNull();
		expect(screen.queryByText(/Drag to reorder/i)).toBeNull();
	});

	it("explains an empty Results screen to viewers without offering edits", () => {
		session.canEdit = false;
		render(
			<CaseListCanvas
				config={{ columns: [], searchInputs: [] }}
				caseType={{ name: "patient", properties: [] }}
				caseTypes={[]}
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
				filterBroken={false}
				onFilterChange={() => ({ ok: true })}
				onClearFilter={() => ({ ok: true })}
				searchConfig={undefined}
				caseSearchEnabled={false}
				onExcludedOwnerIdsChange={() => {}}
				appId="app-1"
			/>,
		);

		expect(screen.getByText("No case information is shown")).toBeDefined();
		expect(
			screen.getByText(
				"People can’t recognize a case from this screen. Ask someone who can edit the app to add information.",
			),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: "Add information" }),
		).toBeNull();
	});

	it("keeps availability visible on Results above the default order", () => {
		const sortedName = {
			...NAME,
			sort: { direction: "asc" as const, priority: 0 },
		};
		const patient: CaseType = {
			name: "patient",
			properties: [{ name: "case_name", label: "Patient", data_type: "text" }],
		};
		render(
			<CaseListCanvas
				config={{ columns: [sortedName], searchInputs: [] }}
				caseType={patient}
				caseTypes={[patient]}
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
				filterBroken={false}
				onFilterChange={() => ({ ok: true })}
				onClearFilter={() => ({ ok: true })}
				searchConfig={undefined}
				caseSearchEnabled={false}
				onExcludedOwnerIdsChange={() => {}}
				appId="app-1"
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Change default order" }),
		).toBeDefined();
		expect(
			screen
				.getAllByRole("heading", { level: 2 })
				.map((heading) => heading.textContent),
		).toEqual(["Information shown", "Cases available", "Default order"]);
		expect(screen.getAllByText("Default order")).toHaveLength(1);
		expect(screen.getByText("All cases are available")).toBeDefined();
		expect(
			screen.queryByRole("button", { name: /edit menu appearance/i }),
		).toBeNull();
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
		const addInformation = screen.getByRole("combobox", {
			name: "Add information",
		});
		expect(addInformation.getAttribute("data-case-add")).toBe("detail");
		fireEvent.click(addInformation);
		expect(onCreate).not.toHaveBeenCalled();
		const dateChoice = screen.getByRole("option", {
			name: /date of birth.*date/i,
		});
		expect(
			[...dateChoice.querySelectorAll("span")].some((part) =>
				part.className.includes("whitespace-normal"),
			),
		).toBe(true);
		expect(
			[...dateChoice.querySelectorAll("span")].some((part) =>
				part.className.includes("truncate"),
			),
		).toBe(false);
		fireEvent.click(dateChoice);
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

		fireEvent.click(screen.getByRole("combobox", { name: "Add information" }));
		fireEvent.change(
			screen.getByRole("combobox", { name: "Search case information" }),
			{ target: { value: "date" } },
		);
		fireEvent.click(
			screen.getByRole("option", { name: /date of birth.*date/i }),
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
		fireEvent.click(screen.getByRole("combobox", { name: "Add information" }));

		expect(
			(
				screen.getByRole("combobox", {
					name: "Search case information",
				}) as HTMLInputElement
			).value,
		).toBe("");
		expect(screen.getByRole("option", { name: /^age\b/i })).toBeDefined();
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

		const addInformation = screen.getByRole("combobox", {
			name: "Add information",
		});
		expect(screen.queryByText("Needs attention")).toBeNull();

		fireEvent.click(addInformation);
		fireEvent.click(
			screen.getByRole("option", {
				name: /date of birth.*needs attention/i,
			}),
		);

		expect(onRepair).toHaveBeenCalledWith(hidden);
		expect(onShow).not.toHaveBeenCalled();
	});

	it("describes a saved off-screen setup by its label and format", async () => {
		const hidden = {
			...column("34", "date_of_birth", "Date of birth"),
			visibleInList: false,
			visibleInDetail: false,
		};
		render(
			<AddInformationControl
				surface="list"
				columns={[hidden]}
				properties={[]}
				repeatableProperties={[]}
				brokenColumns={new Set()}
				onShow={() => {}}
				onRepair={() => {}}
				onCreate={() => {}}
				onCreateCalculated={() => {}}
				createDisabledReason={undefined}
			/>,
		);

		const addInformation = screen.getByRole("combobox", {
			name: "Add information",
		});
		fireEvent.click(addInformation);
		expect(
			screen.getByRole("option", {
				name: /date of birth.*saved label and format/i,
			}),
		).toBeDefined();
		expect(screen.queryByText("Previously formatted")).toBeNull();

		fireEvent.click(addInformation);
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
		await settleBaseUiTransitions();
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

		const addInformation = screen.getByRole("combobox", {
			name: "Add information",
		});
		fireEvent.click(addInformation);
		expect(await screen.findByText("Common information")).toBeDefined();
		expect(screen.queryByText("Ready to add")).toBeNull();

		const scrollRegion = document.querySelector(
			"[data-combobox-scroll-region]",
		);
		const listbox = document.querySelector('[data-slot="combobox-list"]');
		expect(scrollRegion).not.toBeNull();
		expect(listbox).not.toBeNull();
		expect(scrollRegion?.contains(listbox)).toBe(true);
		expect(scrollRegion?.querySelector('[data-slot="input-group"]')).toBeNull();
		const picker = screen.getByRole("dialog", { name: "Add information" });
		expect(picker?.className).toContain("max-h-");
		expect(picker?.className).not.toContain("overflow-y-auto");
		expect(scrollRegion?.className).toContain("overflow-y-auto");
		expect(scrollRegion?.className).toContain("overscroll-contain");
		expect(
			picker?.className.split(/\s+/).some((name) => name.startsWith("h-[")),
		).toBe(false);
		expect(screen.getAllByRole("option")).toHaveLength(25);
		expect(screen.queryByText("Create new information")).toBeNull();

		fireEvent.change(
			screen.getByRole("combobox", { name: "Search case information" }),
			{
				target: { value: "Field 23" },
			},
		);
		const field23 = screen.getByRole("option", {
			name: /field 23.*also shown in details/i,
		});
		expect(field23).toBeDefined();
		expect(
			screen.queryByRole("option", {
				name: /^field 2 .*also shown in details$/i,
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

		fireEvent.click(screen.getByRole("combobox", { name: "Add information" }));
		fireEvent.click(
			screen.getByRole("option", {
				name: /calculated value.*build a value/i,
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

		fireEvent.click(screen.getByRole("combobox", { name: "Add information" }));
		const search = screen.getByRole("combobox", {
			name: "Search case information",
		});
		fireEvent.change(search, { target: { value: "nothing matches" } });

		expect(screen.getByRole("status").textContent).toContain(
			"No matching information",
		);
		expect(screen.getByText("Try a different search")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

		expect((search as HTMLInputElement).value).toBe("");
		expect(document.activeElement).toBe(search);
		expect(
			screen.getByRole("option", { name: /date of birth.*date/i }),
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

		fireEvent.click(screen.getByRole("combobox", { name: "Add information" }));
		expect(screen.queryByRole("option", { name: /date of birth/i })).toBeNull();
		fireEvent.click(
			screen.getByRole("option", {
				name: /show information another way.*another label or format/i,
			}),
		);
		expect(
			screen.getByRole("heading", { name: "Show information another way" }),
		).toBeDefined();
		fireEvent.click(
			screen.getByRole("option", {
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

		fireEvent.click(screen.getByRole("combobox", { name: "Add information" }));
		fireEvent.click(
			screen.getByRole("option", {
				name: /show information another way.*another label or format/i,
			}),
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Search information already shown",
			}),
			{ target: { value: "date" } },
		);
		fireEvent.click(
			screen.getByRole("option", {
				name: /date of birth.*second label or format/i,
			}),
		);
		expect(onCreate).toHaveBeenCalledWith(DOB_PROPERTY);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		const addInformation = screen.getByRole("combobox", {
			name: "Add information",
		});
		fireEvent.click(addInformation);
		expect(
			await screen.findByRole("heading", { name: "Add information" }),
		).toBeDefined();
		expect(
			(
				screen.getByRole("combobox", {
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
				selection={null}
				onSelect={onSelect}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
			/>,
		);

		const screenTitle = screen.getByRole("heading", {
			name: "Find a patient",
		});
		expect(screenTitle.className).toContain("break-words");
		expect(
			screen.queryByRole("button", { name: "Find matching cases" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /more options/i })).toBeNull();
		const editSearch = screen.getByRole("button", {
			name: "Edit Search screen",
		});
		expect(editSearch.hasAttribute("data-case-search-panel")).toBe(true);
		fireEvent.click(editSearch);
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
			"Patient name moved later in Search",
		);
	});

	it("groups authored Search fields as one labelled ordered list", () => {
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
				onMoveInput={() => {}}
			/>,
		);

		const list = screen.getByRole("list", { name: "Search fields" });
		const items = within(list).getAllByRole("listitem");
		expect(list.tagName).toBe("OL");
		expect(items).toHaveLength(2);
		expect(Array.from(list.children)).toEqual(items);
		expect(within(items[0]).getByText("Patient name")).toBeDefined();
		expect(within(items[1]).getByText("External ID")).toBeDefined();
	});

	it("wraps essential search-field names instead of truncating them", () => {
		session.canEdit = false;
		const longLabel =
			"Client name exactly as it appears on the household registration document";
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000043"),
			"missing_property",
			longLabel,
			"text",
			"missing_property",
		);

		render(
			<SearchCanvas
				searchInputs={[input]}
				searchConfig={undefined}
				caseTypes={[{ name: "patient", properties: [] }]}
				currentCaseType="patient"
				selection={null}
				onSelect={() => {}}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
			/>,
		);

		const label = screen.getByText(longLabel);
		expect(label.className).toContain("break-words");
		expect(label.className).not.toContain("truncate");
		expect(screen.getByText("May not work")).toBeDefined();
		expect(screen.queryByText("Needs attention")).toBeNull();
	});

	it("keeps date-range fields readable in the open-sidebar canvas", () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000045"),
			"last_visit",
			"Last visit",
			"date-range",
			"last_visit",
			{ mode: rangeMode() },
		);

		render(
			<SearchCanvas
				searchInputs={[input]}
				searchConfig={undefined}
				caseTypes={[
					{
						name: "patient",
						properties: [
							{ name: "last_visit", label: "Last visit", data_type: "date" },
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				selection={null}
				onSelect={() => {}}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
			/>,
		);

		const from = screen.getByText("From");
		const field = from.parentElement;
		const range = field?.parentElement;
		const label = screen.getByText("Last visit");
		const rowContent = label.parentElement?.parentElement;

		expect(field?.className).toContain("w-full");
		expect(range?.className).toContain("grid-cols-1");
		expect(range?.className).toContain("@sm:grid-cols-2");
		expect(rowContent?.className).toContain("flex-col");
		expect(rowContent?.contains(range ?? null)).toBe(true);
	});

	it("canonicalizes a legacy alias when a custom binding returns to this case", async () => {
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
				onEditCondition={() => {}}
			/>,
		);
		fireEvent.click(
			screen.getByRole("combobox", { name: "Search field 1 information" }),
		);
		fireEvent.click(
			await screen.findByRole("option", { name: /patient name/i }),
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
			screen.getByText(/add fields when people should narrow Results/i),
		).toBeDefined();
		expect(
			screen.getByRole("heading", { name: "No search fields" }),
		).toBeDefined();
		expect(
			document.querySelector('[data-search-action-state="not-available"]'),
		).not.toBeNull();
		expect(
			screen.queryByRole("heading", {
				name: "Search is available from Results",
			}),
		).toBeNull();
		expect(
			document.querySelector('[data-search-surface-state="empty"]'),
		).not.toBeNull();
		expect(
			screen.getByText("Add a field to let people narrow cases before Results"),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: "Edit Search screen" }),
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
		expect(
			screen.getByText("This module doesn’t ask for search information"),
		).toBeDefined();
		expect(
			screen.getByText("Results opens without asking for search information"),
		).toBeDefined();
		expect(
			screen.queryByText(/Add fields when people should narrow Results/i),
		).toBeNull();
		expect(
			screen.getByText("People narrow cases here before selecting one"),
		).toBeDefined();
		expect(
			screen.queryByText("Choose how people narrow cases before selecting one"),
		).toBeNull();
	});

	it("describes automatic Results only for the real zero-input filter shape", () => {
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
				opensResultsAutomatically
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Results can open automatically" }),
		).toBeDefined();
		expect(
			screen.getByText("Cases available still decides which cases people see"),
		).toBeDefined();
		expect(screen.queryByText("Unused title")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Edit Search screen" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Change when people continue",
			}),
		);
		expect(onSelect).toHaveBeenCalledWith({ type: "search-panel" });
	});

	it("distinguishes a manual zero-input Search action from no Search", () => {
		const view = render(
			<SearchCanvas
				searchInputs={[]}
				searchConfig={{}}
				caseTypes={[]}
				currentCaseType="patient"
				selection={null}
				onSelect={() => {}}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
				hasSearchSurface={false}
				hasSearchAction
			/>,
		);

		expect(
			screen.getByRole("heading", {
				name: "Search is available from Results",
			}),
		).toBeDefined();
		expect(
			screen.getByText("People continue without entering search information"),
		).toBeDefined();
		expect(
			document.querySelector('[data-search-action-state="available"]'),
		).not.toBeNull();

		view.rerender(
			<SearchCanvas
				searchInputs={[]}
				searchConfig={{
					searchActionEnabled: false,
					excludedOwnerIds: term(sessionContext("userid")),
				}}
				caseTypes={[]}
				currentCaseType="patient"
				selection={null}
				onSelect={() => {}}
				onAddInput={() => {}}
				addInputDisabledReason={undefined}
				onMoveInput={() => {}}
				hasSearchSurface={false}
				hasSearchAction={false}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "No search fields" }),
		).toBeDefined();
		expect(
			screen.queryByText("People continue without entering search information"),
		).toBeNull();
	});

	it("opens zero-input Search action settings because the action is in use", () => {
		render(
			<SearchPanelInspectorBody
				value={{
					searchScreenTitle: "Unused title",
					excludedOwnerIds: term(sessionContext("userid")),
				}}
				onChange={() => {}}
				caseTypes={[]}
				currentCaseType="patient"
				hasVisibleSearchScreen={false}
				hasSearchAction
				opensResultsAutomatically
				onEditDisplayCondition={() => {}}
			/>,
		);

		expect(
			screen.getByText(/Results opens automatically when Search is available/i),
		).toBeDefined();
		expect(screen.queryByText("Title")).toBeNull();
		expect(screen.queryByText("Search button label")).toBeNull();
		const moreSettings = screen.getByRole("button", {
			name: /More settings.*In use/,
		});
		expect(moreSettings.getAttribute("data-slot")).toBe("collapsible-trigger");
		expect(moreSettings.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Search action label")).toBeDefined();
		expect(
			screen
				.getByText(/Offer the Search action only when a condition matches/i)
				.closest('[data-slot="collapsible-content"]'),
		).not.toBeNull();
		expect(
			screen.queryByText("Cases assigned to the person using the app"),
		).toBeNull();
	});

	it("keeps owner-only availability out of zero-input Search settings", () => {
		const view = render(
			<SearchPanelInspectorBody
				value={{
					searchActionEnabled: false,
					excludedOwnerIds: term(sessionContext("userid")),
				}}
				onChange={() => {}}
				caseTypes={[]}
				currentCaseType="patient"
				hasVisibleSearchScreen={false}
				hasSearchAction={false}
				onEditDisplayCondition={() => {}}
			/>,
		);

		expect(
			screen.getByText(/Add Search from Results when they need/i),
		).toBeDefined();
		let moreSettings = screen.getByRole("button", { name: "More settings" });
		expect(moreSettings.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("In use")).toBeNull();

		view.rerender(
			<SearchPanelInspectorBody
				value={{}}
				onChange={() => {}}
				caseTypes={[]}
				currentCaseType="patient"
				hasVisibleSearchScreen={false}
				hasSearchAction
				onEditDisplayCondition={() => {}}
			/>,
		);
		expect(screen.getByText(/Search is available from Results/i)).toBeDefined();
		moreSettings = screen.getByRole("button", {
			name: /More settings.*In use/,
		});
		expect(moreSettings.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Search action label")).toBeDefined();
	});

	it("opens Search settings from the keyboard without moving focus", () => {
		render(
			<SearchPanelInspectorBody
				value={undefined}
				onChange={() => {}}
				caseTypes={[]}
				currentCaseType="patient"
				onEditDisplayCondition={() => {}}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "More settings" });
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.getAttribute("data-slot")).toBe("collapsible-trigger");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("When Search is available")).toBeNull();

		pressFocusedButtonWithEnter(trigger);

		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(trigger);
		expect(
			screen
				.getByText("When Search is available")
				.closest('[data-slot="collapsible-content"]'),
		).not.toBeNull();

		pressFocusedButtonWithEnter(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(trigger);
		expect(screen.queryByText("When Search is available")).toBeNull();
	});

	it("offers the assigned-case rule only beside Results availability", async () => {
		const onChange = vi.fn();
		render(
			<AssignedCasesSetting value={undefined} onChange={onChange} canEdit />,
		);
		const disclosure = screen.getByRole("button", {
			name: "More availability settings",
		});
		expect(disclosure.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("In use")).toBeNull();
		expect(
			screen.queryByText("Cases assigned to the person using the app"),
		).toBeNull();
		fireEvent.click(disclosure);

		fireEvent.click(
			screen.getByRole("combobox", {
				name: "Cases assigned to the person using the app",
			}),
		);
		pressSelectOption(
			await screen.findByRole("option", {
				name: "Hide from Results",
			}),
		);

		expect(onChange).toHaveBeenLastCalledWith(term(sessionContext("userid")));
	});

	it("opens and marks an imported assigned-case rule that needs repair", () => {
		render(
			<AssignedCasesSetting
				value={term(prop("patient", "age"))}
				onChange={() => {}}
				canEdit
				hasError
			/>,
		);

		const disclosure = screen.getByRole("button", {
			name: /More availability settings.*Needs attention/,
		});
		expect(disclosure.getAttribute("aria-expanded")).toBe("true");
		expect(disclosure.getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByRole("alert").textContent).toContain(
			"This saved setting no longer works here",
		);
		expect(screen.getByRole("alert").textContent).toContain(
			"Show in Results or Hide from Results",
		);
	});

	it("opens and marks Search settings when its saved action rule needs repair", () => {
		render(
			<SearchPanelInspectorBody
				value={{ searchButtonDisplayCondition: matchAll() }}
				onChange={() => {}}
				caseTypes={[]}
				currentCaseType="patient"
				hasVisibleSearchScreen={false}
				onEditDisplayCondition={() => {}}
				searchSettingsHasError
			/>,
		);

		const moreSettings = screen.getByRole("button", {
			name: /More settings.*Needs attention/,
		});
		expect(moreSettings.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Needs attention")).toBeDefined();
	});

	it("uses action-based labels for a zero-input Search condition", async () => {
		const onChange = vi.fn();
		const view = render(
			<SearchPanelInspectorBody
				value={{ searchButtonDisplayCondition: matchAll() }}
				onChange={onChange}
				caseTypes={[]}
				currentCaseType="patient"
				hasVisibleSearchScreen={false}
				onEditDisplayCondition={() => {}}
			/>,
		);

		const moreSettings = screen.getByRole("button", {
			name: /More settings/,
		});
		expect(moreSettings.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Search is always available")).toBeDefined();
		const alwaysContinue = screen.getByRole("button", {
			name: "Always allow Search",
		});
		expect(alwaysContinue.className).toContain("bg-destructive");
		alwaysContinue.focus();
		fireEvent.click(alwaysContinue);
		let dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Always allow Search?",
			}),
		).toBeDefined();
		expect(
			within(dialog).getByText(
				"The current condition will be removed, and Search will be available whenever this case list can search. You can undo this change.",
			),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(alwaysContinue));

		fireEvent.click(alwaysContinue);
		dialog = await screen.findByRole("alertdialog");
		const confirm = within(dialog).getByRole("button", {
			name: "Always allow Search",
		});
		expect(confirm.className).toContain("bg-destructive");
		fireEvent.click(confirm);
		expect(onChange).toHaveBeenLastCalledWith({});
		view.rerender(
			<SearchPanelInspectorBody
				value={{}}
				onChange={onChange}
				caseTypes={[]}
				currentCaseType="patient"
				hasVisibleSearchScreen={false}
				onEditDisplayCondition={() => {}}
			/>,
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add condition" }),
			),
		);
		view.rerender(
			<SearchPanelInspectorBody
				value={{ searchButtonDisplayCondition: matchAll() }}
				onChange={onChange}
				caseTypes={[]}
				currentCaseType="patient"
				hasVisibleSearchScreen
				onEditDisplayCondition={() => {}}
			/>,
		);
		expect(
			screen
				.getByRole("button", { name: /More settings/ })
				.getAttribute("aria-expanded"),
		).toBe("true");
		expect(
			screen.getByRole("button", { name: "Always allow Search" }),
		).toBeDefined();
	});

	it("confirms before clearing a complex Search button condition", async () => {
		const complexCondition = and(
			FIRST_SEARCH_CONDITION,
			not(FIRST_SEARCH_CONDITION),
		);
		const onChange = vi.fn();
		const view = render(
			<SearchPanelInspectorBody
				value={{ searchButtonDisplayCondition: complexCondition }}
				onChange={onChange}
				caseTypes={SEARCH_CONDITION_CASE_TYPES}
				currentCaseType="patient"
				hasVisibleSearchScreen
				onEditDisplayCondition={() => {}}
			/>,
		);

		const alwaysShow = screen.getByRole("button", {
			name: "Always allow Search",
		});
		fireEvent.click(alwaysShow);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByText(
				"The current condition will be removed, and Search will be available whenever this case list can search. You can undo this change.",
			),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Always allow Search" }),
		);
		expect(onChange).toHaveBeenLastCalledWith({});

		view.rerender(
			<SearchPanelInspectorBody
				value={{}}
				onChange={onChange}
				caseTypes={SEARCH_CONDITION_CASE_TYPES}
				currentCaseType="patient"
				hasVisibleSearchScreen
				onEditDisplayCondition={() => {}}
			/>,
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add condition" }),
			),
		);
	});

	it("keeps an imported owner rule when replacement is canceled", async () => {
		const customOwners = term(literal("owner-a owner-b"));
		const onChange = vi.fn();
		render(
			<AssignedCasesSetting value={customOwners} onChange={onChange} canEdit />,
		);
		expect(
			screen
				.getByRole("button", {
					name: /More availability settings.*In use/,
				})
				.getAttribute("aria-expanded"),
		).toBe("true");
		expect(screen.getByText("In use")).toBeDefined();

		expect(screen.getByRole("status").textContent).toContain(
			"Some assigned cases may be hidden",
		);
		expect(screen.getByRole("status").textContent).toContain(
			"Your saved setting decides which ones appear",
		);
		expect(screen.queryByText(/owner ID/i)).toBeNull();
		fireEvent.click(
			screen.getByRole("combobox", {
				name: "Cases assigned to the person using the app",
			}),
		);
		expect(
			await screen.findByRole("option", { name: "Keep saved setting" }),
		).toBeDefined();
		pressSelectOption(
			await screen.findByRole("option", {
				name: "Show in Results",
			}),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Show assigned cases in Results?",
			}),
		).toBeDefined();
		expect(
			within(dialog).getByText(
				"This replaces your saved setting. Cases it currently hides can appear in Results. You can undo this change.",
			),
		).toBeDefined();
		expect(
			within(dialog).getByRole("button", { name: "Show cases" }),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		const trigger = screen.getByRole("combobox", {
			name: "Cases assigned to the person using the app",
		});
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(onChange).not.toHaveBeenCalled();
	});

	it("replaces an imported owner rule only after confirmation", async () => {
		const customOwners = term(literal("owner-a owner-b"));
		const currentUserOwners = term(sessionContext("userid"));
		const onChange = vi.fn();
		const view = render(
			<AssignedCasesSetting value={customOwners} onChange={onChange} canEdit />,
		);
		fireEvent.click(
			screen.getByRole("combobox", {
				name: "Cases assigned to the person using the app",
			}),
		);
		pressSelectOption(
			await screen.findByRole("option", { name: "Hide from Results" }),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Hide cases assigned to the person using the app?",
			}),
		).toBeDefined();
		expect(
			within(dialog).getByText(
				"This replaces your saved setting, so some cases it currently hides may appear in Results. You can undo this change.",
			),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
		const replace = within(dialog).getByRole("button", {
			name: "Hide cases",
		});
		expect(replace.className).toContain("bg-destructive");
		fireEvent.click(replace);
		expect(onChange).toHaveBeenLastCalledWith(currentUserOwners);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("combobox", {
					name: "Cases assigned to the person using the app",
				}),
			),
		);

		view.rerender(
			<AssignedCasesSetting
				value={currentUserOwners}
				onChange={onChange}
				canEdit
			/>,
		);
		fireEvent.click(
			screen.getByRole("combobox", {
				name: "Cases assigned to the person using the app",
			}),
		);
		expect(
			screen.queryByRole("option", { name: "Keep saved setting" }),
		).toBeNull();
		pressSelectOption(
			await screen.findByRole("option", { name: "Show in Results" }),
		);
		expect(onChange).toHaveBeenLastCalledWith(undefined);
		expect(screen.queryByRole("alertdialog")).toBeNull();
		await waitFor(() =>
			expect(
				screen.queryByRole("option", { name: "Show in Results" }),
			).toBeNull(),
		);
		await settleBaseUiTransitions();
	});

	it("preserves an opaque imported owner rule without exposing its expression", async () => {
		render(
			<AssignedCasesSetting
				value={term(literal(""))}
				onChange={() => {}}
				canEdit
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain(
			"Your saved setting decides which ones appear",
		);
		expect(screen.queryByRole("textbox")).toBeNull();
		await settleBaseUiTransitions();
	});

	it("uses the shared search input inside the information picker", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000045"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: "Patient name", data_type: "text" },
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("combobox", { name: "Search field 1 information" }),
		);
		const search = await screen.findByRole("combobox", {
			name: "Search information",
		});
		expect(search.getAttribute("data-slot")).toBe("input-group-control");
		expect(search.getAttribute("autocomplete")).toBe("off");
		expect(search.hasAttribute("data-1p-ignore")).toBe(true);
		fireEvent.change(search, { target: { value: "unknown" } });
		expect((search as HTMLInputElement).value).toBe("unknown");
		expect(screen.getByText("No matching information")).toBeDefined();
		expect(screen.getByText("Try a different search")).toBeDefined();
	});

	it("wraps complete information names and type guidance in search field settings", async () => {
		const longPropertyLabel =
			"Preferred household contact name from the most recent registration visit";
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000049"),
			"preferred_household_contact_name",
			"Preferred contact",
			"text",
			"preferred_household_contact_name",
		);
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[
					{
						name: "patient",
						properties: [
							{
								name: "preferred_household_contact_name",
								label: longPropertyLabel,
								data_type: "text",
							},
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		const informationTrigger = screen.getByRole("combobox", {
			name: "Search field 1 information",
		});
		const selectedLabel =
			within(informationTrigger).getByText(longPropertyLabel);
		expect(selectedLabel.className).toContain("break-words");
		expect(selectedLabel.className).not.toContain("truncate");

		const typeTrigger = screen.getByRole("button", {
			name: "Search field 1 type: Text box",
		});
		const typeDescription = typeTrigger.querySelector(".text-nova-text-muted");
		expect(typeDescription?.className).toContain("break-words");
		expect(typeDescription?.className).not.toContain("truncate");

		fireEvent.click(informationTrigger);
		const choice = await screen.findByRole("option", {
			name: new RegExp(longPropertyLabel, "i"),
		});
		const choiceLabel = within(choice).getByText(longPropertyLabel);
		expect(choice.className).toContain("whitespace-normal");
		expect(choiceLabel.className).toContain("break-words");
		expect(choiceLabel.className).not.toContain("truncate");
	});

	it("opens a custom search match in the center editor as soon as it is chosen", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000046"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const onChange = vi.fn();
		const onEditCondition = vi.fn();
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: "Patient name", data_type: "text" },
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={onEditCondition}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /search field 1 match/i }),
		);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /custom condition/i }),
		);

		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({ kind: "advanced" });
		expect(onEditCondition).toHaveBeenCalledOnce();
	});

	it("keeps a saved match and starting value until a field-type change is confirmed", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000146"),
			"visit_date",
			"Visit date",
			"text",
			"visit_date",
			{
				mode: { kind: "phonetic" },
				default: term(literal("yesterday")),
			},
		);
		const onChange = vi.fn();
		const editor = (key: string) => (
			<SearchInputEditor
				key={key}
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[
					{
						name: "patient",
						properties: [
							{
								name: "visit_date",
								label: "Visit date",
								data_type: "date",
							},
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={() => {}}
			/>
		);
		render(editor("cancel"));
		expect(
			screen.getByRole("button", {
				name: "Remove the starting value for search field 1",
			}).className,
		).toContain("bg-destructive");

		const typeTrigger = screen.getByRole("button", {
			name: /search field 1 type: text box/i,
		});
		fireEvent.click(typeTrigger);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /date picker/i }),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Change to “Date picker”?",
			}),
		).toBeDefined();
		expect(dialog.textContent).toContain(
			"“Sounds like” will become “Exact value”. The starting value will be removed because Date picker can’t use it. You can undo this change.",
		);
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onChange).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(typeTrigger);
		await settleBaseUiTransitions();
	});

	it("makes Between dates one atomic date-range transition", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000246"),
			"visit_date",
			"Visit date",
			"date",
			"visit_date",
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
							{
								name: "visit_date",
								label: "Visit date",
								data_type: "date",
							},
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /search field 1 match: exact/i }),
		);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /between dates/i }),
		);

		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({
			type: "date-range",
			property: "visit_date",
		});
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("mode");
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("default");
	});

	it("clears a saved one-date default in the same confirmed range transition", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000247"),
			"visit_date",
			"Visit date",
			"date",
			"visit_date",
			{ default: today() },
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
							{
								name: "visit_date",
								label: "Visit date",
								data_type: "date",
							},
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /search field 1 match: exact/i }),
		);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /between dates/i }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Change to “Between dates”?",
			}),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(within(dialog).getByRole("button", { name: "Change" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({ type: "date-range" });
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("mode");
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("default");
	});

	it("shows no starting-value control for a date range and only repairs a legacy one", () => {
		const base = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000248"),
			"visit_date",
			"Visit date",
			"date-range",
			"visit_date",
		);
		const onChange = vi.fn();
		const props = {
			index: 0,
			caseTypes: [] as CaseType[],
			currentCaseType: "patient",
			onChange,
			onEditCondition: () => {},
		};
		const view = render(
			<SearchInputEditor value={base} siblings={[base]} {...props} />,
		);

		expect(screen.queryByText("Starting value")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /add a starting value/i }),
		).toBeNull();

		const legacy = { ...base, default: today() };
		view.rerender(
			<SearchInputEditor value={legacy} siblings={[legacy]} {...props} />,
		);
		const removeLegacyStartingValue = screen.getByRole("button", {
			name: /remove the incompatible starting value/i,
		});
		expect(removeLegacyStartingValue.className).toContain("bg-destructive");
		fireEvent.click(removeLegacyStartingValue);
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("default");
	});

	it("replaces an incompatible match and starting value only after confirmation", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000151"),
			"visit_date",
			"Visit date",
			"text",
			"visit_date",
			{
				mode: { kind: "phonetic" },
				default: term(literal("yesterday")),
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
							{
								name: "visit_date",
								label: "Visit date",
								data_type: "date",
							},
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={() => {}}
			/>,
		);

		const typeTrigger = screen.getByRole("button", {
			name: /search field 1 type: text box/i,
		});
		fireEvent.click(typeTrigger);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /date picker/i }),
		);
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Change" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(typeTrigger);
		});
		await settleBaseUiTransitions();

		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({
			kind: "simple",
			type: "date",
		});
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("mode");
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("default");
	});

	it("preserves a compatible saved match and starting value without interruption", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000147"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
			{
				mode: { kind: "exact" },
				default: term(literal("A-100")),
			},
		);
		const onChange = vi.fn();
		const editor = (key: string) => (
			<SearchInputEditor
				key={key}
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: "Patient name", data_type: "text" },
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={() => {}}
			/>
		);
		render(editor("compatible"));

		fireEvent.click(
			screen.getByRole("button", { name: /search field 1 type: text box/i }),
		);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /^barcode/i }),
		);

		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({
			type: "barcode",
			mode: { kind: "exact" },
			default: input.default,
		});
	});

	it("keeps binding-driven match and default changes behind one consequence dialog", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000148"),
			"birth_date",
			"Birth date",
			"date",
			"birth_date",
			{ mode: rangeMode(), default: today() },
		);
		const onChange = vi.fn();
		const editor = (key: string) => (
			<SearchInputEditor
				key={key}
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[
					{
						name: "patient",
						properties: [
							{ name: "birth_date", label: "Birth date", data_type: "date" },
							{ name: "case_name", label: "Case name", data_type: "text" },
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={() => {}}
			/>
		);
		const view = render(editor("cancel"));

		const bindingTrigger = screen.getByRole("combobox", {
			name: "Search field 1 information",
		});
		fireEvent.click(bindingTrigger);
		fireEvent.click(
			await screen.findByRole("option", { name: /Case name.*Text/i }),
		);

		let dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Change to “Case name”?",
			}),
		).toBeDefined();
		expect(dialog.textContent).toContain(
			"“Between dates” will become “Similar spelling”. The starting value will be removed because Case name can’t use it. You can undo this change.",
		);
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onChange).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(bindingTrigger);
		view.rerender(editor("replace"));
		await settleBaseUiTransitions();
		const replacementBindingTrigger = screen.getByRole("combobox", {
			name: "Search field 1 information",
		});
		fireEvent.click(replacementBindingTrigger);
		fireEvent.click(
			await screen.findByRole("option", { name: /Case name.*Text/i }),
		);
		dialog = await screen.findByRole("alertdialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Change" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(replacementBindingTrigger);
		});

		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({
			kind: "simple",
			property: "case_name",
			type: "text",
			mode: { kind: "fuzzy" },
		});
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("default");
	});

	it("explains the unsupported range-to-custom transition before replacing it", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000149"),
			"visit_range",
			"Visit range",
			"date-range",
			"visit_date",
			{ mode: rangeMode() },
		);
		const onChange = vi.fn();
		const onEditCondition = vi.fn();
		const editor = (key: string) => (
			<SearchInputEditor
				key={key}
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={onEditCondition}
			/>
		);
		const view = render(editor("cancel"));

		const matchTrigger = screen.getByRole("button", {
			name: /search field 1 match: between dates/i,
		});
		fireEvent.click(matchTrigger);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /custom condition/i }),
		);

		let dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Replace “Between dates” with a custom condition?",
			}),
		).toBeDefined();
		expect(dialog.textContent).toContain(
			"The new condition will start with “Exact value” because it can’t keep both dates in the range.",
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(onEditCondition).not.toHaveBeenCalled();

		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(document.activeElement).toBe(matchTrigger);
		await settleBaseUiTransitions();
		view.rerender(editor("replace"));
		const replacementMatchTrigger = screen.getByRole("button", {
			name: /search field 1 match: between dates/i,
		});
		fireEvent.click(replacementMatchTrigger);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /custom condition/i }),
		);
		dialog = await screen.findByRole("alertdialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(replacementMatchTrigger);
		});
		await settleBaseUiTransitions();
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({ kind: "advanced" });
		expect(onEditCondition).toHaveBeenCalledOnce();
	});

	it("names the authored multi-select quantifier in the custom consequence", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000150"),
			"services",
			"Services",
			"text",
			"services",
			{ mode: multiSelectContainsMode("all") },
		);
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: /search field 1 match: includes options/i,
			}),
		);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /custom condition/i }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Replace “All chosen options” with a custom condition?",
			}),
		).toBeDefined();
		expect(dialog.textContent).toContain(
			"can’t keep the full list from “All chosen options”",
		);
	});

	it("keeps an imported custom condition when standard replacement is canceled", async () => {
		const importedPredicate = eq(
			prop("patient", "status"),
			term(sessionContext("userid")),
		);
		const input = advancedSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000054"),
			"status_search",
			"Status",
			"text",
			importedPredicate,
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
							{ name: "status", label: "Status", data_type: "text" },
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={() => {}}
			/>,
		);

		const matchTrigger = screen.getByRole("button", {
			name: /search field 1 match/i,
		});
		fireEvent.click(matchTrigger);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /exact value/i }),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Replace the custom condition with “Exact value”?",
			}),
		).toBeDefined();
		expect(
			within(dialog).getByText(
				/Some parts of the custom condition don’t fit “Exact value” and will be removed\. You can undo this change\./,
			),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(matchTrigger);
		});
		expect(onChange).not.toHaveBeenCalled();
		expect(input.predicate).toEqual(importedPredicate);
	});

	it("replaces an imported custom condition only after explicit confirmation", async () => {
		const importedPredicate = eq(
			prop("patient", "status"),
			term(sessionContext("userid")),
		);
		const input = advancedSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000055"),
			"status_search",
			"Status",
			"date",
			importedPredicate,
			{ default: today() },
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
							{ name: "status", label: "Status", data_type: "text" },
						],
					} as CaseType,
				]}
				currentCaseType="patient"
				onChange={onChange}
				onEditCondition={() => {}}
			/>,
		);

		const matchTrigger = screen.getByRole("button", {
			name: /search field 1 match/i,
		});
		fireEvent.click(matchTrigger);
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: /between dates/i }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", {
				name: "Replace the custom condition with “Exact value”?",
			}),
		).toBeDefined();
		expect(dialog.textContent).toContain(
			"“Between dates” can’t search Case status (open or closed), so the replacement will use “Exact value”.",
		);
		const footer = within(dialog)
			.getByRole("button", { name: "Replace" })
			.closest('[data-slot="alert-dialog-footer"]');
		expect(footer?.className).toContain("flex-row");
		expect(dialog.textContent).toContain(
			"The starting value will also be removed because Text box can’t use it.",
		);

		fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(matchTrigger);
		});
		await settleBaseUiTransitions();
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange.mock.calls[0]?.[0]).toMatchObject({
			kind: "simple",
			property: "status",
			type: "text",
		});
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("predicate");
		expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("default");
		expect(input.predicate).toEqual(importedPredicate);
	});

	it("keeps the unsupported choice-list field type out of normal authoring", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000048"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /search field 1 type/i }),
		);
		await screen.findByRole("menuitemradio", { name: /text box/i });
		expect(
			screen.queryByRole("menuitemradio", { name: /choice list/i }),
		).toBeNull();
	});

	it("shows a saved choice list only as a legacy repair state", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000049"),
			"status",
			"Status",
			"select",
			"status",
		);
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /search field 1 type/i }),
		);
		const legacyType = await screen.findByRole("menuitemradio", {
			name: /choice list/i,
		});
		expect(legacyType.hasAttribute("data-disabled")).toBe(true);
		expect(
			screen.getByText(
				/choose another type because this saved field isn’t supported/i,
			),
		).toBeDefined();
	});

	it("only foregrounds the condition name when it needs attention", () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000052"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		const duplicate = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000053"),
			"case_name",
			"Another patient name",
			"text",
			"case_name",
		);
		const view = render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		expect(screen.queryByText("Name used in other conditions")).toBeNull();
		view.rerender(
			<SearchInputEditor
				value={duplicate}
				index={1}
				siblings={[input, duplicate]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		expect(screen.getByText("Name used in other conditions")).toBeDefined();
		expect(
			screen.getByRole("textbox", {
				name: "Search field 2 name used in other conditions",
			}),
		).toBeDefined();
		expect(screen.queryByText("Reference name")).toBeNull();
	});

	it("opens a search field's additional settings from the keyboard", () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000054"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "More settings" });
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.getAttribute("data-slot")).toBe("collapsible-trigger");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Name used in other conditions")).toBeNull();

		pressFocusedButtonWithEnter(trigger);

		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(trigger);
		expect(
			screen
				.getByText("Name used in other conditions")
				.closest('[data-slot="collapsible-content"]'),
		).not.toBeNull();
	});

	it("describes forgiving match modes by their outcome", async () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000050"),
			"case_name",
			"Patient name",
			"text",
			"case_name",
		);
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /search field 1 match/i }),
		);
		expect(
			await screen.findByRole("menuitemradio", { name: /similar spelling/i }),
		).toBeDefined();
		expect(screen.queryByText(/^Fuzzy$/)).toBeNull();

		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
		await waitFor(() =>
			expect(
				screen.queryByRole("menuitemradio", { name: /similar spelling/i }),
			).toBeNull(),
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});

	it("calls forgiving date matching Flexible date", () => {
		const input = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000051"),
			"visit_date",
			"Visit date",
			"date",
			"visit_date",
			{ mode: fuzzyDateMode() },
		);
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={() => {}}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: /search field 1 match: Flexible date/i,
			}),
		).toBeDefined();
	});

	it("summarizes a custom search match in the inspector", () => {
		const input = advancedSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000047"),
			"case_name",
			"Patient name",
			"text",
			matchAll(),
		);
		const onEditCondition = vi.fn();
		render(
			<SearchInputEditor
				value={input}
				index={0}
				siblings={[input]}
				caseTypes={[]}
				currentCaseType="patient"
				onChange={() => {}}
				onEditCondition={onEditCondition}
			/>,
		);

		expect(screen.getByText("Every case matches")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Edit condition" }));
		expect(onEditCondition).toHaveBeenCalledOnce();
	});

	it("creates a friendly Search button condition and opens its center editor", async () => {
		const onChange = vi.fn();
		const onEditDisplayCondition = vi.fn();
		render(
			<SearchPanelInspectorBody
				value={undefined}
				onChange={onChange}
				caseTypes={SEARCH_CONDITION_CASE_TYPES}
				currentCaseType="patient"
				knownInputs={[{ name: "query", data_type: "text" }]}
				onEditDisplayCondition={onEditDisplayCondition}
			/>,
		);

		const moreSettings = screen.getByRole("button", { name: "More settings" });
		fireEvent.click(moreSettings);
		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		expect(onChange).toHaveBeenCalledWith({
			searchButtonDisplayCondition: FIRST_SEARCH_CONDITION,
		});
		expect(onEditDisplayCondition).toHaveBeenCalledOnce();

		fireEvent.click(moreSettings);
		await settleBaseUiTransitions();
	});

	it("creates the same friendly first condition for a zero-input Search action", async () => {
		const onChange = vi.fn();
		const onEditDisplayCondition = vi.fn();
		render(
			<SearchPanelInspectorBody
				value={undefined}
				onChange={onChange}
				caseTypes={SEARCH_CONDITION_CASE_TYPES}
				currentCaseType="patient"
				knownInputs={[{ name: "query", data_type: "text" }]}
				hasVisibleSearchScreen={false}
				onEditDisplayCondition={onEditDisplayCondition}
			/>,
		);

		const moreSettings = screen.getByRole("button", { name: "More settings" });
		fireEvent.click(moreSettings);
		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		expect(onChange).toHaveBeenCalledWith({
			searchButtonDisplayCondition: FIRST_SEARCH_CONDITION,
		});
		expect(onEditDisplayCondition).toHaveBeenCalledOnce();

		// The production callback navigates away and unmounts the inspector. This
		// isolated test keeps it mounted, so close the Base UI disclosure and drain
		// its exit frames before teardown instead of leaking animation work into the
		// next test.
		fireEvent.click(moreSettings);
		await settleBaseUiTransitions();
	});

	it("gives complex Search conditions a full-width workbench and a clear return", () => {
		const onBack = vi.fn();
		render(
			<SearchConditionCanvas
				context={{ kind: "input", label: "Patient name" }}
				value={matchAll()}
				onChange={() => {}}
				onBack={onBack}
				caseTypes={[]}
				currentCaseType="patient"
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Match cases for Patient name" }),
		).toBeDefined();
		expect(
			screen.getByRole("heading", { name: "Cases match when" }),
		).toBeDefined();
		expect(
			screen.queryByText(
				"Open a group to work on its conditions without losing the rest",
			),
		).toBeNull();
		const backButton = screen.getByRole("button", { name: "Back to Search" });
		expect(backButton.className).toContain("h-11");
		expect(backButton.hasAttribute("data-inspector-return-focus")).toBe(true);
		expect(document.activeElement).toBe(backButton);
		fireEvent.click(backButton);
		expect(onBack).toHaveBeenCalledOnce();
	});

	it("uses Search-action language when no Search fields exist", () => {
		render(
			<SearchConditionCanvas
				context={{ kind: "search-button" }}
				value={matchAll()}
				onChange={() => {}}
				onBack={() => {}}
				caseTypes={[]}
				currentCaseType="patient"
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "When Search is available" }),
		).toBeDefined();
		expect(
			screen.getByRole("heading", {
				name: "Search is available when",
			}),
		).toBeDefined();
		expect(
			screen.getByText("Choose when the Search action can run"),
		).toBeDefined();
	});

	it("shows the real search-screen defaults as editable values", () => {
		render(
			<SearchPanelInspectorBody
				value={undefined}
				onChange={() => {}}
				caseTypes={[]}
				currentCaseType="patient"
				onEditDisplayCondition={() => {}}
			/>,
		);

		const title = screen.getByRole("textbox", { name: "Title" });
		const buttonLabel = screen.getByRole("textbox", {
			name: "Search button label",
		});
		expect((title as HTMLInputElement).value).toBe("Search");
		expect((buttonLabel as HTMLInputElement).value).toBe("Search");
		expect(title.getAttribute("placeholder")).toBeNull();
		expect(buttonLabel.getAttribute("placeholder")).toBeNull();
	});

	it("clearing search-screen copy restores its visible default", () => {
		const onChange = vi.fn();
		const view = render(
			<SearchPanelInspectorBody
				value={{ searchScreenTitle: "Find clients" }}
				onChange={onChange}
				caseTypes={[]}
				currentCaseType="patient"
				onEditDisplayCondition={() => {}}
			/>,
		);
		const title = screen.getByRole("textbox", { name: "Title" });

		fireEvent.focus(title);
		fireEvent.change(title, { target: { value: "" } });
		fireEvent.blur(title);
		expect(onChange).toHaveBeenLastCalledWith({});

		view.rerender(
			<SearchPanelInspectorBody
				value={{}}
				onChange={onChange}
				caseTypes={[]}
				currentCaseType="patient"
				onEditDisplayCondition={() => {}}
			/>,
		);
		expect(
			(
				screen.getByRole("textbox", {
					name: "Title",
				}) as HTMLInputElement
			).value,
		).toBe("Search");
	});

	it("does not create search settings when an untouched default is cleared", () => {
		const onChange = vi.fn();
		render(
			<SearchPanelInspectorBody
				value={undefined}
				onChange={onChange}
				caseTypes={[]}
				currentCaseType="patient"
				onEditDisplayCondition={() => {}}
			/>,
		);
		const title = screen.getByRole("textbox", { name: "Title" });

		fireEvent.focus(title);
		fireEvent.change(title, { target: { value: "" } });
		fireEvent.blur(title);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("does not persist canonical search-screen defaults as overrides", () => {
		const onChange = vi.fn();
		render(
			<SearchPanelInspectorBody
				value={{ searchButtonLabel: "Find cases" }}
				onChange={onChange}
				caseTypes={[]}
				currentCaseType="patient"
				onEditDisplayCondition={() => {}}
			/>,
		);
		const buttonLabel = screen.getByRole("textbox", {
			name: "Search button label",
		});

		fireEvent.focus(buttonLabel);
		fireEvent.change(buttonLabel, { target: { value: "Search" } });
		fireEvent.blur(buttonLabel);
		expect(onChange).toHaveBeenLastCalledWith({});
	});

	it("keeps the Search button label concise without truncating the draft", () => {
		const onChange = vi.fn();
		render(
			<SearchPanelInspectorBody
				value={undefined}
				onChange={onChange}
				caseTypes={[]}
				currentCaseType="patient"
				onEditDisplayCondition={() => {}}
			/>,
		);
		const buttonLabel = screen.getByRole("textbox", {
			name: "Search button label",
		});
		const longLabel = "Find every possible matching client case right now";

		fireEvent.focus(buttonLabel);
		fireEvent.change(buttonLabel, { target: { value: longLabel } });
		fireEvent.blur(buttonLabel);

		expect(onChange).not.toHaveBeenCalled();
		expect((buttonLabel as HTMLInputElement).value).toBe(longLabel);
		expect(
			screen.getByRole("alert").textContent?.includes("32 characters or fewer"),
		).toBe(true);
	});

	it("keeps Cases available out of Search", () => {
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
			screen.getByRole("heading", { name: "Search", level: 1 }),
		).toBeDefined();
		expect(
			screen.getByRole("heading", { name: "Search fields" }),
		).toBeDefined();
		expect(
			screen.queryByRole("heading", { name: "Cases available" }),
		).toBeNull();
		expect(screen.queryByText(/example result|example value/i)).toBeNull();
	});
});
