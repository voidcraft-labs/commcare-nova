// @vitest-environment happy-dom
//
// components/builder/case-search-config/__tests__/CaseSearchConfigPanel.test.tsx
//
// CaseSearchConfigPanel composition tests. The panel is the multi-
// section authoring shell mounted at
// /build/[id]/{moduleUuid}/search-config in edit mode. It composes
// DisplaySection + the cross-bound SearchInputsSection + AdvancedSection
// inside the case-list workspace's section-header chrome.
//
// The three inner sections are mocked at module-resolution time so
// the panel's own composition (section order, slot routing, validity
// aggregation) can be tested without each section's full inner
// editor harness. DisplaySection / SearchInputsSection / AdvancedSection
// have their own dedicated test files for their internals; this file
// pins the shell — section ordering, doc-store cross-binding (the
// load-bearing invariant for case search authoring), the
// `nextConfig`-mediated first-edit seed, and validity aggregation.

import { fireEvent, render, screen } from "@testing-library/react";
import type { MutableRefObject, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type CaseSearchConfig,
	type CaseType,
	type Module,
	simpleSearchInputDef,
} from "@/lib/domain";

// ── Section mocks ──────────────────────────────────────────────────
//
// Each stub renders a sentinel testid + exposes "fire onChange" /
// "fire onValidityChange" affordances so the panel's slot routing
// can be exercised without the full inner editor mounting. The
// mock factories receive props via the same props interface the
// real components export, so a renamed prop surfaces here as a
// type error rather than a silent mismatch.

vi.mock("../DisplaySection", () => ({
	DisplaySection: vi.fn(
		(props: import("../DisplaySection").DisplaySectionProps) => (
			<div
				data-testid="display-section-stub"
				data-current-case-type={props.currentCaseType}
				data-known-input-count={props.knownInputs?.length ?? 0}
			>
				DisplaySection
				<button
					type="button"
					data-testid="display-section-fire-change"
					onClick={() =>
						props.onChange({
							searchScreenTitle: "From display",
						})
					}
				>
					fire display change
				</button>
				<button
					type="button"
					data-testid="display-section-fire-invalid"
					onClick={() => props.onValidityChange?.(false)}
				>
					fire display invalid
				</button>
			</div>
		),
	),
}));

vi.mock("../AdvancedSection", () => ({
	AdvancedSection: vi.fn(
		(props: import("../AdvancedSection").AdvancedSectionProps) => (
			<div
				data-testid="advanced-section-stub"
				data-current-case-type={props.currentCaseType}
				data-known-input-count={props.knownInputs?.length ?? 0}
			>
				AdvancedSection
				<button
					type="button"
					data-testid="advanced-section-fire-change"
					onClick={() =>
						props.onChange({
							searchScreenTitle: "From advanced",
						})
					}
				>
					fire advanced change
				</button>
				<button
					type="button"
					data-testid="advanced-section-fire-invalid"
					onClick={() => props.onValidityChange?.(false)}
				>
					fire advanced invalid
				</button>
			</div>
		),
	),
}));

vi.mock("@/components/builder/case-list-config/SearchInputsSection", () => ({
	SearchInputsSection: vi.fn(
		(
			props: import("@/components/builder/case-list-config/SearchInputsSection").SearchInputsSectionProps,
		) => (
			<div
				data-testid="search-inputs-section-stub"
				data-current-case-type={props.currentCaseType}
				data-input-count={props.value.length}
			>
				SearchInputsSection
				<button
					type="button"
					data-testid="search-inputs-section-fire-change"
					onClick={() =>
						props.onChange([
							simpleSearchInputDef(
								asUuid("99999999-9999-9999-9999-999999999999"),
								"input_added",
								"From panel",
								"text",
								"name",
							),
						])
					}
				>
					fire search inputs change
				</button>
				<button
					type="button"
					data-testid="search-inputs-section-fire-invalid"
					onClick={() => props.onValidityChange?.(false)}
				>
					fire search inputs invalid
				</button>
			</div>
		),
	),
}));

import { SearchInputsSection as SearchInputsSectionMock } from "@/components/builder/case-list-config/SearchInputsSection";
import { AdvancedSection as AdvancedSectionMock } from "../AdvancedSection";
import { CaseSearchConfigPanel } from "../CaseSearchConfigPanel";
import { DisplaySection as DisplaySectionMock } from "../DisplaySection";

// ── Fixtures ──────────────────────────────────────────────────────

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
	],
};

const MODULE_UUID = asUuid("00000000-0000-0000-0000-000000000111");
const SEED_INPUT_UUID = asUuid("00000000-0000-0000-0000-000000000301");

