// @vitest-environment happy-dom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	eq,
	exists,
	input,
	literal,
	matchAll,
	missing,
	not,
	or,
	type Predicate,
	prop,
	relationStep,
	whenInput,
} from "@/lib/domain/predicate";
import { comparisonDefault } from "../cards/ComparisonCard";
import { PredicateWorkbench } from "../PredicateWorkbench";

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "name", label: "Patient name", data_type: "text" },
			{ name: "region", label: "Region", data_type: "text" },
		],
	},
	{
		name: "household",
		properties: [{ name: "region", label: "Region", data_type: "text" }],
	},
];

const KNOWN_INPUTS = [
	{ name: "query", label: "Client search", data_type: "text" },
] as const;
const NORTH = eq(prop("patient", "region"), literal("North"));
const SOUTH = eq(prop("patient", "region"), literal("South"));
const NEW_PEER = comparisonDefault("eq", {
	caseTypes: CASE_TYPES,
	currentCaseType: "patient",
	knownInputs: KNOWN_INPUTS,
});
const VIA = ancestorPath(relationStep("parent", "household"));

function renderWorkbench(value: Predicate) {
	const onChange = vi.fn();
	render(
		<PredicateWorkbench
			value={value}
			onChange={onChange}
			caseTypes={CASE_TYPES}
			currentCaseType="patient"
			knownInputs={KNOWN_INPUTS}
		/>,
	);
	return onChange;
}

function addComparison(buttonName = "Add condition"): void {
	fireEvent.click(screen.getByRole("button", { name: buttonName }));
	fireEvent.click(
		screen.getByRole("menuitem", { name: /^Compare case information/ }),
	);
}

/** Happy DOM does not synthesize native button activation from Enter. */
function activateWithEnter(element: HTMLElement): void {
	element.focus();
	fireEvent.keyDown(element, { key: "Enter", code: "Enter" });
	fireEvent.click(element, { detail: 0 });
	fireEvent.keyUp(element, { key: "Enter", code: "Enter" });
}

function ControlledWorkbench({ initial }: { readonly initial: Predicate }) {
	const [value, setValue] = useState(initial);
	return (
		<PredicateWorkbench
			value={value}
			onChange={setValue}
			caseTypes={CASE_TYPES}
			currentCaseType="patient"
			knownInputs={KNOWN_INPUTS}
		/>
	);
}

function focusRegion(path: readonly (string | number)[]): HTMLElement {
	const id = JSON.stringify(path);
	const region = [
		...document.querySelectorAll<HTMLElement>("[data-workbench-focus-id]"),
	].find((candidate) => candidate.dataset.workbenchFocusId === id);
	if (region === undefined) throw new Error(`Missing focus region for ${id}`);
	return region;
}

function ruleFocusTarget(path: readonly (string | number)[]): HTMLElement {
	const id = JSON.stringify(path);
	const target = [
		...document.querySelectorAll<HTMLElement>("[data-rule-focus-target]"),
	].find((candidate) => candidate.dataset.ruleFocusTarget === id);
	if (target === undefined)
		throw new Error(`Missing rule focus target for ${id}`);
	return target;
}

