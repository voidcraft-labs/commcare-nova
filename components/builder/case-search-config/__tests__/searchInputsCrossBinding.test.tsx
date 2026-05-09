// @vitest-environment happy-dom
//
// components/builder/case-search-config/__tests__/searchInputsCrossBinding.test.tsx
//
// Cross-binding contract test. The case-list workspace's
// SearchInputsSection mount and the case-search-config panel's
// SearchInputsSection mount are TWO authoring surfaces for the SAME
// `mod.caseListConfig.searchInputs` array. Editing inputs from
// EITHER surface persists through `caseListConfig` — never through
// a parallel `caseSearchConfig.searchInputs` slot.
//
// The test mounts both workspaces inside ONE `BlueprintDocProvider`
// so they share a single Zustand store instance. Mounting them
// under separate providers would each spin up its own store and
// any "cross-binding" assertion would be tautologically true (both
// surfaces would just see whatever state was pre-seeded in their
// own private store). The single-provider mount is the only setup
// where this contract is genuinely under test.
//
// The two workspaces' SHELL chrome — the cards, status lines,
// per-section editors that don't own the searchInputs slot — are
// mocked out at module-resolution time so their inner harnesses
// (FiltersPreview's Server Action, the claim/display sections'
// editors) don't fire during cross-binding exercises. The shared
// `SearchInputsSection` is left UNMOCKED — both workspaces resolve
// to the same real component, and tests click into its actual
// affordances (Add / Convert / type pickers) to drive mutations.
//
// Doc-store state is read post-mutation through `DocSnapshotProbe`
// (the same pattern `CaseSearchConfigPanel.test.tsx` introduced) so
// assertions run against the persisted shape — not the rendered
// view, which can lag by a microtask.

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import {
	advancedSearchInputDef,
	type CaseType,
	exactMode,
	type Module,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	literal,
	matchAll,
	relationStep,
	term,
} from "@/lib/domain/predicate";

// ── Section mocks ──────────────────────────────────────────────────
//
// Stub the workspace shells so only the shared `SearchInputsSection`
// runs its real implementation. The case-list workspace's
// FiltersPreview would otherwise fire its Server Action under
// happy-dom; the case-search panel's claim/display editors would
// pull in their own type-checked predicate harnesses. Neither owns
// the slot under test — keeping them out of the tree narrows the
// test's blast radius to the cross-binding contract itself.

vi.mock("@/components/builder/case-list-config/DisplaySection", () => ({
	DisplaySection: vi.fn(() => (
		<div data-testid="caselist-display-section-stub" />
	)),
}));

vi.mock("@/components/builder/case-list-config/FiltersSection", () => ({
	FiltersSection: vi.fn(() => (
		<div data-testid="caselist-filters-section-stub" />
	)),
}));

vi.mock("@/components/builder/case-search-config/ClaimSection", () => ({
	ClaimSection: vi.fn(() => <div data-testid="search-claim-section-stub" />),
}));

vi.mock("@/components/builder/case-search-config/DisplaySection", () => ({
	DisplaySection: vi.fn(() => (
		<div data-testid="search-display-section-stub" />
	)),
}));

// `useAppId` is sourced from BuilderSessionProvider in production.
// CaseListWorkspace forwards the appId to its inner sections — all
// stubbed in this file — so the lightweight mock keeps the test off
// the full session-provider stack. The CaseSearchConfigPanel doesn't
// read appId.
vi.mock("@/lib/session/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/session/hooks")>(
		"@/lib/session/hooks",
	);
	return {
		...actual,
		useAppId: () => "app-cross-binding-test",
	};
});

import { CaseListWorkspace } from "@/components/builder/case-list-config/CaseListWorkspace";
import { CaseSearchConfigPanel } from "../CaseSearchConfigPanel";

// ── Fixtures ──────────────────────────────────────────────────────

const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "address", label: "Address", data_type: "text" }],
};

const MODULE_UUID = asUuid("00000000-0000-0000-0000-000000000111");