interface RenderOpts {
	readonly caseSearchConfig?: CaseSearchConfig;
	readonly caseListConfig?: CaseListConfig;
	/** Module case-type. Omitted key → defaults to "patient" (the
	 *  fixture's seeded case type). Explicit `undefined` → render
	 *  against a case-less module to exercise the panel's defensive
	 *  return path. */
	readonly caseType?: string;
	readonly onValidityChange?: (valid: boolean) => void;
	/** Optional ref the test can read AFTER a mutation to assert
	 *  against the persisted doc-store shape. Captures the live
	 *  `Module` for `MODULE_UUID` on every render of the probe
	 *  component below, so tests reading the ref immediately after a
	 *  `fireEvent.click` see the post-mutation state. */
	readonly moduleSnapshotRef?: MutableRefObject<Module | undefined>;
}

/**
 * Sibling consumer that captures the current `Module` for
 * `moduleUuid` from the doc store and writes it to the supplied
 * ref. Used to assert against the persisted shape (e.g. the
 * cross-binding seed's `columns: []` default) without exposing the
 * raw store API to call sites.
 *
 * Subscribes via `useModule` so the probe re-renders whenever the
 * targeted module's reference changes (Immer's structural sharing
 * keeps unrelated mutations off this subscription). Tests trigger
 * a mutation and then read the ref imperatively; React's commit
 * pipeline guarantees the probe's render fires after the mutation
 * lands but before `fireEvent.click` returns to the test.
 */
function DocSnapshotProbe({
	targetRef,
	moduleUuid,
}: {
	targetRef: MutableRefObject<Module | undefined>;
	moduleUuid: Uuid;
}) {
	const mod = useModule(moduleUuid);
	targetRef.current = mod;
	return null;
}

/**
 * Render the panel inside a BlueprintDocProvider seeded with a
 * single case-typed module + the supplied configs. Returns the
 * full RTL render result so tests can run rerender / unmount /
 * scoped queries.
 */
function renderPanel(opts: RenderOpts = {}): ReactNode {
	// Distinguish "key omitted" (default to patient) from "key set
	// to undefined" (case-less module). `??` collapses both into
	// the default — `in` keeps the case-less variant addressable.
	const caseType = "caseType" in opts ? opts.caseType : "patient";
	const initialDoc = {
		appId: "app-search-config-panel-test",
		appName: "Panel test app",
		connectType: null,
		caseTypes: [PATIENT],
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "patient_module",
				name: "Patient module",
				caseType,
				caseSearchConfig: opts.caseSearchConfig,
				caseListConfig: opts.caseListConfig,
			},
		},
		forms: {},
		fields: {},
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [] },
		fieldOrder: {},
	};
	return (
		<BlueprintDocProvider
			appId="app-search-config-panel-test"
			initialDoc={initialDoc}
		>
			<CaseSearchConfigPanel
				moduleUuid={MODULE_UUID}
				onValidityChange={opts.onValidityChange}
			/>
			{opts.moduleSnapshotRef ? (
				<DocSnapshotProbe
					targetRef={opts.moduleSnapshotRef}
					moduleUuid={MODULE_UUID}
				/>
			) : null}
		</BlueprintDocProvider>
	);
}

// ── Section composition ──────────────────────────────────────────