afterEach(async () => {
	cleanup();
	// Base UI releases menu focus/scroll locks on the next macrotask.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

describe("PredicateWorkbench structural peer addition", () => {
	it("shows one concise two-row group header with a text reset action", () => {
		render(
			<PredicateWorkbench
				value={and(NORTH, SOUTH)}
				onChange={() => {}}
				onRemoveRoot={() => {}}
				removeRootLabel="Show all cases"
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
			/>,
		);

		const heading = screen.getByRole("heading", { name: "2 conditions" });
		const connector = screen.getByRole("button", {
			name: "All conditions must match",
		});
		const reset = screen.getByRole("button", { name: "Show all cases" });
		const header = heading.closest("header");
		expect(header).not.toBeNull();
		expect(header?.children).toHaveLength(2);
		expect(header?.firstElementChild?.contains(heading)).toBe(true);
		expect(header?.firstElementChild?.contains(reset)).toBe(true);
		expect(header?.firstElementChild?.querySelector("svg")).toBeNull();
		expect(connector.parentElement).toBe(header);
		expect(connector.className).toContain("w-full");
		expect(reset.querySelector("svg")).toBeNull();
		expect(reset.className).toContain("text-destructive");
		expect(screen.queryByText("All conditions match")).toBeNull();
		expect(screen.queryByText("2 conditions, all must match")).toBeNull();
	});

	it("keeps a one-condition root reset visible and destructive", () => {
		render(
			<PredicateWorkbench
				value={NORTH}
				onChange={() => {}}
				onRemoveRoot={() => {}}
				removeRootLabel="Show all cases"
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
			/>,
		);

		const reset = screen.getByRole("button", { name: "Show all cases" });
		expect(reset.textContent).toBe("Show all cases");
		expect(reset.className).toContain("text-destructive");
		expect(reset.querySelector("svg")).toBeNull();
	});

	it.each([
		[
			"all-match",
			() => and(NORTH, SOUTH),
			"and",
			"Conditions where all must match",
		],
		[
			"any-match",
			() => or(NORTH, SOUTH),
			"or",
			"Conditions where any can match",
		],
	] as const)("exposes the focused %s clauses as one named ordered list", (_label, makeValue, kind, listName) => {
		renderWorkbench(makeValue());

		const list = screen.getByRole("list", { name: listName });
		const items = within(list).getAllByRole("listitem");
		expect(list.tagName).toBe("OL");
		expect(items).toHaveLength(2);
		expect(Array.from(list.children)).toEqual(items);
		expect(items.at(0)?.contains(focusRegion([kind, 0]))).toBe(true);
		expect(items.at(1)?.contains(focusRegion([kind, 1]))).toBe(true);
		expect(
			within(list).queryByRole("button", { name: "Add condition" }),
		).toBeNull();
		expect(screen.getByRole("button", { name: "Add condition" })).toBeDefined();
	});

	it("replaces the root collection with the focused nested collection", () => {
		renderWorkbench(and(NORTH, or(SOUTH, not(NORTH))));

		const rootList = screen.getByRole("list", {
			name: "Conditions where all must match",
		});
		expect(within(rootList).getAllByRole("listitem")).toHaveLength(2);

		fireEvent.click(ruleFocusTarget(["and", 1]));

		const nestedList = screen.getByRole("list", {
			name: "Conditions where any can match",
		});
		const nestedItems = within(nestedList).getAllByRole("listitem");
		expect(nestedItems).toHaveLength(2);
		expect(Array.from(nestedList.children)).toEqual(nestedItems);
		const firstNestedItem = nestedItems.at(0);
		const secondNestedItem = nestedItems.at(1);
		if (firstNestedItem === undefined || secondNestedItem === undefined) {
			throw new Error("Expected two nested condition list items");
		}
		expect(firstNestedItem.contains(focusRegion(["and", 1, "or", 0]))).toBe(
			true,
		);
		expect(secondNestedItem.contains(focusRegion(["and", 1, "or", 1]))).toBe(
			true,
		);
		expect(
			screen.queryByRole("list", {
				name: "Conditions where all must match",
			}),
		).toBeNull();
	});

	it("keeps each Organize condition control inside its condition card", () => {
		renderWorkbench(and(NORTH, SOUTH));

		for (const path of [
			["and", 0],
			["and", 1],
		] as const) {
			const region = focusRegion(path);
			const arrange = within(region).getByRole("button", {
				name: /^Organize /,
			});
			const card = arrange.closest<HTMLElement>("[data-removal-card]");
			expect(card).not.toBeNull();
			expect(card?.contains(arrange)).toBe(true);
			expect(card?.className).toContain("@container");
			const content = card?.firstElementChild;
			expect(content?.className).toContain("@sm:pr-14");
			expect(content?.classList.contains("pr-14")).toBe(false);
			const remove = within(region).getByRole("button", {
				name: /Delete condition/,
			});
			expect(remove.parentElement?.className).toContain("@sm:contents");
			expect(
				[...(card?.querySelectorAll<HTMLElement>("div") ?? [])].some(
					(element) =>
						element.className.includes("@sm:grid-cols-[minmax(0,1fr)_auto]"),
				),
			).toBe(true);
		}
		for (const input of screen.getAllByRole("textbox", {
			name: "Text value",
		})) {
			const valueLayout = input.parentElement?.parentElement;
			expect(valueLayout?.className).toContain("grid-cols-1");
			expect(valueLayout?.className).toContain("@md:grid-cols-[auto_1fr]");
		}
	});

	it.each([
		["an ordinary condition", NORTH],
		["a condition group", and(NORTH, SOUTH)],
	] as const)("does not put whole-filter replacement states in Add condition for %s", (_label, value) => {
		renderWorkbench(value);
		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		expect(screen.queryByText("Special cases")).toBeNull();
		expect(
			screen.queryByRole("menuitem", { name: /^Always match/ }),
		).toBeNull();
		expect(screen.queryByRole("menuitem", { name: /^Never match/ })).toBeNull();
	});

	it("renders an existing sentinel as an editable rule", () => {
		renderWorkbench(matchAll());
		expect(
			screen.getByRole("button", { name: "Condition Always match" }),
		).toBeDefined();
	});

	it("explains a missing relationship without blaming search fields", () => {
		render(
			<PredicateWorkbench
				value={matchAll()}
				onChange={() => {}}
				caseTypes={[{ name: "orphan", properties: [] }]}
				currentCaseType="orphan"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		const relation = screen.getByRole("menuitem", {
			name: /^Require a related case/,
		});
		expect(relation.textContent).toContain(
			"Add a parent or child case type first",
		);
		expect(relation.textContent).not.toContain("search field");
	});

	it("uses the authored search-field label throughout the focused condition", () => {
		renderWorkbench(whenInput(input("query"), NORTH));
		expect(screen.getByText("When Client search is answered")).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Search field Client search" }),
		).toBeDefined();
		expect(screen.queryByText("Query")).toBeNull();
	});

	it.each([
		["Exclude when", () => not(NORTH)],
		["Search-answer condition", () => whenInput(input("query"), NORTH)],
		["Related case exists", () => exists(VIA)],
		["Related case is missing", () => missing(VIA)],
	] as const)("wraps %s with a new sibling without rebuilding it", (_name, makeValue) => {
		const original = makeValue();
		const onChange = renderWorkbench(original);

		addComparison();

		const next = onChange.mock.calls.at(-1)?.[0] as Predicate | undefined;
		expect(next?.kind).toBe("and");
		if (next?.kind !== "and") throw new Error("Expected an all-match group");
		expect(next.clauses).toHaveLength(2);
		expect(next.clauses[0]).toBe(original);
		expect(next.clauses[1]).toEqual(NEW_PEER);
	});

	it.each([
		["all-match", () => and(NORTH, SOUTH), "and"],
		["any-match", () => or(NORTH, SOUTH), "or"],
	] as const)("adds directly to an existing %s group", (_name, makeValue, kind) => {
		const original = makeValue();
		const onChange = renderWorkbench(original);

		addComparison();

		const next = onChange.mock.calls.at(-1)?.[0] as Predicate | undefined;
		expect(next?.kind).toBe(kind);
		if (next?.kind !== "and" && next?.kind !== "or") {
			throw new Error("Expected a logical group");
		}
		expect(next.clauses).toHaveLength(3);
		expect(next.clauses[0]).toBe(original.clauses[0]);
		expect(next.clauses[1]).toBe(original.clauses[1]);
		expect(next.clauses[2]).toEqual(NEW_PEER);
	});

	it("moves focus into a peer that replaces the add menu", async () => {
		render(<ControlledWorkbench initial={NORTH} />);

		addComparison();

		await waitFor(() => {
			expect(focusRegion(["and", 1]).contains(document.activeElement)).toBe(
				true,
			);
		});
	});

	it("moves focus into a peer appended to an existing group", async () => {
		render(<ControlledWorkbench initial={and(NORTH, SOUTH)} />);

		addComparison();

		await waitFor(() => {
			expect(focusRegion(["and", 2]).contains(document.activeElement)).toBe(
				true,
			);
		});
	});

	it("replaces only the focused nested structure with a sibling group", () => {
		const focused = not(SOUTH);
		const root = and(NORTH, focused);
		const onChange = renderWorkbench(root);

		fireEvent.click(ruleFocusTarget(["and", 1]));
		addComparison();

		const next = onChange.mock.calls.at(-1)?.[0] as Predicate | undefined;
		expect(next?.kind).toBe("and");
		if (next?.kind !== "and") throw new Error("Expected the root group");
		expect(next.clauses[0]).toBe(NORTH);
		const replaced = next.clauses[1];
		expect(replaced?.kind).toBe("and");
		if (replaced?.kind !== "and") {
			throw new Error("Expected a nested peer group");
		}
		expect(replaced.clauses[0]).toBe(focused);
		expect(replaced.clauses[1]).toEqual(NEW_PEER);
	});

	it("keeps complete labels available in the condition trail", () => {
		const focused = whenInput(input("query"), SOUTH);
		renderWorkbench(and(NORTH, focused));

		fireEvent.click(ruleFocusTarget(["and", 1]));

		const navigation = screen.getByRole("navigation", {
			name: "Condition location",
		});
		expect(navigation.textContent).toContain("Cases available");
		expect(navigation.textContent).toContain("When Client search is answered");
		expect(navigation.textContent).not.toMatch(/> Condition|Condition >/);
		expect(navigation.querySelector(".truncate")).toBeNull();
	});

	it("moves keyboard focus into each named editor and restores the exact opener on Back", async () => {
		render(<ControlledWorkbench initial={and(NORTH, or(SOUTH, not(NORTH)))} />);

		activateWithEnter(ruleFocusTarget(["and", 1]));
		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "Editing any condition" }),
			);
		});

		activateWithEnter(ruleFocusTarget(["and", 1, "or", 1]));
		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByRole("heading", {
					name: "Editing exclude cases when",
				}),
			);
		});

		const navigation = screen.getByRole("navigation", {
			name: "Condition location",
		});
		expect(within(navigation).getAllByRole("listitem")).toHaveLength(3);
		expect(
			navigation.querySelectorAll('[aria-current="location"]'),
		).toHaveLength(1);
		expect(navigation.textContent).toContain("Any condition");
		expect(navigation.textContent).toContain("Exclude cases when");

		activateWithEnter(
			screen.getByRole("button", { name: "Back to any condition" }),
		);
		await waitFor(() => {
			expect(document.activeElement).toBe(ruleFocusTarget(["and", 1, "or", 1]));
		});

		activateWithEnter(
			screen.getByRole("button", { name: "Back to cases available" }),
		);
		await waitFor(() => {
			expect(document.activeElement).toBe(ruleFocusTarget(["and", 1]));
		});
	});

	it("brings a nested editor to the top of the workspace and restores the prior scroll on Back", async () => {
		render(
			<div data-case-workspace-scroll-body="list">
				<ControlledWorkbench initial={and(NORTH, or(SOUTH, not(NORTH)))} />
			</div>,
		);
		const scroller = document.querySelector<HTMLElement>(
			'[data-case-workspace-scroll-body="list"]',
		);
		if (scroller === null) throw new Error("Missing workspace scroller");
		const workbench = focusRegion([]).parentElement;
		if (workbench === null) throw new Error("Missing workbench root");
		scroller.scrollTop = 900;
		scroller.getBoundingClientRect = vi.fn(() => ({ top: 100 }) as DOMRect);
		workbench.getBoundingClientRect = vi.fn(() => ({ top: -600 }) as DOMRect);

		activateWithEnter(ruleFocusTarget(["and", 1]));
		await waitFor(() => {
			expect(scroller.scrollTop).toBe(200);
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "Editing any condition" }),
			);
		});

		activateWithEnter(
			screen.getByRole("button", { name: "Back to cases available" }),
		);
		await waitFor(() => {
			expect(scroller.scrollTop).toBe(900);
			expect(document.activeElement).toBe(ruleFocusTarget(["and", 1]));
		});
	});

	it("returns an ancestor breadcrumb to the first branch opener", async () => {
		render(<ControlledWorkbench initial={and(NORTH, or(SOUTH, not(NORTH)))} />);
		activateWithEnter(ruleFocusTarget(["and", 1]));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "Editing any condition" }),
			),
		);
		activateWithEnter(ruleFocusTarget(["and", 1, "or", 1]));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", {
					name: "Editing exclude cases when",
				}),
			),
		);

		activateWithEnter(screen.getByRole("button", { name: "Cases available" }));
		await waitFor(() => {
			expect(document.activeElement).toBe(ruleFocusTarget(["and", 1]));
		});
	});

	it("stacks navigation and summary actions deliberately on a narrow container", () => {
		renderWorkbench(and(NORTH, or(SOUTH, not(NORTH))));
		const target = ruleFocusTarget(["and", 1]);
		const actionRow = target.parentElement;
		expect(actionRow?.className).toContain("col-span-2");
		expect(actionRow?.className).toContain("@lg:col-span-1");
		fireEvent.click(target);
		const navigation = screen.getByRole("navigation", {
			name: "Condition location",
		});
		expect(navigation.parentElement?.className).toContain("flex-col");
		expect(navigation.parentElement?.className).toContain("@sm:flex-row");
		expect(navigation.className).toContain("w-full");
	});

	it("wraps a deep condition trail instead of introducing horizontal scroll", () => {
		const householdRegion = eq(prop("household", "region"), literal("North"));
		renderWorkbench(
			and(
				NORTH,
				not(
					whenInput(
						input("query"),
						exists(VIA, and(householdRegion, not(householdRegion))),
					),
				),
			),
		);

		for (let depth = 0; depth < 5; depth += 1) {
			fireEvent.click(screen.getByRole("button", { name: /^Edit / }));
		}

		const navigation = screen.getByRole("navigation", {
			name: "Condition location",
		});
		expect(navigation.className).not.toContain("overflow-x-auto");
		const trail = navigation.firstElementChild as HTMLElement | null;
		expect(trail?.className).toContain("flex-wrap");
		expect(trail?.className).not.toContain("w-max");
		expect(navigation.querySelector(".truncate")).toBeNull();
		expect(navigation.textContent).toContain("Cases available");
		expect(navigation.textContent).toContain("Exclude cases when");
		expect(navigation.textContent).toContain("When Client search is answered");
		expect(navigation.textContent).toContain("Related case");
		expect(navigation.textContent).toContain("All conditions");
	});

	it("distinguishes a related-case condition from a sibling condition", () => {
		const original = exists(VIA);
		const onChange = renderWorkbench(original);

		expect(screen.getByRole("button", { name: "Add condition" })).toBeDefined();
		expect(
			screen.getByRole("button", {
				name: "Add condition for related cases",
			}),
		).toBeDefined();

		addComparison("Add condition for related cases");

		expect(onChange).toHaveBeenLastCalledWith(
			exists(VIA, eq(prop("household", "region"), literal(""))),
		);
	});

	it("moves focus into a newly added related-case condition", async () => {
		render(<ControlledWorkbench initial={exists(VIA)} />);

		addComparison("Add condition for related cases");

		await waitFor(() => {
			expect(
				focusRegion(["exists", "where"]).contains(document.activeElement),
			).toBe(true);
		});
	});

	it("exposes a related-case group as a clause list only after opening it", () => {
		const householdNorth = eq(prop("household", "region"), literal("North"));
		const householdSouth = eq(prop("household", "region"), literal("South"));
		renderWorkbench(exists(VIA, and(householdNorth, householdSouth)));

		expect(
			screen.queryByRole("list", {
				name: "Conditions where all must match",
			}),
		).toBeNull();
		const relatedSummary = ruleFocusTarget(["exists", "where"]);
		expect(relatedSummary.closest("li")).toBeNull();

		fireEvent.click(relatedSummary);

		const relatedGroup = screen.getByRole("list", {
			name: "Conditions where all must match",
		});
		const clauses = within(relatedGroup).getAllByRole("listitem");
		expect(clauses).toHaveLength(2);
		expect(Array.from(relatedGroup.children)).toEqual(clauses);
		const firstClause = clauses.at(0);
		const secondClause = clauses.at(1);
		if (firstClause === undefined || secondClause === undefined) {
			throw new Error("Expected two related-case condition list items");
		}
		expect(within(firstClause).getByDisplayValue("North")).toBeDefined();
		expect(within(secondClause).getByDisplayValue("South")).toBeDefined();
	});
});

