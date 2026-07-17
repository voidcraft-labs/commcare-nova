// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseListConfig, CaseType } from "@/lib/domain";
import {
	checkPredicate,
	eq,
	literal,
	matchAll,
	prop,
} from "@/lib/domain/predicate";
import { FilterInspectorBody } from "../inspector/FilterInspectorBody";

const docApi = vi.hoisted(() => ({ getState: () => ({}) }));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDocApi: () => docApi,
}));

vi.mock("@/lib/preview/engine/caseDataBindingClient", () => ({
	pickBlueprintDoc: () => ({}),
}));

vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadFilterPreviewAction: vi.fn().mockResolvedValue({ kind: "unavailable" }),
}));

const CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		properties: [{ name: "region", label: "Region", data_type: "text" }],
	},
];

const FILTERED: CaseListConfig = {
	columns: [],
	searchInputs: [],
	filter: eq(prop("patient", "region"), literal("North")),
};

/** Base UI releases dialog focus/scroll locks on the next macrotask. Tests that
 * open and close a dialog must let that cleanup run before leak detection. */
async function settleDialogTeardown(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("filter-only automatic search", () => {
	it("starts a new filter as a visible, type-valid Is condition", async () => {
		const onChange = vi.fn();
		const onClearFilter = vi.fn(() => ({ ok: true }) as const);
		const emptyConfig: CaseListConfig = {
			columns: [],
			searchInputs: [],
		};
		const { rerender } = render(
			<FilterInspectorBody
				config={emptyConfig}
				onChange={onChange}
				onClearFilter={onClearFilter}
				stopsAutomaticSearch={false}
				discardsAutomaticSearchSettings={false}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId="app-1"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add a condition" }));

		const nextConfig = onChange.mock.calls[0]?.[0] as CaseListConfig;
		const seededFilter = nextConfig.filter;
		expect(seededFilter).toEqual(eq(prop("patient", "region"), literal("")));
		if (seededFilter === undefined) {
			throw new Error("Add a condition did not seed a filter");
		}
		expect(
			checkPredicate(seededFilter, {
				caseTypes: CASE_TYPES,
				currentCaseType: "patient",
				knownInputs: [],
			}).ok,
		).toBe(true);

		rerender(
			<FilterInspectorBody
				config={nextConfig}
				onChange={onChange}
				onClearFilter={onClearFilter}
				stopsAutomaticSearch={false}
				discardsAutomaticSearchSettings={false}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId="app-1"
			/>,
		);
		expect(screen.getByRole("button", { name: "Condition: is" })).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Left operand: Region" }),
		).toBeDefined();
		const valueInput = screen.getByRole("textbox", {
			name: "Literal text value",
		}) as HTMLInputElement;
		expect(valueInput.value).toBe("");
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);
	});

	it("confirms and delegates one atomic shutdown instead of clearing into an invalid marker", async () => {
		const onChange = vi.fn();
		const onClearFilter = vi.fn(() => ({ ok: true }) as const);
		render(
			<FilterInspectorBody
				config={FILTERED}
				onChange={onChange}
				onClearFilter={onClearFilter}
				stopsAutomaticSearch
				discardsAutomaticSearchSettings={false}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId="app-1"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Show all cases" }));
		expect(onChange).not.toHaveBeenCalled();
		expect(onClearFilter).not.toHaveBeenCalled();
		expect(
			screen.getByRole("heading", { name: "Show all cases instead?" }),
		).toBeDefined();
		expect(screen.getByText(/turns automatic search off/i)).toBeDefined();

		const actions = screen.getAllByRole("button", { name: "Show all cases" });
		fireEvent.click(actions[actions.length - 1]);
		expect(onClearFilter).toHaveBeenCalledOnce();
		expect(onChange).not.toHaveBeenCalled();
		await settleDialogTeardown();
	});

	it("plain result filters still clear directly without extra ceremony", () => {
		const onChange = vi.fn();
		const onClearFilter = vi.fn(() => ({ ok: true }) as const);
		render(
			<FilterInspectorBody
				config={FILTERED}
				onChange={onChange}
				onClearFilter={onClearFilter}
				stopsAutomaticSearch={false}
				discardsAutomaticSearchSettings={false}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId="app-1"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Show all cases" }));
		expect(onClearFilter).not.toHaveBeenCalled();
		expect(onChange).toHaveBeenCalledWith({
			columns: [],
			searchInputs: [],
			filter: undefined,
		});
	});

	it("keeps an ineffective root edit pending until automatic-search shutdown is confirmed", async () => {
		const onChange = vi.fn();
		const onClearFilter = vi.fn(() => ({ ok: true }) as const);
		render(
			<FilterInspectorBody
				config={FILTERED}
				onChange={onChange}
				onClearFilter={onClearFilter}
				stopsAutomaticSearch
				discardsAutomaticSearchSettings={false}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId="app-1"
			/>,
		);
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);

		fireEvent.click(screen.getByRole("button", { name: "Condition: is" }));
		fireEvent.click(screen.getByRole("menuitem", { name: /Always true/i }));

		expect(onChange).not.toHaveBeenCalled();
		expect(onClearFilter).not.toHaveBeenCalled();
		expect(
			screen.getByRole("heading", { name: "Show all cases instead?" }),
		).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Keep this rule" }));
		expect(onChange).not.toHaveBeenCalled();
		expect(onClearFilter).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Condition: is" }));
		fireEvent.click(screen.getByRole("menuitem", { name: /Always true/i }));
		// Let FloatingFocusManager finish the newly-opened dialog's initial-focus
		// microtask before accepting it. Closing the dialog in the same turn that
		// mounted it would strand that task under async-leak detection.
		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "Show all cases instead?" }),
			).toBeDefined(),
		);
		await Promise.resolve();
		const actions = screen.getAllByRole("button", { name: "Show all cases" });
		fireEvent.click(actions[actions.length - 1]);

		expect(onClearFilter).toHaveBeenCalledWith(matchAll());
		expect(onChange).not.toHaveBeenCalled();
		await settleDialogTeardown();
	});
});
