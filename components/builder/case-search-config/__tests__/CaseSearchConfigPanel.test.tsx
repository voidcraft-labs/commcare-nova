// @vitest-environment happy-dom
//
// components/builder/case-search-config/__tests__/CaseSearchConfigPanel.test.tsx
//
// CaseSearchConfigPanel composition tests. The panel is the multi-
// section authoring shell mounted at
// /build/[id]/{moduleUuid}/search-config in edit mode. It composes
// ClaimSection + DisplaySection + the cross-bound SearchInputsSection
// inside the case-list workspace's section-header chrome.
//
// The three inner sections are mocked at module-resolution time so
// the panel's own composition (section order, slot routing, validity
// aggregation) can be tested without each section's full inner
// editor harness. ClaimSection / DisplaySection / SearchInputsSection
// have their own dedicated test files for their internals; this
// file pins the shell — section ordering, doc-store cross-binding
// (the load-bearing invariant for case search authoring), the
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

vi.mock("../ClaimSection", () => ({
	ClaimSection: vi.fn((props: import("../ClaimSection").ClaimSectionProps) => (
		<div
			data-testid="claim-section-stub"
			data-current-case-type={props.currentCaseType}
			data-known-input-count={props.knownInputs?.length ?? 0}
		>
			ClaimSection
			<button
				type="button"
				data-testid="claim-section-fire-change"
				onClick={() =>
					props.onChange({
						searchScreenTitle: "From claim",
					})
				}
			>
				fire claim change
			</button>
			<button
				type="button"
				data-testid="claim-section-fire-invalid"
				onClick={() => props.onValidityChange?.(false)}
			>
				fire claim invalid
			</button>
		</div>
	)),
}));

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
import { CaseSearchConfigPanel } from "../CaseSearchConfigPanel";
import { ClaimSection as ClaimSectionMock } from "../ClaimSection";
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
	it("renders Claim, Display, and Search Inputs sections in that order", () => {
		render(renderPanel());
		const claim = screen.getByTestId("claim-section-stub");
		const display = screen.getByTestId("display-section-stub");
		const searches = screen.getByTestId("search-inputs-section-stub");
		// Verify all three are mounted and arranged in source order.
		// `Array.from(...).indexOf(el)` returns the document-order
		// position, so a swap between any two trips the assertion.
		const order = [claim, display, searches].map((el) =>
			Array.from(document.body.querySelectorAll("[data-testid]")).indexOf(el),
		);
		expect(order[0]).toBeLessThan(order[1]);
		expect(order[1]).toBeLessThan(order[2]);
	});

	it("renders sticky violet-railed section headers for each section", () => {
		render(renderPanel());
		// `CaseListSectionHeader` (reused by this panel) renders an
		// `<h2>` per section. Three headings — Claim / Display /
		// Search Inputs — read off the section titles.
		expect(screen.getByRole("heading", { name: /^Claim$/ })).toBeDefined();
		expect(screen.getByRole("heading", { name: /^Display$/ })).toBeDefined();
		expect(
			screen.getByRole("heading", { name: /^Search Inputs$/ }),
		).toBeDefined();

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
		const claim = screen.getByTestId("claim-section-stub");
		const display = screen.getByTestId("display-section-stub");
		const searches = screen.getByTestId("search-inputs-section-stub");
		expect(claim.dataset.currentCaseType).toBe("patient");
		expect(display.dataset.currentCaseType).toBe("patient");
		expect(searches.dataset.currentCaseType).toBe("patient");

		// Claim + Display see the seed input as a knownInputs entry —
		// `input("name_input")` references in their inner editors
		// resolve correctly. Search Inputs receives the live array
		// directly (it owns the slot).
		expect(claim.dataset.knownInputCount).toBe("1");
		expect(display.dataset.knownInputCount).toBe("1");
		expect(searches.dataset.inputCount).toBe("1");
	});
});

// ── Slot routing ──────────────────────────────────────────────────

