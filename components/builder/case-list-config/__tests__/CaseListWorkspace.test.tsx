// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/CaseListWorkspace.test.tsx
//
// CaseListWorkspace composition tests. The workspace is the
// single-scroll three-section authoring surface that mounts at
// /build/[id]/{moduleUuid}/cases in edit mode. It composes the
// existing DisplaySection / FiltersSection / SearchInputsSection
// inside violet-railed sticky section headers and binds each
// header's status-density line to the doc store via shallow
// selectors.
//
// The inner sections are mocked at module-resolution time so the
// workspace's own composition (section order, status density,
// empty-state branches) can be tested without the full inner
// editor + Server Action harness firing. The DisplaySection /
// FiltersSection / SearchInputsSection have their own dedicated
// test files for their internals; this file pins the shell.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type CaseType,
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	and,
	eq,
	isBlank,
	literal,
	matchAll,
	matchNone,
	or,
	prop,
	term,
} from "@/lib/domain/predicate";

// Stub the three inner sections so the workspace shell is the
// only subject under test. Each stub renders a sentinel
// data-testid + the props it received so assertions can verify
// wiring shape.
vi.mock("../DisplaySection", () => ({
	DisplaySection: vi.fn(
		(props: import("../DisplaySection").DisplaySectionProps) => (
			<div
				data-testid="display-section-stub"
				data-current-case-type={props.currentCaseType}
			>
				DisplaySection
			</div>
		),
	),
}));
vi.mock("../FiltersSection", () => ({
	FiltersSection: vi.fn(
		(props: import("../FiltersSection").FiltersSectionProps) => (
			<div
				data-testid="filters-section-stub"
				data-current-case-type={props.currentCaseType}
			>
				FiltersSection
			</div>
		),
	),
}));
vi.mock("../SearchInputsSection", () => ({
	SearchInputsSection: vi.fn(
		(props: import("../SearchInputsSection").SearchInputsSectionProps) => (
			<div
				data-testid="search-inputs-section-stub"
				data-current-case-type={props.currentCaseType}
			>
				SearchInputsSection
			</div>
		),
	),
}));

// `useAppId` is sourced from BuilderSessionProvider in production.
// The workspace only reads the appId to forward to the inner
// sections (which are stubbed in this file), so a lightweight mock
// keeps the test off the full session-provider stack.
vi.mock("@/lib/session/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/session/hooks")>(
		"@/lib/session/hooks",
	);
	return {
		...actual,
		useAppId: () => "app-workspace-test",
	};
});

import { CaseListWorkspace } from "../CaseListWorkspace";
import { FiltersSection as MockedFiltersSection } from "../FiltersSection";

// ── Fixtures ──────────────────────────────────────────────────────

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};

const MODULE_UUID = asUuid("00000000-0000-0000-0000-000000000111");

// Per-test fixture uuids — one stable uuid per fixture column /
// search input keeps assertions deterministic. The workspace
// surfaces uuid identity through the doc store; freezing them at
// the fixture level lets tests consult them via `asUuid("...")`.
const COL_NAME_UUID = asUuid("00000000-0000-0000-0000-000000000201");
const COL_AGE_UUID = asUuid("00000000-0000-0000-0000-000000000202");
const COL_DOB_UUID = asUuid("00000000-0000-0000-0000-000000000203");
const COL_CALC_UUID = asUuid("00000000-0000-0000-0000-000000000204");
const INPUT_NAME_UUID = asUuid("00000000-0000-0000-0000-000000000301");
const INPUT_AGE_UUID = asUuid("00000000-0000-0000-0000-000000000302");

/**
 * Resolve the section header wrapper for a section title. The
 * workspace renders each section header with a `data-section-header`
 * attribute on the wrapper; the title sits inside as an `<h2>`.
 */
function getSectionHeader(title: string): HTMLElement {
	const heading = screen.getByRole("heading", { name: title });
	const wrapper = heading.closest<HTMLElement>("[data-section-header]");
	if (!wrapper) {
		throw new Error(`Section header for title "${title}" not found.`);
	}
	return wrapper;
}

/** Render the workspace inside a BlueprintDocProvider seeded with
 *  a single case-typed module + the supplied caseListConfig. */