describe("PredicateWorkbench deletion focus", () => {
	it("uses deterministic path-based DOM focus identities", () => {
		render(<ControlledWorkbench initial={and(NORTH, SOUTH)} />);
		const identities = [
			...document.querySelectorAll<HTMLElement>("[data-workbench-focus-id]"),
		].map((element) => element.dataset.workbenchFocusId);

		expect(identities).toContain("[]");
		expect(identities).toContain('["and",0]');
		expect(identities).toContain('["and",1]');
		expect(identities.join(" ")).not.toMatch(
			/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/i,
		);
	});

	it("keeps focus on the connector after changing how a group matches", async () => {
		render(<ControlledWorkbench initial={and(NORTH, SOUTH)} />);
		const connector = screen.getByRole("button", {
			name: "All conditions must match",
		});
		activateWithEnter(connector);
		activateWithEnter(
			await screen.findByRole("menuitemradio", {
				name: "Any condition can match",
			}),
		);

		await waitFor(() => {
			expect(connector.textContent).toContain("Any condition can match");
			expect(document.activeElement).toBe(connector);
		});
	});

	it("focuses the next condition after deleting a row", async () => {
		const third = eq(prop("patient", "name"), literal("Taylor"));
		render(<ControlledWorkbench initial={and(NORTH, SOUTH, third)} />);
		activateWithEnter(
			within(focusRegion(["and", 0])).getByRole("button", {
				name: "Delete condition",
			}),
		);

		await waitFor(() => {
			expect(focusRegion(["and", 0]).contains(document.activeElement)).toBe(
				true,
			);
		});
	});

	it("focuses the previous condition after deleting the last row", async () => {
		const third = eq(prop("patient", "name"), literal("Taylor"));
		render(<ControlledWorkbench initial={and(NORTH, SOUTH, third)} />);
		fireEvent.click(
			within(focusRegion(["and", 2])).getByRole("button", {
				name: "Delete condition",
			}),
		);

		await waitFor(() => {
			expect(focusRegion(["and", 1]).contains(document.activeElement)).toBe(
				true,
			);
		});
	});

	it("focuses the surviving condition when deleting collapses its group", async () => {
		render(<ControlledWorkbench initial={and(NORTH, SOUTH)} />);
		fireEvent.click(
			within(focusRegion(["and", 0])).getByRole("button", {
				name: "Delete condition",
			}),
		);

		await waitFor(() => {
			expect(focusRegion([]).contains(document.activeElement)).toBe(true);
		});
	});

	it("focuses the next row after deleting a nested group", async () => {
		const nested = not(NORTH);
		render(<ControlledWorkbench initial={and(nested, SOUTH)} />);
		const nestedRegion = focusRegion(["and", 0]);
		activateWithEnter(
			within(nestedRegion).getByRole("button", {
				name: /^Organize /,
			}),
		);
		activateWithEnter(
			await screen.findByRole("menuitem", { name: "Delete group" }),
		);

		await waitFor(() => {
			expect(focusRegion([]).contains(document.activeElement)).toBe(true);
		});
	});

	it("focuses the moved row after a keyboard arrange action", async () => {
		render(<ControlledWorkbench initial={and(NORTH, SOUTH)} />);
		activateWithEnter(
			within(focusRegion(["and", 0])).getByRole("button", {
				name: /^Organize /,
			}),
		);
		activateWithEnter(
			await screen.findByRole("menuitem", { name: "Move later" }),
		);

		await waitFor(() => {
			expect(focusRegion(["and", 1]).contains(document.activeElement)).toBe(
				true,
			);
		});
	});

	it("focuses the resulting group after grouping from the keyboard", async () => {
		const third = eq(prop("patient", "name"), literal("Taylor"));
		render(<ControlledWorkbench initial={and(NORTH, SOUTH, third)} />);
		activateWithEnter(
			within(focusRegion(["and", 0])).getByRole("button", {
				name: /^Organize /,
			}),
		);
		activateWithEnter(
			await screen.findByRole("menuitem", {
				name: "Let either of these conditions match",
			}),
		);

		const groupTitle = await screen.findByText("Any condition matches");
		const groupRegion = groupTitle.closest<HTMLElement>(
			"[data-workbench-focus-id]",
		);
		await waitFor(() => {
			expect(groupRegion?.contains(document.activeElement)).toBe(true);
		});
	});

	it("focuses the first released row after ungrouping from the keyboard", async () => {
		const nested = or(NORTH, SOUTH);
		const third = eq(prop("patient", "name"), literal("Taylor"));
		render(<ControlledWorkbench initial={and(nested, third)} />);
		activateWithEnter(
			within(focusRegion(["and", 0])).getByRole("button", {
				name: /^Organize /,
			}),
		);
		activateWithEnter(
			await screen.findByRole("menuitem", {
				name: "Require every condition separately",
			}),
		);

		await waitFor(() => {
			expect(focusRegion(["and", 0]).contains(document.activeElement)).toBe(
				true,
			);
		});
	});

	it("names ungrouping by the logic the parent group will use", async () => {
		const nested = and(NORTH, SOUTH);
		const third = eq(prop("patient", "name"), literal("Taylor"));
		render(<ControlledWorkbench initial={or(nested, third)} />);

		activateWithEnter(
			within(focusRegion(["or", 0])).getByRole("button", {
				name: /^Organize /,
			}),
		);
		expect(
			await screen.findByRole("menuitem", {
				name: "Let any condition match separately",
			}),
		).toBeDefined();
	});

	it("focuses the related-case add action after deleting its condition", async () => {
		const where = eq(prop("household", "region"), literal("North"));
		render(<ControlledWorkbench initial={exists(VIA, where)} />);
		fireEvent.click(
			within(focusRegion(["exists", "where"])).getByRole("button", {
				name: "Delete condition",
			}),
		);

		const addRelated = await screen.findByRole("button", {
			name: "Add condition for related cases",
		});
		await waitFor(() => expect(document.activeElement).toBe(addRelated));
	});

	it("keeps an imported related-case condition visible while its connection is repaired", () => {
		const brokenVia = ancestorPath(
			relationStep("parent", "household"),
			relationStep("host", "clinic"),
		);
		const where = eq(prop("household", "region"), literal("North"));
		renderWorkbench(exists(brokenVia, where));

		expect(screen.getByText("Is")).toBeTruthy();
		expect(
			screen.getByText(
				"This condition still applies. Fix the connection above to edit it.",
			),
		).toBeTruthy();
		expect(
			screen.queryByText(
				"Choose a valid connection before adding a related-case condition",
			),
		).toBeNull();
	});
});