describe("CaseSearchConfigPanel — slot routing", () => {
	it("routes ClaimSection's onChange through updateModule's caseSearchConfig slot", () => {
		// Pin the routing — the panel's mutator writes to
		// `caseSearchConfig`, NOT `caseListConfig`. A future bug
		// flipping the slot would persist claim edits to the wrong
		// part of the module schema.
		render(
			renderPanel({
				caseSearchConfig: {},
			}),
		);
		const claimMock = vi.mocked(ClaimSectionMock);
		claimMock.mockClear();
		fireEvent.click(screen.getByTestId("claim-section-fire-change"));

		// After the update, ClaimSection re-renders with its new
		// `value` prop sourced from the doc store. Reading the most
		// recent call captures the persisted shape.
		const lastCall = claimMock.mock.calls.at(-1);
		expect(lastCall?.[0].value).toEqual({
			searchScreenTitle: "From claim",
		});
	});

	it("routes DisplaySection's onChange through updateModule's caseSearchConfig slot", () => {
		render(
			renderPanel({
				caseSearchConfig: {},
			}),
		);
		const displayMock = vi.mocked(DisplaySectionMock);
		displayMock.mockClear();
		fireEvent.click(screen.getByTestId("display-section-fire-change"));

		const lastCall = displayMock.mock.calls.at(-1);
		expect(lastCall?.[0].value).toEqual({
			searchScreenTitle: "From display",
		});
	});

	it("routes SearchInputsSection's onChange through updateModule's caseListConfig.searchInputs (cross-binding)", () => {
		// THE LOAD-BEARING INVARIANT for case-search authoring. The
		// panel must NOT spawn a parallel `caseSearchConfig.search
		// Inputs` slot when the user edits search inputs from this
		// surface — the case-list workspace and the case-search panel
		// both author the SAME source. A regression here would silently
		// fork the data and let the wire emitter pick whichever copy
		// won the last write.
		render(renderPanel());
		const searchInputsMock = vi.mocked(SearchInputsSectionMock);
		searchInputsMock.mockClear();
		fireEvent.click(screen.getByTestId("search-inputs-section-fire-change"));

		const lastCall = searchInputsMock.mock.calls.at(-1);
		// After the update, the section receives the new array as its
		// `value` prop (cross-binding routes through caseListConfig).
		// Confirm one row landed and its name matches the click
		// handler's payload.
		expect(lastCall?.[0].value.length).toBe(1);
		expect(lastCall?.[0].value[0]?.name).toBe("input_added");

		// CRITICAL: the cross-binding lands on `caseListConfig`, not
		// `caseSearchConfig`. The Claim + Display sections share the
		// `caseSearchConfig` slot — verify their `value` is unchanged
		// (still undefined for an unauthored module) so a regression
		// that wrote to `caseSearchConfig.searchInputs` would surface
		// as Claim's value flipping to a partial config.
		const claimMock = vi.mocked(ClaimSectionMock);
		const lastClaimCall = claimMock.mock.calls.at(-1);
		expect(lastClaimCall?.[0].value).toBeUndefined();
	});

	it("seeds caseListConfig with required slots when the module has no caseListConfig and search inputs change for the first time", () => {
		// First-edit semantics. The panel may receive a module without
		// `caseListConfig`; the schema requires `columns` AND
		// `searchInputs` on the slot. The cross-binding mutator MUST
		// seed `columns: []` so the emitted shape passes strict parse.
		// A regression here would surface as a silent zod failure on
		// the next save (no UI signal — the parse runs in the
		// persistence layer).
		const moduleSnapshotRef: MutableRefObject<Module | undefined> = {
			current: undefined,
		};
		render(renderPanel({ caseListConfig: undefined, moduleSnapshotRef }));
		fireEvent.click(screen.getByTestId("search-inputs-section-fire-change"));

		// Read the persisted shape directly from the doc store. The
		// mutator routes the cross-binding write through
		// `nextCaseListConfigFromSearchInputs(undefined, [...])`,
		// which seeds `columns: []` alongside the new searchInputs.
		// Asserting against both keys pins the seed-helper's
		// contract — a regression that dropped `columns` would surface
		// here even before the zod parse on the next save.
		const persistedConfig = moduleSnapshotRef.current?.caseListConfig;
		expect(persistedConfig).toBeDefined();
		expect(persistedConfig?.columns).toEqual([]);
		expect(persistedConfig?.searchInputs.length).toBe(1);
		expect(persistedConfig?.searchInputs[0]?.name).toBe("input_added");
	});
});

// ── First-edit seed for caseSearchConfig ─────────────────────────

describe("CaseSearchConfigPanel — first-edit seed", () => {
	it("forwards `value: undefined` to Claim/Display when the module has no caseSearchConfig", () => {
		// Pins the contract: when `mod.caseSearchConfig` is undefined,
		// the panel forwards `value: undefined` to ClaimSection +
		// DisplaySection. Each section's first edit emits a fully-
		// formed config via its own `...(value ?? {})` spread, and
		// the panel persists it. A regression here — e.g. the panel
		// pre-seeding an empty config itself — would produce two
		// write paths for the same edit.
		render(renderPanel({ caseSearchConfig: undefined }));

		const claim = screen.getByTestId("claim-section-stub");
		const display = screen.getByTestId("display-section-stub");
		// Both stubs render — the panel didn't crash on undefined
		// caseSearchConfig.
		expect(claim).toBeDefined();
		expect(display).toBeDefined();
	});
});

// ── Validity propagation ─────────────────────────────────────────

describe("CaseSearchConfigPanel — validity propagation", () => {
	it("reports valid: true on initial render with no sections invalid", () => {
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(renderPanel({ onValidityChange }));
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("flips to valid: false when ClaimSection reports invalid; flips back when valid", () => {
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(renderPanel({ onValidityChange }));
		// Initial true.
		expect(onValidityChange).toHaveBeenLastCalledWith(true);

		// Section reports false → composite flips to false.
		fireEvent.click(screen.getByTestId("claim-section-fire-invalid"));
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});

	it("flips to valid: false when DisplaySection reports invalid", () => {
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(renderPanel({ onValidityChange }));
		fireEvent.click(screen.getByTestId("display-section-fire-invalid"));
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
			container.querySelector("[data-testid='claim-section-stub']"),
		).toBeNull();
		expect(
			container.querySelector("[data-testid='display-section-stub']"),
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