function renderWorkspace(config: Partial<CaseListConfig> = {}): ReactNode {
	const fullConfig: CaseListConfig = {
		columns: [],
		searchInputs: [],
		...config,
	};
	const tree = (
		<BlueprintDocProvider
			appId="app-workspace-test"
			initialDoc={{
				appId: "app-workspace-test",
				appName: "Workspace test app",
				connectType: null,
				caseTypes: [PATIENT],
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "patient_module",
						name: "Patient module",
						caseType: "patient",
						caseListConfig: fullConfig,
					},
				},
				forms: {},
				fields: {},
				moduleOrder: [MODULE_UUID],
				formOrder: { [MODULE_UUID]: [] },
				fieldOrder: {},
			}}
		>
			<CaseListWorkspace moduleUuid={MODULE_UUID} />
		</BlueprintDocProvider>
	);
	return tree;
}

// ── Section composition ──────────────────────────────────────────

describe("CaseListWorkspace — section composition", () => {
	it("renders Display, Filter, and Search sections in that order", () => {
		render(renderWorkspace());
		const display = screen.getByTestId("display-section-stub");
		const filters = screen.getByTestId("filters-section-stub");
		const searches = screen.getByTestId("search-inputs-section-stub");
		expect(display).toBeDefined();
		expect(filters).toBeDefined();
		expect(searches).toBeDefined();
		const order = [display, filters, searches].map((el) =>
			Array.from(document.body.querySelectorAll("[data-testid]")).indexOf(el),
		);
		expect(order[0]).toBeLessThan(order[1]);
		expect(order[1]).toBeLessThan(order[2]);
	});

	it("renders the three section header titles", () => {
		render(renderWorkspace());
		expect(screen.getByRole("heading", { name: /^Display$/ })).toBeDefined();
		expect(screen.getByRole("heading", { name: /^Filter$/ })).toBeDefined();
		expect(screen.getByRole("heading", { name: /^Search$/ })).toBeDefined();
	});
});

// ── Status density (live-bound to doc store) ─────────────────────

describe("CaseListWorkspace — Display status density", () => {
	it("renders column count + sort summary when columns and sort are present", () => {
		// Three plain columns; the dob column carries a desc-priority-0
		// sort. Status line reads "3 columns · sorted by dob ↓".
		render(
			renderWorkspace({
				columns: [
					plainColumn(COL_NAME_UUID, "name", "Name"),
					plainColumn(COL_AGE_UUID, "age", "Age"),
					plainColumn(COL_DOB_UUID, "dob", "DOB", {
						sort: { direction: "desc", priority: 0 },
					}),
				],
			}),
		);
		const displayHeader = getSectionHeader("Display");
		expect(within(displayHeader).getByText(/3 columns/)).toBeDefined();
		expect(within(displayHeader).getByText(/dob/)).toBeDefined();
		expect(within(displayHeader).getByText(/↓/)).toBeDefined();
	});

	it("renders the empty-state copy when no columns are configured", () => {
		render(renderWorkspace({ columns: [] }));
		const displayHeader = getSectionHeader("Display");
		expect(within(displayHeader).getByText(/No columns yet/i)).toBeDefined();
	});

	it("counts calculated columns as part of the column total", () => {
		// Calculated columns are a column kind in v2; the status line
		// aggregates every kind into one column total.
		render(
			renderWorkspace({
				columns: [
					plainColumn(COL_NAME_UUID, "name", "Name"),
					calculatedColumn(COL_CALC_UUID, "Greeting", term(literal("hi"))),
				],
			}),
		);
		const displayHeader = getSectionHeader("Display");
		expect(within(displayHeader).getByText(/2 columns/)).toBeDefined();
	});
});

