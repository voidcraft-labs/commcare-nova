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
	propertySortSource,
	searchInputDef,
	sortKey,
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

/**
 * Stub the three inner sections so the workspace shell is the only
 * subject under test. Each stub renders a sentinel data-testid +
 * the props it received so assertions can verify wiring shape.
 *
 * The real sections render dozens of sub-editors that pull on the
 * Postgres preview action, drag-and-drop monitors, and case-store
 * harness — none of which are this file's concern. The dedicated
 * DisplaySection / FiltersSection / SearchInputsSection test files
 * pin those internals.
 */
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
// The workspace only reads the appId to forward to the inner sections
// (which are stubbed in this file), so a lightweight mock keeps the
// test off the full session-provider stack.
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
import { DisplaySection as MockedDisplaySection } from "../DisplaySection";
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

const MODULE_UUID = asUuid("mod-1");

/**
 * Resolve the section header wrapper for a section title. The
 * workspace renders each section header with a `data-section-header`
 * attribute on the wrapper; the title sits inside as an `<h2>`.
 * Returns the wrapper as `HTMLElement` so `within(...)` accepts it.
 */
function getSectionHeader(title: string): HTMLElement {
	const heading = screen.getByRole("heading", { name: title });
	const wrapper = heading.closest<HTMLElement>("[data-section-header]");
	if (!wrapper) {
		throw new Error(`Section header for title "${title}" not found.`);
	}
	return wrapper;
}

/**
 * Render the workspace inside a BlueprintDocProvider seeded with a
 * single case-typed module + the supplied caseListConfig. The
 * provider's per-mount store gives every test a clean blueprint
 * surface; per-test edits flow through `updateModule(...)` and
 * survive within the same `render(...)` call.
 */