// Stable uuids for fixture rows. Tests assert against these values
// after a round-trip across workspaces — uuid identity is a slot
// the cross-binding contract MUST preserve (it's the React key /
// drag-handle id consumers depend on).
const SIMPLE_INPUT_UUID = asUuid("00000000-0000-0000-0000-00000000a001");
const ADVANCED_INPUT_UUID = asUuid("00000000-0000-0000-0000-00000000a002");

// ── DocSnapshotProbe ──────────────────────────────────────────────
//
// Sibling consumer that captures the live `Module` from the doc
// store and writes it to the supplied ref. Used to assert against
// the persisted shape after a mutation without exposing the raw
// store API to call sites.
//
// Subscribes via `useModule` so the probe re-renders whenever the
// targeted module's reference changes (Immer's structural sharing
// keeps unrelated mutations off this subscription). React's commit
// pipeline guarantees the probe's render fires before
// `fireEvent.click` returns to the test, so reads against the ref
// observe the post-mutation state.

interface DocSnapshotProbeProps {
	readonly targetRef: MutableRefObject<Module | undefined>;
	readonly moduleUuid: Uuid;
}

function DocSnapshotProbe({ targetRef, moduleUuid }: DocSnapshotProbeProps) {
	const mod = useModule(moduleUuid);
	targetRef.current = mod;
	return null;
}

// ── Cross-binding harness ─────────────────────────────────────────
//
// One `BlueprintDocProvider` wraps both workspaces + the snapshot
// probe. Mounting under separate providers would create separate
// stores and the test would pass tautologically — the cross-binding
// invariant is that writes through ONE store land on the same array
// both surfaces read.

interface RenderHarnessOpts {
	/** Initial searchInputs to seed onto `caseListConfig`. Defaults
	 *  to an empty array — tests that exercise the Add path expect
	 *  an empty list, while round-trip tests pre-seed the row(s)
	 *  they round-trip to bypass the auto-generated name + uuid the
	 *  Add affordance produces. */
	readonly searchInputs?: readonly SearchInputDef[];
}

interface RenderHarnessResult {
	/** Scoped query root for the case-list workspace mount. Tests
	 *  use `within(scope.caseList).getByRole(...)` to disambiguate
	 *  affordances that exist in both workspace mounts (e.g. each
	 *  workspace renders its own "Add search input" button). */
	readonly caseList: HTMLElement;
	/** Scoped query root for the case-search-config panel mount. */
	readonly searchConfig: HTMLElement;
	/** Live snapshot of the targeted module — read after each
	 *  mutation to assert against the persisted shape. */
	readonly moduleSnapshotRef: MutableRefObject<Module | undefined>;
}