describe("CaseListWorkspace — Filter status density", () => {
	it("renders 'No filter' when the filter slot is undefined", () => {
		render(renderWorkspace({ filter: undefined }));
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/No filter/i)).toBeDefined();
	});

	it("renders '0 conditions · …' placeholder for the match-all sentinel before preview loads", () => {
		render(renderWorkspace({ filter: matchAll() }));
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/0 conditions ·/)).toBeDefined();
		expect(within(filterHeader).getByText(/…/)).toBeDefined();
	});

	it("renders '0 conditions' for the match-none sentinel", () => {
		render(renderWorkspace({ filter: matchNone() }));
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/0 conditions/)).toBeDefined();
	});

	it("renders '1 condition' for a single non-sentinel predicate", () => {
		render(
			renderWorkspace({
				filter: eq(prop("patient", "name"), literal("Ada")),
			}),
		);
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/1 condition ·/)).toBeDefined();
	});

	it("renders '1 condition' for a non-comparison single-operand predicate (is-blank)", () => {
		render(
			renderWorkspace({
				filter: isBlank(prop("patient", "name")),
			}),
		);
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/1 condition ·/)).toBeDefined();
	});

	it("counts each clause of an `and` predicate as a condition", () => {
		render(
			renderWorkspace({
				filter: and(
					eq(prop("patient", "name"), literal("Ada")),
					eq(prop("patient", "age"), literal(42)),
					eq(prop("patient", "dob"), literal("1815-12-10")),
				),
			}),
		);
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/3 conditions ·/)).toBeDefined();
	});

	it("counts each clause of an `or` predicate as a condition", () => {
		render(
			renderWorkspace({
				filter: or(
					eq(prop("patient", "name"), literal("Ada")),
					eq(prop("patient", "name"), literal("Grace")),
				),
			}),
		);
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/2 conditions ·/)).toBeDefined();
	});

	it("renders '{N} conditions · {M} cases match' when the preview load resolves", () => {
		render(
			renderWorkspace({
				filter: and(
					eq(prop("patient", "name"), literal("Ada")),
					eq(prop("patient", "age"), literal(42)),
				),
			}),
		);
		const calls = vi.mocked(MockedFiltersSection).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const filterProps = calls[calls.length - 1][0];
		act(() => {
			filterProps.onPreviewStats?.({ totalCount: 47 });
		});
		const filterHeader = getSectionHeader("Filter");
		expect(
			within(filterHeader).getByText(/2 conditions · 47 cases match/),
		).toBeDefined();
	});

	it("uses singular 'case' when the resolved count is exactly 1", () => {
		render(
			renderWorkspace({
				filter: eq(prop("patient", "name"), literal("Ada")),
			}),
		);
		const calls = vi.mocked(MockedFiltersSection).mock.calls;
		const filterProps = calls[calls.length - 1][0];
		act(() => {
			filterProps.onPreviewStats?.({ totalCount: 1 });
		});
		const filterHeader = getSectionHeader("Filter");
		expect(
			within(filterHeader).getByText(/1 condition · 1 case match/),
		).toBeDefined();
	});

	it("falls back to the placeholder when the preview emits null", () => {
		render(
			renderWorkspace({
				filter: eq(prop("patient", "name"), literal("Ada")),
			}),
		);
		const calls = vi.mocked(MockedFiltersSection).mock.calls;
		const filterProps = calls[calls.length - 1][0];
		act(() => {
			filterProps.onPreviewStats?.({ totalCount: 47 });
		});
		expect(screen.getByText(/47 cases match/)).toBeDefined();
		act(() => {
			filterProps.onPreviewStats?.(null);
		});
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/1 condition · …/)).toBeDefined();
	});
});

describe("CaseListWorkspace — Search status density", () => {
	it("renders 'No search inputs' when the input list is empty", () => {
		render(renderWorkspace({ searchInputs: [] }));
		const searchHeader = getSectionHeader("Search");
		expect(within(searchHeader).getByText(/No search inputs/i)).toBeDefined();
	});

	it("renders the input count when inputs exist", () => {
		render(
			renderWorkspace({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_NAME_UUID,
						"name_input",
						"Name",
						"text",
						"name",
					),
					simpleSearchInputDef(
						INPUT_AGE_UUID,
						"age_input",
						"Age",
						"text",
						"age",
					),
				],
			}),
		);
		const searchHeader = getSectionHeader("Search");
		expect(within(searchHeader).getByText(/2 inputs/i)).toBeDefined();
	});

	it("appends 'with default values' when any input has a default expression", () => {
		render(
			renderWorkspace({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_NAME_UUID,
						"name_input",
						"Name",
						"text",
						"name",
					),
					simpleSearchInputDef(
						INPUT_AGE_UUID,
						"age_input",
						"Age",
						"text",
						"age",
						{ default: term(literal("18")) },
					),
				],
			}),
		);
		const searchHeader = getSectionHeader("Search");
		expect(
			within(searchHeader).getByText(/1 with default value/i),
		).toBeDefined();
	});
});

// ── Section header chrome ────────────────────────────────────────

