// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asUuid,
	type CaseType,
	type Column,
	calculatedColumn,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";
import { CaseOrderingComposer } from "../SortPriorityStack";
import { resolveSortedColumns } from "../sortPriority";

const session = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => session.canEdit,
}));

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: "Patient name", data_type: "text" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
		{ name: "age", label: "Age", data_type: "int" },
	],
};

function column(
	uuidSuffix: string,
	field: string,
	header: string,
	order: string,
	sort?: Column["sort"],
): Column {
	return {
		uuid: asUuid(`00000000-0000-4000-8000-${uuidSuffix.padStart(12, "0")}`),
		kind: "plain",
		field,
		header,
		order,
		...(sort === undefined ? {} : { sort }),
	};
}

const NAME = column("1", "case_name", "Patient name", "a", {
	direction: "asc",
	priority: 0,
});
const DOB = column("2", "dob", "Date of birth", "b");
const AGE = column("3", "age", "Age", "c", {
	direction: "desc",
	priority: 1,
});

function ControlledComposer({
	initial,
	onChange,
}: {
	readonly initial: readonly Column[];
	readonly onChange: (next: readonly Column[]) => void;
}) {
	const [value, setValue] = useState(initial);
	return (
		<CaseOrderingComposer
			value={value}
			caseType={PATIENT}
			caseTypes={[PATIENT]}
			onChange={(next) => {
				onChange(next);
				setValue([...next]);
			}}
		/>
	);
}