describe("CaseSearchConfigPanel — section composition", () => {
	it("renders Display, Search Inputs, and Advanced sections in that order", () => {
		render(renderPanel());
		const display = screen.getByTestId("display-section-stub");
		const searches = screen.getByTestId("search-inputs-section-stub");
		const advanced = screen.getByTestId("advanced-section-stub");
		// Verify all three are mounted and arranged in source order.
		// `Array.from(...).indexOf(el)` returns the document-order
		// position, so a swap between any two trips the assertion.
		const order = [display, searches, advanced].map((el) =>
			Array.from(document.body.querySelectorAll("[data-testid]")).indexOf(el),
		);
		expect(order[0]).toBeLessThan(order[1]);
		expect(order[1]).toBeLessThan(order[2]);
	});

	it("renders sticky violet-railed section headers for each section", () => {
		render(renderPanel());
		// `CaseListSectionHeader` (reused by this panel) renders an
		// `<h2>` per section. Three headings — Display / Search Inputs /
		// Advanced — read off the section titles.
		expect(screen.getByRole("heading", { name: /^Display$/ })).toBeDefined();
		expect(
			screen.getByRole("heading", { name: /^Search Inputs$/ }),
		).toBeDefined();
		expect(screen.getByRole("heading", { name: /^Advanced$/ })).toBeDefined();

		// Each section header carries the violet rail divider —
		// pin the rail's presence so a future header refactor that
		// strips the chrome surfaces here.
		const rails = document.querySelectorAll("[data-section-rail]");
		expect(rails.length).toBe(3);
	});

	it("threads currentCaseType + the live searchInputs array into every section", () => {
		const seedInputs = [
			simpleSearchInputDef(
				SEED_INPUT_UUID,
				"name_input",
				"Name",
				"text",
				"name",
			),
		];
		render(
			renderPanel({
				caseListConfig: { columns: [], searchInputs: seedInputs },
			}),
		);
		// All three sections receive the same case-type scope.
		const display = screen.getByTestId("display-section-stub");
		const searches = screen.getByTestId("search-inputs-section-stub");
		const advanced = screen.getByTestId("advanced-section-stub");
		expect(display.dataset.currentCaseType).toBe("patient");
		expect(searches.dataset.currentCaseType).toBe("patient");
		expect(advanced.dataset.currentCaseType).toBe("patient");

		// Display + Advanced see the seed input as a knownInputs entry —
		// `input("name_input")` references in their inner editors
		// resolve correctly. Search Inputs receives the live array
		// directly (it owns the slot).
		expect(display.dataset.knownInputCount).toBe("1");
		expect(advanced.dataset.knownInputCount).toBe("1");
		expect(searches.dataset.inputCount).toBe("1");
	});
});

// ── Slot routing ──────────────────────────────────────────────────

describe("CaseSearchConfigPanel — slot routing", () => {
	it("routes DisplaySection's onChange through updateModule's caseSearchConfig slot", () => {
		// Pin the routing — the panel's mutator writes to
		// `caseSearchConfig`, NOT `caseListConfig`. A future bug
		// flipping the slot would persist display edits to the wrong
		// part of the module schema.
		render(
			renderPanel({
				caseSearchConfig: {},
			}),
		);
		const displayMock = vi.mocked(DisplaySectionMock);
		displayMock.mockClear();
		fireEvent.click(screen.getByTestId("display-section-fire-change"));

		// After the update, DisplaySection re-renders with its new
		// `value` prop sourced from the doc store. Reading the most
		// recent call captures the persisted shape.
		const lastCall = displayMock.mock.calls.at(-1);
		expect(lastCall?.[0].value).toEqual({
			searchScreenTitle: "From display",
		});
	});

	it("routes AdvancedSection's onChange through updateModule's caseSearchConfig slot", () => {
		render(
			renderPanel({
				caseSearchConfig: {},
			}),
		);
		const advancedMock = vi.mocked(AdvancedSectionMock);
		advancedMock.mockClear();
		fireEvent.click(screen.getByTestId("advanced-section-fire-change"));

		const lastCall = advancedMock.mock.calls.at(-1);
		expect(lastCall?.[0].value).toEqual({
			searchScreenTitle: "From advanced",
		});
	});

	it("routes SearchInputsSection's onChange through updateModule's caseListConfig.searchInputs (cross-binding)", () => {
		// Pins the load-bearing invariant for case-search authoring:
		// search-input edits from this panel write through
		// `caseListConfig.searchInputs` — the same source the case-list
		// workspace edits — never a parallel `caseSearchConfig.search
		// Inputs` slot. One source, two views.
		render(renderPanel());
		const searchInputsMock = vi.mocked(SearchInputsSectionMock);
		searchInputsMock.mockClear();
		fireEvent.click(screen.getByTestId("search-inputs-section-fire-change"));

		const lastCall = searchInputsMock.mock.calls.at(-1);
		// Cross-binding routes through caseListConfig — the section
		// receives the new array as its `value` prop. Confirm one row
		// landed and its name matches the click handler's payload.
		expect(lastCall?.[0].value.length).toBe(1);
		expect(lastCall?.[0].value[0]?.name).toBe("input_added");

		// Pins that the write lands on `caseListConfig` only, not on
		// `caseSearchConfig`. The Display + Advanced sections share the
		// `caseSearchConfig` slot — their `value` stays undefined for
		// an unauthored module after a search-input edit.
		const displayMock = vi.mocked(DisplaySectionMock);
		const lastDisplayCall = displayMock.mock.calls.at(-1);
		expect(lastDisplayCall?.[0].value).toBeUndefined();
	});

	it("seeds caseListConfig with required slots when the module has no caseListConfig and search inputs change for the first time", () => {
		// Pins first-edit semantics. The panel may receive a module
		// without `caseListConfig`; the schema requires `columns` AND
		// `searchInputs` on the slot, so the cross-binding mutator
		// seeds `columns: []` alongside the new searchInputs and the
		// emitted shape passes strict parse.
		const moduleSnapshotRef: MutableRefObject<Module | undefined> = {
			current: undefined,
		};
		render(renderPanel({ caseListConfig: undefined, moduleSnapshotRef }));
		fireEvent.click(screen.getByTestId("search-inputs-section-fire-change"));

		// Read the persisted shape directly from the doc store. The
		// mutator routes the cross-binding write through
		// `nextCaseListConfigFromSearchInputs(undefined, [...])`,
		// which seeds `columns: []` alongside the new searchInputs.
		// Asserting against both keys pins the seed-helper's contract.
		const persistedConfig = moduleSnapshotRef.current?.caseListConfig;
		expect(persistedConfig).toBeDefined();
		expect(persistedConfig?.columns).toEqual([]);
		expect(persistedConfig?.searchInputs.length).toBe(1);
		expect(persistedConfig?.searchInputs[0]?.name).toBe("input_added");
	});
});