describe("CaseListWorkspace — section header chrome", () => {
	it("renders one section header with a violet rail per section", () => {
		render(renderWorkspace());
		const headers = document.querySelectorAll("[data-section-header]");
		expect(headers.length).toBe(3);
		for (const header of headers) {
			const rail = header.querySelector("[data-section-rail]");
			expect(rail).not.toBeNull();
		}
	});

	it("threads the module's caseType into every inner section", () => {
		render(renderWorkspace());
		expect(
			screen.getByTestId("display-section-stub").dataset.currentCaseType,
		).toBe("patient");
		expect(
			screen.getByTestId("filters-section-stub").dataset.currentCaseType,
		).toBe("patient");
		expect(
			screen.getByTestId("search-inputs-section-stub").dataset.currentCaseType,
		).toBe("patient");
	});
});

// ── Empty-state cards with CTA ───────────────────────────────────

describe("CaseListWorkspace — empty-state cards", () => {
	it("renders an empty-state CTA above each empty section", () => {
		render(renderWorkspace());
		const cards = document.querySelectorAll("[data-empty-state-card]");
		expect(cards.length).toBe(3);
		expect(screen.getByRole("button", { name: /^Add column$/i })).toBeDefined();
		expect(screen.getByRole("button", { name: /^Add filter$/i })).toBeDefined();
		expect(
			screen.getByRole("button", { name: /^Add search input$/i }),
		).toBeDefined();
	});

	it("hides each empty-state card when its corresponding slice is populated", () => {
		render(
			renderWorkspace({
				columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
				filter: matchAll(),
				searchInputs: [
					simpleSearchInputDef(
						INPUT_NAME_UUID,
						"input_1",
						"First",
						"text",
						"name",
					),
				],
			}),
		);
		expect(document.querySelectorAll("[data-empty-state-card]").length).toBe(0);
	});

	it("Add column CTA seeds a plain column against the case type's first property", () => {
		render(renderWorkspace());
		expect(screen.getByText(/No columns yet/i)).toBeDefined();
		const cta = screen.getByRole("button", { name: /^Add column$/i });
		act(() => {
			fireEvent.click(cta);
		});
		expect(screen.getByText(/1 column/)).toBeDefined();
	});

	it("Add filter CTA seeds a match-all filter (always-true sentinel)", () => {
		render(renderWorkspace());
		const cta = screen.getByRole("button", { name: /^Add filter$/i });
		act(() => {
			fireEvent.click(cta);
		});
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/0 conditions ·/)).toBeDefined();
	});

	it("Add search input CTA seeds a text input row", () => {
		render(renderWorkspace());
		const cta = screen.getByRole("button", { name: /^Add search input$/i });
		act(() => {
			fireEvent.click(cta);
		});
		const searchHeader = getSectionHeader("Search");
		expect(within(searchHeader).getByText(/1 input/i)).toBeDefined();
	});
});

// ── Disabled CTA when case type has no declared properties ───────

describe("CaseListWorkspace — empty-state CTAs gated on case-type properties", () => {
	function renderPropertylessWorkspace(): ReactNode {
		const NO_PROP_CT: CaseType = { name: "patient", properties: [] };
		return (
			<BlueprintDocProvider
				appId="app-workspace-test"
				initialDoc={{
					appId: "app-workspace-test",
					appName: "Workspace test app",
					connectType: null,
					caseTypes: [NO_PROP_CT],
					modules: {
						[MODULE_UUID]: {
							uuid: MODULE_UUID,
							id: "patient_module",
							name: "Patient module",
							caseType: "patient",
							caseListConfig: {
								columns: [],
								searchInputs: [],
							},
						},
					},
					forms: {},
					fields: {},
					moduleOrder: [MODULE_UUID],
					formOrder: { [MODULE_UUID]: [] },
					fieldOrder: {},
				}}
			>
				<CaseListWorkspace moduleUuid={MODULE_UUID} />
			</BlueprintDocProvider>
		);
	}

	it("disables Add column when no case-type properties exist", () => {
		render(renderPropertylessWorkspace());
		const cta = screen.getByRole("button", {
			name: /^Add column$/i,
		}) as HTMLButtonElement;
		expect(cta.disabled).toBe(true);
	});

	it("disables Add search input when no case-type properties exist", () => {
		render(renderPropertylessWorkspace());
		const cta = screen.getByRole("button", {
			name: /^Add search input$/i,
		}) as HTMLButtonElement;
		expect(cta.disabled).toBe(true);
	});

	it("keeps Add filter enabled (filter seed is property-less)", () => {
		render(renderPropertylessWorkspace());
		const cta = screen.getByRole("button", {
			name: /^Add filter$/i,
		}) as HTMLButtonElement;
		expect(cta.disabled).toBe(false);
	});
});