function renderHarness(opts: RenderHarnessOpts = {}): RenderHarnessResult {
	const moduleSnapshotRef: MutableRefObject<Module | undefined> = {
		current: undefined,
	};
	render(
		<BlueprintDocProvider
			appId="app-cross-binding-test"
			initialDoc={{
				appId: "app-cross-binding-test",
				appName: "Cross-binding test app",
				connectType: null,
				caseTypes: [PATIENT, HOUSEHOLD],
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "patient_module",
						name: "Patient module",
						caseType: "patient",
						caseListConfig: {
							columns: [],
							searchInputs: opts.searchInputs ? [...opts.searchInputs] : [],
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
			<div data-testid="caselist-host">
				<CaseListWorkspace moduleUuid={MODULE_UUID} />
			</div>
			<div data-testid="searchconfig-host">
				<CaseSearchConfigPanel moduleUuid={MODULE_UUID} />
			</div>
			<DocSnapshotProbe
				targetRef={moduleSnapshotRef}
				moduleUuid={MODULE_UUID}
			/>
		</BlueprintDocProvider>,
	);
	return {
		caseList: screen.getByTestId("caselist-host"),
		searchConfig: screen.getByTestId("searchconfig-host"),
		moduleSnapshotRef,
	};
}

/**
 * Read the persisted searchInputs from the snapshot ref. Throws if
 * the snapshot or its `caseListConfig` slot is missing, which
 * surfaces the failure at the test site rather than as a confusing
 * `undefined.length` later in the assertion chain.
 */
function readPersistedInputs(
	moduleSnapshotRef: MutableRefObject<Module | undefined>,
): readonly SearchInputDef[] {
	const persisted = moduleSnapshotRef.current?.caseListConfig?.searchInputs;
	if (persisted === undefined) {
		throw new Error(
			"Expected `caseListConfig.searchInputs` to be persisted on the snapshot, but the snapshot was missing the slot.",
		);
	}
	return persisted;
}

/**
 * Resolve the SearchInputsSection's "Add search input" affordance
 * inside a workspace scope. Both the workspace's empty-state CTA
 * card AND the section's own append affordance share the
 * "Add search input" label — when the search list is empty, both
 * exist in the same scope. The section's own button is the one
 * inside the section's editor list (rendered as a bordered-dashed
 * `<button>`), and is the consistent target across both populated
 * and empty states. We use `getAllByRole` and pick the LAST match,
 * which is the section's own button — its position in the DOM is
 * after the workspace's empty-state CTA.
 */
function findSectionAddAffordance(scope: HTMLElement): HTMLButtonElement {
	const candidates = within(scope).getAllByRole("button", {
		name: /^add search input$/i,
	}) as HTMLButtonElement[];
	const last = candidates.at(-1);
	if (last === undefined) {
		throw new Error(
			"Expected an 'Add search input' affordance inside the workspace scope, but none was found.",
		);
	}
	return last;
}

// ── Persistence-slot pin ──────────────────────────────────────────

describe("Search-inputs cross-binding — persistence slot", () => {
	it("never writes a parallel `caseSearchConfig.searchInputs` slot — edits land on `caseListConfig.searchInputs`", () => {
		// Add a row through the case-search-config panel's mount and
		// confirm the persisted shape on the snapshot:
		//   - `caseListConfig.searchInputs` carries the new row, AND
		//   - the (typed) `caseSearchConfig` slot has no `searchInputs`
		//     property bag bolted on (the schema doesn't carry one;
		//     `Object.hasOwn` runtime-confirms no escape-hatch leak).
		// A regression that wrote to a parallel slot would surface
		// here even before the wire emitter saw it, because the doc-
		// store's strict TypeScript typing wouldn't catch a runtime
		// `Object.assign` of an extra key.
		const { searchConfig, moduleSnapshotRef } = renderHarness();
		fireEvent.click(findSectionAddAffordance(searchConfig));

		const persisted = readPersistedInputs(moduleSnapshotRef);
		expect(persisted.length).toBe(1);

		// `caseSearchConfig` slot is untouched by a search-inputs
		// edit — Claim + Display are the only sections that write to
		// it, and neither fired. The slot stays undefined on this
		// fresh module.
		const caseSearchConfig = moduleSnapshotRef.current?.caseSearchConfig;
		expect(caseSearchConfig).toBeUndefined();
	});
});

// ── Add round-trip — simple arm ───────────────────────────────────

describe("Search-inputs cross-binding — simple-arm add", () => {
	it("adds a `kind: 'simple'` row from the case-search-config panel and propagates to the case-list workspace", () => {
		const { caseList, searchConfig, moduleSnapshotRef } = renderHarness();

		// Both workspaces render against an empty list — neither
		// surface shows any rows yet. Confirm the precondition so a
		// regression that pre-seeded a row trips here.
		expect(readPersistedInputs(moduleSnapshotRef).length).toBe(0);

		// Add a row from the case-search-config panel.
		fireEvent.click(findSectionAddAffordance(searchConfig));

		// Persisted shape carries the new row on the simple arm
		// (the section's `appendRow` seeds `kind: "simple"` with a
		// fresh uuid + auto-generated name + empty property).
		const persisted = readPersistedInputs(moduleSnapshotRef);
		expect(persisted.length).toBe(1);
		const row = persisted[0];
		if (row === undefined) throw new Error("expected one row");
		expect(row.kind).toBe("simple");

		// The case-list workspace's SearchInputsSection mount sees the
		// same row — the section renders one row's grip-handle
		// affordance per row, and the auto-generated name fills the
		// row's name input. Asserting the count of grip handles inside
		// the case-list scope ties the assertion to the visible UI
		// rather than any internal state.
		const handles = within(caseList).getAllByRole("button", {
			name: /reorder search input/i,
		});
		expect(handles.length).toBe(1);
	});
});

// ── Add round-trip — advanced arm ─────────────────────────────────

describe("Search-inputs cross-binding — advanced-arm add", () => {
	it("adds an advanced-arm row from the case-list workspace (via convert) and propagates to the case-search-config panel", () => {
		// `appendRow` always seeds the simple arm — the path to an
		// advanced-arm row is "Add → Convert to advanced". The flow
		// runs entirely inside the case-list workspace's mount; the
		// case-search panel observes the resulting advanced row via
		// the doc store.
		const { caseList, searchConfig, moduleSnapshotRef } = renderHarness();
		fireEvent.click(findSectionAddAffordance(caseList));

		// One simple-arm row is now present. Click "Convert to
		// advanced" inside the case-list scope to flip its
		// discriminator. The label's row-index suffix ("search input
		// 1 to advanced") makes the affordance unambiguous when
		// multiple rows exist; here there's only one.
		const convertButton = within(caseList).getByRole("button", {
			name: /convert search input 1 to advanced/i,
		});
		fireEvent.click(convertButton);

		// Persisted shape now carries an advanced-arm row.
		const persisted = readPersistedInputs(moduleSnapshotRef);
		expect(persisted.length).toBe(1);
		const row = persisted[0];
		if (row === undefined) throw new Error("expected one row");
		expect(row.kind).toBe("advanced");

		// The case-search panel sees the advanced-arm row reflected
		// in its mount: the convert affordance's label flips to
		// "Convert search input 1 to simple", which is the panel-side
		// observable for the discriminator change.
		expect(
			within(searchConfig).getByRole("button", {
				name: /convert search input 1 to simple/i,
			}),
		).toBeDefined();
	});
});

// ── Convert round-trip — simple → advanced ────────────────────────

describe("Search-inputs cross-binding — convert simple → advanced", () => {
	it("flips a row's discriminator from the case-list workspace and surfaces in the case-search-config panel", () => {
		// Pre-seed a simple-arm row with a known property so the
		// convert path produces a `prop = ''` predicate (not the
		// `match-all()` fallback used when no property is set).
		const seed: SearchInputDef = simpleSearchInputDef(
			SIMPLE_INPUT_UUID,
			"name_input",
			"Name",
			"text",
			"name",
		);
		const { caseList, searchConfig, moduleSnapshotRef } = renderHarness({
			searchInputs: [seed],
		});

		// Pre-conversion: both workspaces see the simple arm via its
		// "Convert to advanced" affordance.
		expect(
			within(caseList).getByRole("button", {
				name: /convert search input 1 to advanced/i,
			}),
		).toBeDefined();
		expect(
			within(searchConfig).getByRole("button", {
				name: /convert search input 1 to advanced/i,
			}),
		).toBeDefined();

		// Fire the conversion from the case-list workspace.
		fireEvent.click(
			within(caseList).getByRole("button", {
				name: /convert search input 1 to advanced/i,
			}),
		);

		// Persisted shape: the row's discriminator is now `advanced`
		// and the predicate seeds as `prop(patient, "name") eq ""` —
		// the simple-arm property + mode resolve into a comparison
		// predicate the user can edit further.
		const persisted = readPersistedInputs(moduleSnapshotRef);
		expect(persisted.length).toBe(1);
		const row = persisted[0];
		if (row === undefined || row.kind !== "advanced") {
			throw new Error("expected advanced row");
		}
		expect(row.uuid).toBe(SIMPLE_INPUT_UUID);
		expect(row.predicate.kind).toBe("eq");

		// The case-search panel sees the same conversion — its
		// affordance's destination flips to "to simple".
		expect(
			within(searchConfig).getByRole("button", {
				name: /convert search input 1 to simple/i,
			}),
		).toBeDefined();
	});
});

// ── Convert round-trip — advanced → simple ────────────────────────

describe("Search-inputs cross-binding — convert advanced → simple", () => {
	it("flips a row's discriminator from the case-search-config panel and surfaces in the case-list workspace", () => {
		// Pre-seed an advanced-arm row carrying a `match-all` predicate
		// (any-row-matches sentinel — the canonical seed for the
		// advanced arm when no domain content is yet authored).
		const seed: SearchInputDef = advancedSearchInputDef(
			ADVANCED_INPUT_UUID,
			"any_input",
			"Any",
			"text",
			matchAll(),
		);
		const { caseList, searchConfig, moduleSnapshotRef } = renderHarness({
			searchInputs: [seed],
		});

		// Pre-conversion: both workspaces see the advanced arm.
		expect(
			within(caseList).getByRole("button", {
				name: /convert search input 1 to simple/i,
			}),
		).toBeDefined();
		expect(
			within(searchConfig).getByRole("button", {
				name: /convert search input 1 to simple/i,
			}),
		).toBeDefined();

		// Fire the conversion from the case-search-config panel.
		fireEvent.click(
			within(searchConfig).getByRole("button", {
				name: /convert search input 1 to simple/i,
			}),
		);

		// Persisted shape: the row's discriminator is now `simple`,
		// the `predicate` slot is gone, and the `property` slot is
		// reset to empty — the user picks one next. The simple-arm
		// reverse path doesn't reverse-engineer the predicate's
		// structure; it's a fresh start.
		const persisted = readPersistedInputs(moduleSnapshotRef);
		expect(persisted.length).toBe(1);
		const row = persisted[0];
		if (row === undefined || row.kind !== "simple") {
			throw new Error("expected simple row");
		}
		expect(row.uuid).toBe(ADVANCED_INPUT_UUID);
		expect(row.property).toBe("");

		// The case-list workspace sees the same conversion.
		expect(
			within(caseList).getByRole("button", {
				name: /convert search input 1 to advanced/i,
			}),
		).toBeDefined();
	});
});

// ── Common-slot preservation across the round-trip ────────────────

describe("Search-inputs cross-binding — common-slot preservation", () => {
	it("preserves `uuid`, `name`, `label`, `type`, `default` when a simple-arm row round-trips through a convert-and-revert cycle", () => {
		// Seed a fully-populated simple-arm row. The five common slots
		// — uuid, name, label, type, default — must survive both
		// directions of conversion. The `default` slot is the slot
		// the simple-arm `appendRow` doesn't seed, so this fixture
		// exercises a path the Add affordance alone can't.
		const defaultExpr = term(literal("Ada"));
		const seed: SearchInputDef = simpleSearchInputDef(
			SIMPLE_INPUT_UUID,
			"common_slot_test",
			"Common slot test",
			"text",
			"name",
			{ default: defaultExpr },
		);
		const { caseList, searchConfig, moduleSnapshotRef } = renderHarness({
			searchInputs: [seed],
		});

		// Round 1: simple → advanced from the case-search-config
		// panel.
		fireEvent.click(
			within(searchConfig).getByRole("button", {
				name: /convert search input 1 to advanced/i,
			}),
		);

		// Inspect post-conversion: every common slot on the new
		// advanced-arm row matches the seed.
		let persisted = readPersistedInputs(moduleSnapshotRef);
		let row = persisted[0];
		if (row === undefined || row.kind !== "advanced") {
			throw new Error("expected advanced row after first conversion");
		}
		expect(row.uuid).toBe(SIMPLE_INPUT_UUID);
		expect(row.name).toBe("common_slot_test");
		expect(row.label).toBe("Common slot test");
		expect(row.type).toBe("text");
		expect(row.default).toEqual(defaultExpr);

		// Round 2: advanced → simple from the case-list workspace.
		// The five common slots survive the second hop too — the
		// reverse converter shares the same common-slot threading.
		fireEvent.click(
			within(caseList).getByRole("button", {
				name: /convert search input 1 to simple/i,
			}),
		);
		persisted = readPersistedInputs(moduleSnapshotRef);
		row = persisted[0];
		if (row === undefined || row.kind !== "simple") {
			throw new Error("expected simple row after revert conversion");
		}
		expect(row.uuid).toBe(SIMPLE_INPUT_UUID);
		expect(row.name).toBe("common_slot_test");
		expect(row.label).toBe("Common slot test");
		expect(row.type).toBe("text");
		expect(row.default).toEqual(defaultExpr);
	});
});

// ── Per-arm slot preservation ─────────────────────────────────────

describe("Search-inputs cross-binding — per-arm slot preservation", () => {
	it("preserves simple-arm `(property, mode, via)` slots without leaking to the advanced arm's shape", () => {
		// Seed a simple-arm row with all three per-arm slots set —
		// property, mode, AND a non-`self` relation walk. Advanced-arm
		// conversion drops `property`/`mode`/`via` entirely; reverting
		// to simple resets them to empty (the simple-arm reverse path
		// doesn't reverse-engineer the predicate). This pair of
		// transitions is the strongest assertion the slots don't
		// leak — neither arm carries a foreign-arm slot.
		const seed: SearchInputDef = simpleSearchInputDef(
			SIMPLE_INPUT_UUID,
			"name_input",
			"Name",
			"text",
			"name",
			{
				via: ancestorPath(relationStep("parent", "household")),
				mode: exactMode(),
			},
		);
		const { caseList, moduleSnapshotRef } = renderHarness({
			searchInputs: [seed],
		});

		// Pre-conversion: simple-arm slots are present and the row
		// has no advanced-arm `predicate` slot.
		let persisted = readPersistedInputs(moduleSnapshotRef);
		let row = persisted[0];
		if (row === undefined || row.kind !== "simple") {
			throw new Error("expected simple row at seed");
		}
		expect(row.property).toBe("name");
		expect(row.mode).toEqual(exactMode());
		expect(row.via).toEqual(ancestorPath(relationStep("parent", "household")));
		// Type-narrowing means TS won't let us reference `predicate`
		// on a simple row directly; the runtime check via `Object.hasOwn`
		// confirms the slot doesn't leak via property bag.
		expect(Object.hasOwn(row, "predicate")).toBe(false);

		// Convert simple → advanced. The simple-arm slots are dropped;
		// the advanced-arm `predicate` slot is seeded.
		fireEvent.click(
			within(caseList).getByRole("button", {
				name: /convert search input 1 to advanced/i,
			}),
		);
		persisted = readPersistedInputs(moduleSnapshotRef);
		row = persisted[0];
		if (row === undefined || row.kind !== "advanced") {
			throw new Error("expected advanced row after conversion");
		}
		expect(row.predicate).toBeDefined();
		// Simple-arm slots must NOT leak onto the advanced row.
		expect(Object.hasOwn(row, "property")).toBe(false);
		expect(Object.hasOwn(row, "mode")).toBe(false);
		expect(Object.hasOwn(row, "via")).toBe(false);
	});

	it("preserves the advanced-arm `predicate` slot and excludes simple-arm slots", () => {
		// Mirror image of the above: an advanced-arm seed exercised
		// without conversion. The `predicate` slot is the advanced
		// arm's identity; simple-arm `property`/`mode`/`via` must NOT
		// be present.
		const seed: SearchInputDef = advancedSearchInputDef(
			ADVANCED_INPUT_UUID,
			"any_input",
			"Any",
			"text",
			matchAll(),
		);
		const { moduleSnapshotRef } = renderHarness({ searchInputs: [seed] });

		const persisted = readPersistedInputs(moduleSnapshotRef);
		const row = persisted[0];
		if (row === undefined || row.kind !== "advanced") {
			throw new Error("expected advanced row at seed");
		}
		expect(row.predicate.kind).toBe("match-all");
		expect(Object.hasOwn(row, "property")).toBe(false);
		expect(Object.hasOwn(row, "mode")).toBe(false);
		expect(Object.hasOwn(row, "via")).toBe(false);
	});
});