async function settleMenuAnimation() {
	await act(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
}

/** Happy DOM does not synthesize a button's browser-owned click from Enter. */
function pressFocusedButtonWithEnter(button: HTMLElement): void {
	button.focus();
	fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
	fireEvent.click(button, { detail: 0 });
	fireEvent.keyUp(button, { key: "Enter", code: "Enter" });
}

describe("CaseOrderingComposer", () => {
	beforeEach(() => {
		session.canEdit = true;
	});

	it("adds, changes, and removes a natural type-aware ordering rule", async () => {
		const onChange = vi.fn();
		render(
			<ControlledComposer initial={[NAME, DOB, AGE]} onChange={onChange} />,
		);

		expect(
			screen.queryByRole("combobox", { name: "Add to default order" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		fireEvent.click(
			screen.getByRole("combobox", { name: "Add to default order" }),
		);
		fireEvent.click(screen.getByRole("option", { name: "Date of birth" }));

		const dateRule = screen
			.getByRole("button", {
				name: "Remove Date of birth from default order",
			})
			.closest<HTMLElement>("[data-case-ordering-rule]");
		expect(dateRule).not.toBeNull();
		if (dateRule === null) throw new Error("Date ordering rule was not found");
		expect(within(dateRule).getByText("Earliest first")).toBeDefined();
		expect(onChange).toHaveBeenCalledTimes(1);

		fireEvent.click(
			within(dateRule).getByRole("button", {
				name: /change direction for date of birth.*earliest first/i,
			}),
		);
		expect(
			screen
				.getByRole("menuitemradio", { name: "Earliest first" })
				.getAttribute("aria-checked"),
		).toBe("true");
		fireEvent.click(
			screen.getByRole("menuitemradio", { name: "Latest first" }),
		);

		expect(
			onChange.mock.calls
				.at(-1)?.[0]
				.find((entry: Column) => entry.uuid === DOB.uuid)?.sort,
		).toEqual({ direction: "desc", priority: 2 });

		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove Date of birth from default order",
			}),
		);
		expect(
			onChange.mock.calls
				.at(-1)?.[0]
				.find((entry: Column) => entry.uuid === DOB.uuid)?.sort,
		).toBeUndefined();
		expect(onChange).toHaveBeenCalledTimes(3);

		await settleMenuAnimation();
	});

	it("sorts by case information without adding it to Results or Details", () => {
		const onChange = vi.fn();
		render(<ControlledComposer initial={[NAME]} onChange={onChange} />);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		fireEvent.click(
			screen.getByRole("combobox", { name: "Add to default order" }),
		);
		expect(screen.queryByText(/hidden|column/i)).toBeNull();
		fireEvent.click(screen.getByRole("option", { name: "Age" }));

		const next = onChange.mock.calls.at(-1)?.[0] as readonly Column[];
		const age = next.find((entry) =>
			entry.kind === "calculated" ? false : entry.field === "age",
		);
		expect(age).toMatchObject({
			kind: "plain",
			field: "age",
			header: "Age",
			visibleInList: false,
			visibleInDetail: false,
			sort: { direction: "asc", priority: 1 },
		});
		expect(age?.order).toEqual(expect.any(String));
		expect(next).toHaveLength(2);
	});

	it("opens and closes the first-use order editor from its keyboard trigger", () => {
		render(
			<CaseOrderingComposer
				value={[DOB]}
				caseType={PATIENT}
				onChange={() => {}}
			/>,
		);

		expect(
			screen.queryByRole("combobox", { name: "Add to default order" }),
		).toBeNull();
		const trigger = screen.getByRole("button", { name: "Set default order" });
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.getAttribute("data-slot")).toBe("collapsible-trigger");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");

		pressFocusedButtonWithEnter(trigger);

		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(trigger);
		expect(trigger.getAttribute("aria-label")).toBe(
			"Finish editing default order",
		);
		expect(
			screen.getByText(/choose what decides which cases appear first/i),
		).toBeDefined();
		expect(
			screen
				.getByText(/choose what decides which cases appear first/i)
				.closest('[data-slot="collapsible-content"]'),
		).not.toBeNull();
		expect(
			screen.getByRole("combobox", { name: "Add to default order" }),
		).toBeDefined();

		pressFocusedButtonWithEnter(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(trigger);
		expect(
			screen.queryByText(/choose what decides which cases appear first/i),
		).toBeNull();
	});

	it("uses First and Then copy and announces keyboard reordering", () => {
		const onChange = vi.fn();
		const dateSorted: Column = {
			...DOB,
			sort: { direction: "asc", priority: 2 },
		};
		render(
			<ControlledComposer
				initial={[NAME, AGE, dateSorted]}
				onChange={onChange}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		expect(screen.getByText("First")).toBeDefined();
		expect(screen.getAllByText("Then")).toHaveLength(2);
		expect(screen.getByText("A to Z")).toBeDefined();
		expect(screen.getByText("Highest first")).toBeDefined();
		expect(screen.getByText("Earliest first")).toBeDefined();

		fireEvent.keyDown(
			screen.getByRole("button", { name: /^move patient name\./i }),
			{ key: "ArrowDown" },
		);

		const latest = onChange.mock.calls.at(-1)?.[0] as readonly Column[];
		expect(
			[...latest]
				.filter((entry) => entry.sort !== undefined)
				.sort((a, b) => (a.sort?.priority ?? 0) - (b.sort?.priority ?? 0))
				.map((entry) => entry.uuid),
		).toEqual([AGE.uuid, NAME.uuid, DOB.uuid]);
		expect(screen.getByRole("status").textContent).toBe(
			"Patient name now comes after Age",
		);

		fireEvent.keyDown(
			screen.getByRole("button", { name: /^move patient name\./i }),
			{ key: "Home" },
		);
		expect(screen.getByRole("status").textContent).toBe(
			"Patient name now comes first",
		);

		fireEvent.keyDown(
			screen.getByRole("button", { name: /^move patient name\./i }),
			{ key: "End" },
		);
		expect(screen.getByRole("status").textContent).toBe(
			"Patient name now comes after Date of birth",
		);

		fireEvent.keyDown(
			screen.getByRole("button", { name: /^move patient name\./i }),
			{ key: "ArrowUp" },
		);
		expect(screen.getByRole("status").textContent).toBe(
			"Patient name now comes after Age",
		);
	});

	it("groups expanded default-order rules as one named ordered list", () => {
		render(
			<CaseOrderingComposer
				value={[NAME, AGE]}
				caseType={PATIENT}
				onChange={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		const list = screen.getByRole("list", { name: "Default order" });
		const items = within(list).getAllByRole("listitem");
		expect(list.tagName).toBe("OL");
		expect(items).toHaveLength(2);
		expect(Array.from(list.children)).toEqual(items);
		expect(within(items[0]).getByText("First")).toBeDefined();
		expect(within(items[0]).getByText("Patient name")).toBeDefined();
		expect(within(items[1]).getByText("Then")).toBeDefined();
		expect(within(items[1]).getByText("Age")).toBeDefined();
	});

	it("stacks each order rule before its container has room for one line", () => {
		const { container } = render(
			<CaseOrderingComposer
				value={[NAME, AGE]}
				caseType={PATIENT}
				onChange={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		const bodies = container.querySelectorAll<HTMLElement>(
			"[data-case-ordering-rule-body]",
		);
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body.classList.contains("flex-col")).toBe(true);
			expect(body.classList.contains("@min-[28rem]:flex-row")).toBe(true);
		}
		for (const direction of container.querySelectorAll<HTMLElement>(
			"[data-case-ordering-direction]",
		)) {
			expect(direction.classList.contains("w-full")).toBe(true);
			expect(direction.classList.contains("@min-[28rem]:w-auto")).toBe(true);
		}
	});

	it("moves focus to the adjacent rule, then Add to order, after removal", async () => {
		render(
			<ControlledComposer initial={[NAME, AGE, DOB]} onChange={() => {}} />,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove Patient name from default order",
			}),
		);

		const ageHandle = screen.getByRole("button", { name: /^move age\./i });
		await waitFor(() => expect(document.activeElement).toBe(ageHandle));

		fireEvent.click(
			screen.getByRole("button", { name: "Remove Age from default order" }),
		);
		const addToOrder = screen.getByRole("combobox", {
			name: "Add to default order",
		});
		await waitFor(() => expect(document.activeElement).toBe(addToOrder));
	});

	it("uses the calculated result type for friendly directions", () => {
		const score = {
			...calculatedColumn(
				asUuid("00000000-0000-4000-8000-000000000090"),
				"Risk score",
				term(prop("patient", "age")),
			),
			sort: { direction: "asc" as const, priority: 0 },
		};
		const nextVisit = {
			...calculatedColumn(
				asUuid("00000000-0000-4000-8000-000000000091"),
				"Calculated visit date",
				term(prop("patient", "dob")),
			),
			sort: { direction: "desc" as const, priority: 1 },
		};

		render(
			<CaseOrderingComposer
				value={[score, nextVisit]}
				caseType={PATIENT}
				caseTypes={[PATIENT]}
				onChange={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		expect(screen.getByText("Lowest first")).toBeDefined();
		expect(screen.getByText("Latest first")).toBeDefined();
		expect(screen.queryByText("A to Z")).toBeNull();
	});

	it("uses canonical fallback labels for legacy default-order fields", () => {
		const legacyCaseType: CaseType = {
			name: "legacy_patient",
			properties: [
				{ name: "case_name", label: "case_name", data_type: "text" },
				{ name: "external_id", label: "external_id", data_type: "text" },
				{ name: "date_opened", label: "date_opened", data_type: "datetime" },
			],
		};
		const legacyColumns = [
			column("101", "name", "", "a", { direction: "asc", priority: 0 }),
			column("102", "external-id", "", "b", {
				direction: "asc",
				priority: 1,
			}),
			column("103", "date-opened", "", "c", {
				direction: "desc",
				priority: 2,
			}),
		];

		render(
			<CaseOrderingComposer
				value={legacyColumns}
				caseType={legacyCaseType}
				onChange={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		expect(screen.getByText("Case name")).toBeDefined();
		expect(screen.getByText("External ID")).toBeDefined();
		expect(screen.getByText("Date opened")).toBeDefined();
		expect(screen.getByText("Latest first")).toBeDefined();
		expect(screen.queryByText("External id")).toBeNull();
		expect(screen.queryByText("Name")).toBeNull();
	});

	it("breaks equal priorities by the independent Results arrangement", () => {
		const laterInResults = {
			...NAME,
			listOrder: "z",
			sort: { direction: "asc" as const, priority: 0 },
		};
		const firstInResults = {
			...AGE,
			listOrder: "a",
			sort: { direction: "desc" as const, priority: 0 },
		};

		expect(
			resolveSortedColumns([laterInResults, firstInResults]).map(
				(column) => column.uuid,
			),
		).toEqual([firstInResults.uuid, laterInResults.uuid]);
	});

	it("keeps a complex default order scannable until the author opens it", () => {
		const extras = [
			column("201", "one", "First extra", "d", {
				direction: "asc",
				priority: 2,
			}),
			column("202", "two", "Second extra", "e", {
				direction: "asc",
				priority: 3,
			}),
			column("203", "three", "Third extra", "f", {
				direction: "asc",
				priority: 4,
			}),
		];

		render(
			<CaseOrderingComposer
				value={[NAME, AGE, ...extras]}
				caseType={PATIENT}
				onChange={() => {}}
			/>,
		);

		expect(screen.getByText(/3 more items break ties\.$/)).toBeDefined();
		expect(screen.queryByText("First extra")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /move first extra/i }),
		).toBeNull();
	});

	it("wraps essential field names in the expanded order", () => {
		const longLabel =
			"Preferred client name as recorded during the most recent household visit";
		render(
			<CaseOrderingComposer
				value={[{ ...NAME, header: longLabel }]}
				caseType={PATIENT}
				onChange={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		const label = screen.getByText(longLabel);
		expect(label.className).toContain("break-words");
		expect(label.className).toContain("whitespace-normal");
		expect(label.className).not.toContain("truncate");
	});

	it("contains long authored names and search feedback inside the Add menu", async () => {
		const longLabel =
			"Preferred client name as recorded during the most recent household visit and follow-up";
		const longQuery = "uninterrupted-search-text-".repeat(24);
		render(
			<CaseOrderingComposer
				value={[NAME, { ...DOB, header: longLabel }]}
				caseType={PATIENT}
				onChange={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		fireEvent.click(
			screen.getByRole("combobox", { name: "Add to default order" }),
		);

		const option = screen.getByRole("option", { name: longLabel });
		const optionLabel = within(option).getByText(longLabel);
		expect(option.className).toContain("min-w-0");
		expect(option.className).toContain("whitespace-normal");
		expect(optionLabel.className).toContain("break-words");
		expect(optionLabel.className).toContain("whitespace-normal");

		const search = screen.getByRole("combobox", {
			name: "Search case information",
		});
		fireEvent.change(search, { target: { value: longQuery } });
		expect(screen.getByText("No matching information")).toBeDefined();
		expect(screen.getByText("Try a different search")).toBeDefined();
		expect(screen.queryByText(new RegExp(longQuery.slice(0, 32)))).toBeNull();

		fireEvent.keyDown(search, { key: "Escape" });
		await settleMenuAnimation();
	});

	it("keeps the add action label stable when every result is already used", async () => {
		const dateSorted: Column = {
			...DOB,
			sort: { direction: "asc", priority: 2 },
		};
		render(
			<CaseOrderingComposer
				value={[NAME, AGE, dateSorted]}
				caseType={PATIENT}
				onChange={() => {}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Change default order" }),
		);
		const add = screen.getByRole("combobox", {
			name: "Add to default order",
		});
		expect(add.textContent).toContain("Add to order");
		expect(add.hasAttribute("disabled")).toBe(true);
		expect(
			screen.getByText(
				"All available case information is already in the default order",
			),
		).toBeDefined();
		await settleMenuAnimation();
	});

	it("shows the ordering without edit affordances to viewers", async () => {
		session.canEdit = false;
		const viewerDate: Column = {
			...DOB,
			sort: { direction: "asc", priority: 2 },
		};
		render(
			<CaseOrderingComposer
				value={[NAME, AGE, viewerDate]}
				caseType={PATIENT}
				onChange={() => {}}
			/>,
		);

		expect(screen.queryByText("Default order")).toBeNull();
		expect(
			screen.getByText(
				/Cases are sorted first by Patient name from A to Z, then by Age with the highest value first/,
			),
		).toBeDefined();
		fireEvent.click(
			screen.getByRole("button", { name: "View full default order" }),
		);
		expect(screen.getByText("Date of birth")).toBeDefined();
		expect(screen.getByText("Earliest first")).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Close default order details" }),
		).toBeDefined();
		expect(
			screen.queryByRole("combobox", { name: "Add to default order" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /move patient name/i }),
		).toBeNull();
		expect(
			screen.queryByRole("button", {
				name: /remove patient name from default order/i,
			}),
		).toBeNull();
		expect(
			screen.queryByRole("button", {
				name: /change direction for patient name/i,
			}),
		).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "Close default order details" }),
		);
		expect(screen.queryByText("Date of birth")).toBeNull();
		expect(
			screen.getByRole("button", { name: "View full default order" }),
		).toBeDefined();
		await settleMenuAnimation();
	});
});
