// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	CaseListConfig,
	CaseSearchConfig,
	CaseType,
	CommitOutcome,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	arith,
	checkPredicate,
	coalesce,
	double,
	eq,
	exists,
	ifExpr,
	literal,
	matchAll,
	not,
	or,
	type Predicate,
	prop,
	relationStep,
	term,
} from "@/lib/domain/predicate";
import { loadFilterPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";
import { expressionCardSchemaList } from "../../shared/expressionEditorSchemas";
import { PredicateWorkbench } from "../../shared/PredicateWorkbench";
import { CaseAvailabilityComposer } from "../canvas/CaseAvailabilityComposer";

const docApi = vi.hoisted(() => ({ getState: () => ({}) }));
const permissions = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDocApi: () => docApi,
}));

vi.mock("@/lib/preview/engine/caseDataBindingClient", () => ({
	pickBlueprintDoc: () => ({}),
}));

vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadFilterPreviewAction: vi
		.fn()
		.mockResolvedValue({ kind: "error", message: "Preview unavailable" }),
}));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => permissions.canEdit,
}));

const CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		properties: [{ name: "region", label: "Region", data_type: "text" }],
	},
];

const NORTH = eq(prop("patient", "region"), literal("North"));
const SOUTH = eq(prop("patient", "region"), literal("South"));
const EMPTY_REGION = eq(prop("patient", "region"), literal(""));

const EMPTY_CONFIG: CaseListConfig = {
	columns: [],
	searchInputs: [],
};

interface RenderComposerOptions {
	readonly config?: CaseListConfig;
	readonly filterBroken?: boolean;
	readonly searchConfig?: CaseSearchConfig;
	readonly caseSearchEnabled?: boolean;
	readonly currentCaseType?: string;
}

type FilterCommit = (next: Predicate | undefined) => CommitOutcome;

function renderComposer({
	config = EMPTY_CONFIG,
	filterBroken = false,
	searchConfig,
	caseSearchEnabled = false,
	currentCaseType = "patient",
}: RenderComposerOptions = {}) {
	const onFilterChange = vi.fn<FilterCommit>(() => ({ ok: true }) as const);
	const onClearFilter = vi.fn<FilterCommit>(() => ({ ok: true }) as const);
	const onExcludedOwnerIdsChange = vi.fn();
	const view = render(
		<CaseAvailabilityComposer
			config={config}
			filterBroken={filterBroken}
			onFilterChange={onFilterChange}
			onClearFilter={onClearFilter}
			searchConfig={searchConfig}
			caseSearchEnabled={caseSearchEnabled}
			onExcludedOwnerIdsChange={onExcludedOwnerIdsChange}
			caseTypes={CASE_TYPES}
			currentCaseType={currentCaseType}
			appId="app-1"
		/>,
	);

	return {
		...view,
		onFilterChange,
		onClearFilter,
		onExcludedOwnerIdsChange,
	};
}

function composer(
	config: CaseListConfig,
	onFilterChange: Mock<FilterCommit>,
	onClearFilter: Mock<FilterCommit>,
	options: Pick<
		RenderComposerOptions,
		"searchConfig" | "caseSearchEnabled"
	> = {},
) {
	return (
		<CaseAvailabilityComposer
			config={config}
			filterBroken={false}
			onFilterChange={onFilterChange}
			onClearFilter={onClearFilter}
			searchConfig={options.searchConfig}
			caseSearchEnabled={options.caseSearchEnabled ?? false}
			onExcludedOwnerIdsChange={() => {}}
			caseTypes={CASE_TYPES}
			currentCaseType="patient"
			appId="app-1"
		/>
	);
}