function renderWorkspace(config: Partial<CaseListConfig> = {}): ReactNode {
	const fullConfig: CaseListConfig = {
		columns: [],
		sort: [],
		calculatedColumns: [],
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
		// All three sections are mounted simultaneously (single-scroll
		// magazine layout — no tabs, no accordion).
		expect(display).toBeDefined();
		expect(filters).toBeDefined();
		expect(searches).toBeDefined();
		// DOM order: Display → Filter → Search. The follow-the-content
		// reading order mirrors the authoring narrative ("define what
		// shows, narrow what shows, let the user filter further").
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
		render(
			renderWorkspace({
				columns: [
					plainColumn("name", "Name"),
					plainColumn("age", "Age"),
					plainColumn("dob", "DOB"),
				],
				sort: [sortKey(propertySortSource("dob"), "date", "desc")],
			}),
		);
		const displayHeader = getSectionHeader("Display");
		// Column count: three plain columns → "3 columns".
		expect(within(displayHeader).getByText(/3 columns/)).toBeDefined();
		// Sort summary: property "dob" descending → "dob ↓".
		expect(within(displayHeader).getByText(/dob/)).toBeDefined();
		expect(within(displayHeader).getByText(/↓/)).toBeDefined();
	});

	it("renders the empty-state copy when no columns are configured", () => {
		render(renderWorkspace({ columns: [] }));
		const displayHeader = getSectionHeader("Display");
		expect(within(displayHeader).getByText(/No columns yet/i)).toBeDefined();
	});

	it("counts calculated columns as part of the column total", () => {
		// Calculated columns appear in the case list display alongside
		// plain columns; the status line aggregates both.
		render(
			renderWorkspace({
				columns: [plainColumn("name", "Name")],
				calculatedColumns: [
					calculatedColumn("greeting", "Greeting", term(literal("hi"))),
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
		// `match-all` is a sentinel: filter slot defined, but no
		// user-meaningful condition. The condition count is zero;
		// the header still surfaces the count + the em-dash
		// placeholder while the FiltersPreview load is in flight.
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
		// A bare `eq` predicate counts as one condition — it's the
		// minimal user-authored shape.
		render(
			renderWorkspace({
				filter: eq(prop("patient", "name"), literal("Ada")),
			}),
		);
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/1 condition ·/)).toBeDefined();
	});

	it("renders '1 condition' for a non-comparison single-operand predicate (is-blank)", () => {
		// Pin the policy's "fallthrough returns 1" semantic against
		// any non-sentinel, non-and/or predicate. `is-blank` is a
		// single-operand operator the user authored as one condition;
		// the same applies to every other arm in this branch
		// (`is-null` / `exists` / `missing` / `not` / `match` / `in`
		// / `between` / `multi-select-contains` / `within-distance`
		// / `when-input-present`).
		render(
			renderWorkspace({
				filter: isBlank(prop("patient", "name")),
			}),
		);
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/1 condition ·/)).toBeDefined();
	});

	it("counts each clause of an `and` predicate as a condition", () => {
		// `and([eq, eq, eq])` carries three direct clauses; the
		// status line reads three conditions.
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
		// Render with two-clause `and`; fire `onPreviewStats` to
		// simulate the FiltersPreview success arm. Header reads
		// "2 conditions · 47 cases match".
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

	it("falls back to the placeholder when the preview emits null (loading / paused / error)", () => {
		render(
			renderWorkspace({
				filter: eq(prop("patient", "name"), literal("Ada")),
			}),
		);
		const calls = vi.mocked(MockedFiltersSection).mock.calls;
		const filterProps = calls[calls.length - 1][0];
		// First emit a successful load to populate the count.
		act(() => {
			filterProps.onPreviewStats?.({ totalCount: 47 });
		});
		expect(screen.getByText(/47 cases match/)).toBeDefined();
		// Then emit `null` (loading / paused / error). Header reverts
		// to the placeholder so a stale count doesn't linger.
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
					searchInputDef("name_input", "Name", "text", {
						property: "name",
					}),
					searchInputDef("age_input", "Age", "text", {
						property: "age",
					}),
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
					searchInputDef("name_input", "Name", "text", {
						property: "name",
					}),
					searchInputDef("age_input", "Age", "text", {
						property: "age",
						default: term(literal("18")),
					}),
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
		// One header per section — Display, Filter, Search.
		expect(headers.length).toBe(3);
		for (const header of headers) {
			// Each header carries a violet-rail underline element. The
			// rail is the only visual border for the section — no
			// surrounding box, just the rail beneath the title. Sticky-
			// positioning behavior itself is layout, not DOM, so it
			// surfaces meaningfully under integration / visual review,
			// not in a JSDOM unit test.
			const rail = header.querySelector("[data-section-rail]");
			expect(rail).not.toBeNull();
		}
	});

	it("threads the module's caseType into every inner section", () => {
		// Each section needs `currentCaseType` to scope its property
		// pickers — the workspace forwards the module's caseType from
		// the doc store. Pin the contract so a future refactor can't
		// silently break the wiring.
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
		// Three empty-state cards, one per section.
		const cards = document.querySelectorAll("[data-empty-state-card]");
		expect(cards.length).toBe(3);
		// Each card surfaces a single CTA button.
		expect(screen.getByRole("button", { name: /^Add column$/i })).toBeDefined();
		expect(screen.getByRole("button", { name: /^Add filter$/i })).toBeDefined();
		expect(
			screen.getByRole("button", { name: /^Add search input$/i }),
		).toBeDefined();
	});

	it("hides each empty-state card when its corresponding slice is populated", () => {
		render(
			renderWorkspace({
				columns: [plainColumn("name", "Name")],
				filter: matchAll(),
				searchInputs: [
					searchInputDef("input_1", "First", "text", { property: "name" }),
				],
			}),
		);
		expect(document.querySelectorAll("[data-empty-state-card]").length).toBe(0);
	});

	it("Add column CTA seeds a plain column against the case type's first property", () => {
		render(renderWorkspace());
		// Initial state — no columns yet.
		expect(screen.getByText(/No columns yet/i)).toBeDefined();
		// Click the empty-state CTA. The seed routes through the
		// workspace's shared mutator, the doc store updates, the
		// status line re-derives.
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
		// `match-all` is a sentinel — zero user-meaningful conditions.
		// The header reads "0 conditions · …" (placeholder because
		// the FiltersPreview stub never resolves the load).
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

// ── Disabled CTA when the case type has no declared properties ───

describe("CaseListWorkspace — empty-state CTAs gated on case-type properties", () => {
	/**
	 * Render against a module whose case type is declared but
	 * carries no properties. The column / search-input CTAs would
	 * seed against `firstProperty = ""` and produce a row with an
	 * empty property dropdown — so the workspace disables those
	 * CTAs and surfaces the precondition via the button's `title`.
	 *
	 * The filter CTA stays enabled — `matchAll()` is a property-
	 * less sentinel, so the path doesn't depend on case-type
	 * properties.
	 */
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
								sort: [],
								calculatedColumns: [],
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

	it("disables the Add column CTA with a precondition hint", () => {
		render(renderPropertylessWorkspace());
		const cta = screen.getByRole("button", { name: /^Add column$/i });
		expect((cta as HTMLButtonElement).disabled).toBe(true);
		expect(cta.getAttribute("title")).toBe(
			"Define case-type properties first.",
		);
	});

	it("disables the Add search input CTA with a precondition hint", () => {
		render(renderPropertylessWorkspace());
		const cta = screen.getByRole("button", { name: /^Add search input$/i });
		expect((cta as HTMLButtonElement).disabled).toBe(true);
		expect(cta.getAttribute("title")).toBe(
			"Define case-type properties first.",
		);
	});

	it("keeps the Add filter CTA enabled — match-all sentinel needs no property", () => {
		render(renderPropertylessWorkspace());
		const cta = screen.getByRole("button", { name: /^Add filter$/i });
		expect((cta as HTMLButtonElement).disabled).toBe(false);
		expect(cta.getAttribute("title")).toBeNull();
	});
});

// ── Round-trip mutation through updateModule ────────────────────

describe("CaseListWorkspace — config edits flow through updateModule", () => {
	it("a section's onChange persists through the doc store and re-derives the status line", () => {
		// Render against an EMPTY config — initial state has no
		// columns, so the Display header reads the "no columns yet"
		// copy. Then invoke the DisplaySection stub's captured
		// `onChange` with a populated config; the workspace routes
		// that through `updateModule(...)` against the doc store.
		// The store update Immer-publishes a new state, the workspace's
		// shallow selector picks up the new column count, and the
		// header re-renders with the populated copy. A single test
		// pins the entire workspace → mutation → derived-status loop.
		render(renderWorkspace());
		expect(screen.getByText(/No columns yet/i)).toBeDefined();
		// Pull the most-recent props passed to the stub DisplaySection.
		const calls = vi.mocked(MockedDisplaySection).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const lastProps = calls[calls.length - 1][0];
		act(() => {
			lastProps.onChange({
				...lastProps.value,
				columns: [plainColumn("name", "Patient name")],
			});
		});
		// Doc store update is synchronous — the workspace's shallow
		// selector fires the same render pass, so the new copy lands
		// without an additional rerender.
		expect(screen.getByText(/1 column/)).toBeDefined();
	});

	it("an edit through Display section survives unmount → remount via doc store persistence", () => {
		// Render the workspace with a `key` prop on the workspace
		// child so flipping the key forces an unmount + remount of
		// the workspace tree without disturbing the surrounding
		// BlueprintDocProvider. The provider's per-mount store
		// reference persists across the workspace remount, so the
		// edit committed to the doc store survives.
		const tree = (key: number): ReactNode => (
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
							caseListConfig: {
								columns: [],
								sort: [],
								calculatedColumns: [],
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
				<CaseListWorkspace key={key} moduleUuid={MODULE_UUID} />
			</BlueprintDocProvider>
		);
		const { rerender } = render(tree(0));
		// Edit a column header through the Display section's onChange.
		const calls = vi.mocked(MockedDisplaySection).mock.calls;
		const initialProps = calls[calls.length - 1][0];
		act(() => {
			initialProps.onChange({
				...initialProps.value,
				columns: [plainColumn("name", "Edited header")],
			});
		});
		expect(screen.getByText(/1 column/)).toBeDefined();
		// Unmount + remount the workspace by flipping the key. The
		// underlying BlueprintDocProvider's store stays alive because
		// the provider element is reused across the rerender.
		rerender(tree(1));
		// After remount, the new DisplaySection mount receives the
		// edited config from the doc store. The header copy reads
		// "1 column" because the doc store persisted the edit.
		expect(screen.getByText(/1 column/)).toBeDefined();
		// The header value also surfaces through the latest captured
		// props on the freshly-mounted DisplaySection stub.
		const remountCalls = vi.mocked(MockedDisplaySection).mock.calls;
		const remountedProps = remountCalls[remountCalls.length - 1][0];
		expect(remountedProps.value.columns).toHaveLength(1);
		expect(remountedProps.value.columns[0]?.header).toBe("Edited header");
	});
});
