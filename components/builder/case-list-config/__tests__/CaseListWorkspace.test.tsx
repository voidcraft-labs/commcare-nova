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

import { act, render, screen, within } from "@testing-library/react";
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
import { literal, matchAll, term } from "@/lib/domain/predicate";

import { DisplaySection as MockedDisplaySection } from "../DisplaySection";

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

	it("renders '1 filter active' when the filter slot is defined", () => {
		render(renderWorkspace({ filter: matchAll() }));
		const filterHeader = getSectionHeader("Filter");
		expect(within(filterHeader).getByText(/1 filter active/i)).toBeDefined();
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

// ── Sticky violet rail ───────────────────────────────────────────

describe("CaseListWorkspace — section header chrome", () => {
	it("renders a sticky-positioned violet rail for each section header", () => {
		render(renderWorkspace());
		const headers = document.querySelectorAll("[data-section-header]");
		// One header per section — Display, Filter, Search.
		expect(headers.length).toBe(3);
		for (const header of headers) {
			// Sticky positioning lives on the header wrapper so all three
			// pin to the scroll container's top as the user scrolls past.
			// happy-dom doesn't compile Tailwind utilities at the
			// computed-style layer, so the test inspects the className
			// for the sticky token + top-0 anchor — equivalent in a
			// real browser to `position: sticky; top: 0`.
			expect(header.className).toContain("sticky");
			expect(header.className).toContain("top-0");
			// Each header carries a violet-rail underline element. The
			// rail is the only visual border for the section — no
			// surrounding box, just the rail beneath the title.
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
});