/** Base UI releases dialog focus/scroll locks on the next macrotask. */
async function settleDialogTeardown(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function addComparisonCondition(buttonName = "Add condition"): void {
	fireEvent.click(screen.getByRole("button", { name: buttonName }));
	fireEvent.click(
		screen.getByRole("menuitem", { name: /^Compare case information/ }),
	);
}

function pressSelectOption(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
}

describe("Results Cases available composer", () => {
	beforeEach(() => {
		permissions.canEdit = true;
	});

	it("describes unrestricted Results without edit instructions to viewers", () => {
		permissions.canEdit = false;
		renderComposer();

		expect(
			screen.getByText("Results can include every available case"),
		).toBeDefined();
		expect(screen.queryByText(/Add a condition only when/i)).toBeNull();
		expect(screen.queryByRole("button", { name: "Add condition" })).toBeNull();
	});

	it("shows and counts the assigned-case rule as part of Results availability", async () => {
		const excludedOwnerIds = term({
			kind: "session-context",
			field: "userid",
		});
		const { onExcludedOwnerIdsChange } = renderComposer({
			searchConfig: { excludedOwnerIds },
		});

		expect(screen.getByText("Some assigned cases are hidden")).toBeDefined();
		expect(
			screen.getByText(
				"Cases assigned to the person using the app are hidden from Results",
			),
		).toBeDefined();
		expect(screen.queryByText("All cases are available")).toBeNull();
		await waitFor(() => {
			expect(vi.mocked(loadFilterPreviewAction)).toHaveBeenCalledWith(
				expect.objectContaining({
					excludedOwnerIdsExpression: excludedOwnerIds,
				}),
			);
		});

		fireEvent.click(
			screen.getByRole("combobox", {
				name: "Cases assigned to the person using the app",
			}),
		);
		pressSelectOption(
			await screen.findByRole("option", { name: "Show in Results" }),
		);
		expect(onExcludedOwnerIdsChange).toHaveBeenCalledWith(undefined);
	});

	it("keeps on-device property comparisons available when the raw config only stores assigned-case rules", () => {
		renderComposer({
			config: { ...EMPTY_CONFIG, filter: NORTH },
			searchConfig: {
				searchActionEnabled: false,
				excludedOwnerIds: term({
					kind: "session-context",
					field: "userid",
				}),
			},
			caseSearchEnabled: false,
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Value source: A value" }),
		);
		const otherCaseInformation = screen.getByRole("menuitem", {
			name: /^Other case information/,
		});

		expect(otherCaseInformation.getAttribute("aria-disabled")).not.toBe("true");
	});

	it("does not guess singular grammar from a plural case type identifier", () => {
		renderComposer({ currentCaseType: "clients" });

		expect(screen.getByText("All cases are available")).toBeDefined();
		expect(screen.queryByText(/Clients cases/i)).toBeNull();
	});

	it("explains the consequence of a broken rule to viewers", () => {
		permissions.canEdit = false;
		renderComposer({
			config: { ...EMPTY_CONFIG, filter: NORTH },
			filterBroken: true,
		});

		expect(
			screen.getByText(
				/Results may not show the intended cases because this rule needs attention/i,
			),
		).toBeDefined();
		expect(
			screen.getByText(/Ask someone who can edit the app to fix it/i),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: "Add condition" })).toBeNull();
	});

	it("offers an ordinary comparison first, followed by every structural rule shape", () => {
		renderComposer();

		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		const choices = screen.getAllByRole("menuitem");
		expect(choices[0]?.textContent).toContain("Compare case information");
		for (const name of [
			"Require every condition",
			"Require any condition",
			"Exclude when",
			"Apply after a search answer",
			"Require a related case",
			"Require no related case",
		]) {
			expect(
				screen.getByRole("menuitem", { name: new RegExp(name) }),
			).toBeDefined();
		}
	});

	it("starts with a visible, type-valid Is condition", () => {
		const { onFilterChange } = renderComposer();

		addComparisonCondition();

		expect(onFilterChange).toHaveBeenCalledWith(EMPTY_REGION);
		expect(
			checkPredicate(EMPTY_REGION, {
				caseTypes: CASE_TYPES,
				currentCaseType: "patient",
				knownInputs: [],
			}).ok,
		).toBe(true);
	});

	it("adds a structural root from the same condition menu", () => {
		const { onFilterChange } = renderComposer();

		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		fireEvent.click(
			screen.getByRole("menuitem", { name: /^Require any condition/ }),
		);

		const next = onFilterChange.mock.calls.at(-1)?.[0];
		expect(next?.kind).toBe("or");
		if (next?.kind !== "or") throw new Error("Expected an Any condition group");
		expect(next.clauses).toHaveLength(2);
	});

	it("uses the same menu to add a condition inside a related-case rule", () => {
		const via = ancestorPath(relationStep("parent", "household"));
		const patient = CASE_TYPES[0];
		if (patient === undefined) throw new Error("Missing patient case type");
		const relatedCaseTypes: CaseType[] = [
			{ ...patient, parent_type: "household" },
			{
				name: "household",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
		];
		const onChange = vi.fn();
		render(
			<PredicateWorkbench
				value={exists(via)}
				onChange={onChange}
				caseTypes={relatedCaseTypes}
				currentCaseType="patient"
			/>,
		);

		addComparisonCondition("Add condition for related cases");

		expect(onChange).toHaveBeenLastCalledWith(
			exists(via, eq(prop("household", "region"), literal(""))),
		);
	});

	it("keeps a failed match total visible and retryable", async () => {
		const loadPreview = vi.mocked(loadFilterPreviewAction);
		let resolveRetry: (
			value: Awaited<ReturnType<typeof loadFilterPreviewAction>>,
		) => void = () => {};
		loadPreview
			.mockResolvedValueOnce({ kind: "error", message: "Preview unavailable" })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveRetry = resolve;
					}),
			);
		const callsBeforeRender = loadPreview.mock.calls.length;
		renderComposer({ config: { ...EMPTY_CONFIG, filter: NORTH } });

		expect(
			await screen.findByText("The number of matching cases isn’t available"),
		).toBeDefined();
		expect(loadPreview.mock.calls.length).toBeGreaterThan(callsBeforeRender);
		const callsBeforeRetry = loadPreview.mock.calls.length;

		const retry = screen.getByRole("button", { name: "Try again" });
		retry.focus();
		fireEvent.click(retry);

		await waitFor(() =>
			expect(loadPreview.mock.calls.length).toBeGreaterThan(callsBeforeRetry),
		);
		const loadingStatus = screen.getByRole("status");
		expect(loadingStatus.textContent).toContain("Counting matches…");
		await waitFor(() => expect(document.activeElement).toBe(loadingStatus));

		await act(async () =>
			resolveRetry({ kind: "error", message: "Preview unavailable" }),
		);
		expect(
			await screen.findByText("The number of matching cases isn’t available"),
		).toBeDefined();
		const renewedRetry = screen.getByRole("button", { name: "Try again" });
		await waitFor(() => expect(document.activeElement).toBe(renewedRetry));
	});

	it("refreshes its total only when case data for this app and case type changes", async () => {
		const loadPreview = vi.mocked(loadFilterPreviewAction);
		loadPreview
			.mockResolvedValueOnce({ kind: "rows", rows: [], totalCount: 2 })
			.mockResolvedValueOnce({ kind: "rows", rows: [], totalCount: 7 });
		renderComposer({ config: { ...EMPTY_CONFIG, filter: NORTH } });

		expect(await screen.findByText("2 cases match")).toBeDefined();
		const callsAfterInitialLoad = loadPreview.mock.calls.length;

		act(() => invalidateCaseData("app-1", "household", "replacement"));
		await Promise.resolve();
		expect(loadPreview).toHaveBeenCalledTimes(callsAfterInitialLoad);

		act(() => invalidateCaseData("app-1", "patient", "replacement"));
		await waitFor(() =>
			expect(loadPreview).toHaveBeenCalledTimes(callsAfterInitialLoad + 1),
		);
		expect(await screen.findByText("7 cases match")).toBeDefined();
	});

	it("adds a second condition as a directly visible all-match group", async () => {
		const config = { ...EMPTY_CONFIG, filter: NORTH };
		const { onFilterChange, onClearFilter, rerender } = renderComposer({
			config,
		});
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);

		addComparisonCondition();
		expect(onFilterChange).toHaveBeenLastCalledWith(and(NORTH, EMPTY_REGION));

		rerender(
			composer(
				{ ...EMPTY_CONFIG, filter: and(NORTH, EMPTY_REGION) },
				onFilterChange,
				onClearFilter,
			),
		);
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);
		expect(screen.getByRole("heading", { name: "2 conditions" })).toBeDefined();
		expect(
			screen.getByRole("button", { name: "All conditions must match" }),
		).toBeDefined();
		const removeButtons = screen.getAllByRole("button", {
			name: "Delete condition",
		});
		expect(removeButtons).toHaveLength(2);
		for (const button of removeButtons) {
			expect(button.classList.contains("group/button")).toBe(true);
			expect(button.classList.contains("right-3")).toBe(true);
			expect(button.classList.contains("top-3")).toBe(true);
		}
		expect(
			screen.queryByRole("button", { name: /condition actions/i }),
		).toBeNull();
		const showAll = screen.getByRole("button", { name: "Show all cases" });
		expect(showAll).toBeDefined();
		expect(showAll.className).toContain("text-destructive");
		/* The workbench is frequently narrower than the viewport because it sits
		 * inside the Results card. At a 320px handset its own container is only
		 * about 200px wide, so the summary and action must become two full rows
		 * before either label is allowed to break mid-word. `@sm` restores the
		 * compact horizontal header only when the component itself has room. */
		const logicalHeader = showAll.closest("[data-logical-group-header]");
		expect(logicalHeader).not.toBeNull();
		expect(logicalHeader?.className).toContain("flex-col");
		expect(logicalHeader?.className).toContain("@sm:flex-row");
		expect(showAll.className).toContain("min-h-11");
		expect(showAll.className).toContain("w-full");
		expect(showAll.className).toContain("@sm:w-auto");
		expect(screen.queryByRole("button", { name: "Delete group" })).toBeNull();
	});

	it("changes only the focused connector and keeps Any when another condition is added", async () => {
		const all = and(NORTH, SOUTH);
		const config = { ...EMPTY_CONFIG, filter: all };
		const { onFilterChange, onClearFilter, rerender } = renderComposer({
			config,
		});
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "All conditions must match" }),
		);
		fireEvent.click(
			screen.getByRole("menuitemradio", { name: "Any condition can match" }),
		);
		expect(onFilterChange).toHaveBeenLastCalledWith(or(NORTH, SOUTH));

		rerender(
			composer(
				{ ...EMPTY_CONFIG, filter: or(NORTH, SOUTH) },
				onFilterChange,
				onClearFilter,
			),
		);
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);
		addComparisonCondition();
		expect(onFilterChange).toHaveBeenLastCalledWith(
			or(NORTH, SOUTH, EMPTY_REGION),
		);
	});

	it("unwraps the final remaining condition, then clears the filter", async () => {
		const config = { ...EMPTY_CONFIG, filter: and(NORTH, SOUTH) };
		const { onFilterChange, onClearFilter, rerender } = renderComposer({
			config,
		});
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);

		const firstRemove = screen.getAllByRole("button", {
			name: "Delete condition",
		})[0];
		if (firstRemove === undefined) throw new Error("Missing first condition");
		fireEvent.click(firstRemove);
		expect(onFilterChange).toHaveBeenLastCalledWith(SOUTH);

		rerender(
			composer(
				{ ...EMPTY_CONFIG, filter: SOUTH },
				onFilterChange,
				onClearFilter,
			),
		);
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Show all cases" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(
			screen.getByRole("heading", {
				name: "Show all cases in Results?",
			}),
		).toBeDefined();
		expect(
			screen.getByText(
				"Your current conditions will be removed. You can undo this change.",
			),
		).toBeDefined();
		expect(onClearFilter).not.toHaveBeenCalled();
		await Promise.resolve();
		fireEvent.click(
			dialog.querySelector<HTMLButtonElement>(
				'[data-slot="alert-dialog-action"]',
			) as HTMLButtonElement,
		);
		expect(onClearFilter).toHaveBeenCalledWith(undefined);
		expect(onFilterChange).toHaveBeenLastCalledWith(SOUTH);

		rerender(composer(EMPTY_CONFIG, onFilterChange, onClearFilter));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add condition" }),
			),
		);
		await settleDialogTeardown();
	});

	it("keeps assigned cases and Search settings separate when clearing availability", async () => {
		const config = { ...EMPTY_CONFIG, filter: NORTH };
		const { onFilterChange, onClearFilter, rerender } = renderComposer({
			config,
			searchConfig: {
				searchScreenTitle: "Find a patient",
				searchScreenSubtitle: "Use a name or identifier",
				searchButtonLabel: "Find",
				searchButtonDisplayCondition: NORTH,
				excludedOwnerIds: term(literal("assigned-owner")),
			},
		});
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Remove these conditions" }),
		);
		expect(onFilterChange).not.toHaveBeenCalled();
		expect(onClearFilter).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(
				screen.getByRole("heading", {
					name: "Remove these conditions?",
				}),
			).toBeDefined(),
		);
		expect(
			screen.getByText(
				"Cases hidden by these conditions can appear in Results. Your assigned cases setting won’t change. You can undo this change.",
			),
		).toBeDefined();
		expect(screen.queryByText(/Search screen .* removed/i)).toBeNull();
		expect(
			screen.queryByText(/going directly to Results.*removed/i),
		).toBeNull();
		expect(screen.queryByText(/settings will be cleared/i)).toBeNull();
		// Let FloatingFocusManager finish the dialog's initial-focus microtask
		// before accepting it; closing in the mount turn strands that task under
		// the async-leak detector.
		await Promise.resolve();

		const remove = screen.getByRole("button", { name: "Remove" });
		expect(remove.className).toContain("bg-destructive");
		fireEvent.click(remove);
		expect(onClearFilter).toHaveBeenCalledWith(undefined);
		expect(onFilterChange).not.toHaveBeenCalled();

		rerender(composer(EMPTY_CONFIG, onFilterChange, onClearFilter));
		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add condition" }),
			);
		});
		await settleDialogTeardown();
	});

	it("drills into one structural level without recursively rendering deeper groups", async () => {
		const nested = or(SOUTH, not(EMPTY_REGION));
		const { onFilterChange } = renderComposer({
			config: { ...EMPTY_CONFIG, filter: and(NORTH, nested) },
		});
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);

		expect(screen.getByText("Any condition matches")).toBeDefined();
		expect(screen.queryByText("Exclude cases when")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /^Edit / }));
		expect(screen.getByText("Exclude cases when")).toBeDefined();
		expect(onFilterChange).not.toHaveBeenCalled();
	});

	it("groups adjacent conditions and ungroups them without rebuilding either child", async () => {
		const original = and(NORTH, SOUTH, EMPTY_REGION);
		const { onFilterChange, onClearFilter, rerender } = renderComposer({
			config: { ...EMPTY_CONFIG, filter: original },
		});
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);

		const arrangeButtons = screen.getAllByRole("button", {
			name: /^Organize /,
		});
		const firstArrange = arrangeButtons[0];
		if (firstArrange === undefined)
			throw new Error("Missing first arrange action");
		fireEvent.click(firstArrange);
		fireEvent.click(
			screen.getByRole("menuitem", {
				name: "Let either of these conditions match",
			}),
		);
		const grouped = and(or(NORTH, SOUTH), EMPTY_REGION);
		expect(onFilterChange).toHaveBeenLastCalledWith(grouped);

		rerender(
			composer(
				{ ...EMPTY_CONFIG, filter: grouped },
				onFilterChange,
				onClearFilter,
			),
		);
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);
		const groupedArrange = screen.getAllByRole("button", {
			name: /^Organize /,
		})[0];
		if (groupedArrange === undefined) {
			throw new Error("Missing grouped arrange action");
		}
		fireEvent.click(groupedArrange);
		expect(
			screen.getByRole("menuitem", { name: "Delete group" }),
		).toBeDefined();
		fireEvent.click(
			screen.getByRole("menuitem", {
				name: "Require every condition separately",
			}),
		);
		expect(onFilterChange).toHaveBeenLastCalledWith(original);
	});

	it("summarizes every calculated value kind without rendering its nested card", () => {
		const editContext = {
			caseTypes: CASE_TYPES,
			currentCaseType: "patient",
			knownInputs: [],
		};
		for (const schema of expressionCardSchemaList) {
			const value = eq(
				term(prop("patient", "region")),
				schema.defaultValue(editContext),
			);
			const view = render(
				<PredicateWorkbench
					value={value}
					onChange={vi.fn()}
					caseTypes={CASE_TYPES}
					currentCaseType="patient"
				/>,
			);
			const summaries = view.container.querySelectorAll(
				"[data-rule-focus-summary]",
			);
			expect(summaries, schema.kind).toHaveLength(
				schema.kind === "term" ? 0 : 1,
			);
			view.unmount();
		}
	});

	it("opens one calculated layer at a time in the same full-width workbench", () => {
		const deeplyCalculated = eq(
			term(prop("patient", "region")),
			ifExpr(
				matchAll(),
				coalesce(
					arith("+", double(term(prop("patient", "region"))), term(literal(1))),
					term(literal(0)),
				),
				term(literal(0)),
			),
		);
		render(
			<PredicateWorkbench
				value={deeplyCalculated}
				onChange={vi.fn()}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: "Edit value chosen by a condition",
			}),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: "Edit math" })).toBeNull();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Edit value chosen by a condition",
			}),
		);
		expect(
			screen.getByRole("button", { name: "Edit first available value" }),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: "Edit math" })).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "Edit first available value" }),
		);
		expect(screen.getByRole("button", { name: "Edit math" })).toBeDefined();
		expect(
			screen.queryByRole("button", { name: "Edit number from a value" }),
		).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Edit math" }));
		expect(
			screen.getByRole("button", { name: "Edit number from a value" }),
		).toBeDefined();
	});

	it("keeps grouping actions out of the condition verb menu", async () => {
		renderComposer({ config: { ...EMPTY_CONFIG, filter: NORTH } });
		fireEvent.click(screen.getByRole("button", { name: "Condition is" }));
		const alternative = await screen.findByRole("menuitem", {
			name: /^isn’t/i,
		});
		expect(
			screen.queryByRole("menuitem", { name: /All conditions match/ }),
		).toBeNull();
		expect(screen.getByRole("button", { name: "Add condition" })).toBeDefined();
		fireEvent.click(alternative);
		await waitFor(() => {
			expect(screen.queryByRole("menuitem", { name: /^isn’t/i })).toBeNull();
		});
	});

	it("confirms before removing a nested root rule", async () => {
		const nested = and(NORTH, or(SOUTH, not(EMPTY_REGION)));
		const { onFilterChange, onClearFilter, rerender } = renderComposer({
			config: { ...EMPTY_CONFIG, filter: nested },
		});
		await waitFor(() =>
			expect(screen.queryByText("Counting matches…")).toBeNull(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Show all cases" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(
			screen.getByText(
				"Your current conditions will be removed. You can undo this change.",
			),
		).toBeDefined();
		expect(screen.queryByText(/go directly to Results/i)).toBeNull();
		expect(onFilterChange).not.toHaveBeenCalled();
		expect(onClearFilter).not.toHaveBeenCalled();
		await Promise.resolve();
		fireEvent.click(
			dialog.querySelector<HTMLButtonElement>(
				'[data-slot="alert-dialog-action"]',
			) as HTMLButtonElement,
		);
		expect(onClearFilter).toHaveBeenCalledWith(undefined);
		expect(onFilterChange).not.toHaveBeenCalled();

		rerender(composer(EMPTY_CONFIG, onFilterChange, onClearFilter));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add condition" }),
			),
		);
		await settleDialogTeardown();
	});
});