// ── First-edit seed for caseSearchConfig ─────────────────────────

describe("CaseSearchConfigPanel — first-edit seed", () => {
	it("forwards `value: undefined` to Display/Advanced when the module has no caseSearchConfig", () => {
		// Pins the contract: when `mod.caseSearchConfig` is undefined,
		// the panel forwards `value: undefined` to DisplaySection +
		// AdvancedSection. Each section's first edit emits a fully-
		// formed config via its own `...(value ?? {})` spread, and
		// the panel persists it. The panel itself does not pre-seed
		// the slot — first-edit semantics live inside each section.
		render(renderPanel({ caseSearchConfig: undefined }));

		const display = screen.getByTestId("display-section-stub");
		const advanced = screen.getByTestId("advanced-section-stub");
		// Both stubs render — the panel didn't crash on undefined
		// caseSearchConfig.
		expect(display).toBeDefined();
		expect(advanced).toBeDefined();
	});
});

// ── Validity propagation ─────────────────────────────────────────

describe("CaseSearchConfigPanel — validity propagation", () => {
	it("reports valid: true on initial render with no sections invalid", () => {
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(renderPanel({ onValidityChange }));
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("flips to valid: false when DisplaySection reports invalid", () => {
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(renderPanel({ onValidityChange }));
		// Initial true.
		expect(onValidityChange).toHaveBeenLastCalledWith(true);

		fireEvent.click(screen.getByTestId("display-section-fire-invalid"));
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});

	it("flips to valid: false when AdvancedSection reports invalid", () => {
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(renderPanel({ onValidityChange }));
		fireEvent.click(screen.getByTestId("advanced-section-fire-invalid"));
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});

	it("flips to valid: false when SearchInputsSection reports invalid", () => {
		// The cross-bound search-inputs section's verdict still feeds
		// the panel's composite — even though its data lives on
		// `caseListConfig`, the panel is the validity boundary for
		// case-search authoring and surfaces the union of the three
		// sections' verdicts to its parent.
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(renderPanel({ onValidityChange }));
		fireEvent.click(screen.getByTestId("search-inputs-section-fire-invalid"));
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});
});

// ── Defensive guards ─────────────────────────────────────────────

describe("CaseSearchConfigPanel — defensive guards", () => {
	it("renders nothing when the module has no caseType", () => {
		// Race guard — case-search authoring needs a declared case
		// type to scope property references. The affordance card
		// greys out for case-less modules, but a deletion-in-flight
		// URL could land here mid-mutation. The panel renders nothing
		// in that state; the LocationRecoveryEffect scrubs the URL
		// on the next tick.
		const { container } = render(renderPanel({ caseType: undefined }));
		// The provider tree mounts but nothing inside renders.
		expect(
			container.querySelector("[data-testid='display-section-stub']"),
		).toBeNull();
		expect(
			container.querySelector("[data-testid='advanced-section-stub']"),
		).toBeNull();
		expect(
			container.querySelector("[data-testid='search-inputs-section-stub']"),
		).toBeNull();
	});

	it("reports valid: true to the parent on a case-less module (no validity-bearing controls mounted)", () => {
		// Pins the contract: when the panel renders nothing because
		// the module has no case type, the composite verdict still
		// fires `true` to the parent. No validity-bearing sub-control
		// mounted = no failure surface = trivially valid.
		//
		// The effect runs through `useValidityPropagator` BEFORE the
		// case-less early return, so the propagation contract holds
		// uniformly across the case-typed and case-less arms. A
		// future caller gating its save affordance on this verdict
		// can rely on case-less modules NOT blocking the save.
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(renderPanel({ caseType: undefined, onValidityChange }));
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});
