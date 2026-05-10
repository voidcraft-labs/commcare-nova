// components/builder/case-search-config/CaseSearchConfigPanel.tsx
//
// Multi-section authoring shell for the case-search workspace. Mounts
// at /build/[id]/{moduleUuid}/search-config in edit mode and stacks
// three sections — Display, Search Inputs, Advanced — vertically inside
// violet-railed sticky section headers.
//
// Layout choice. Single-scroll magazine: every section is always
// visible; the user moves between them by scrolling. The shape mirrors
// the case-list workspace's three-section magazine — one shell pattern,
// two URL-distinct authoring surfaces.
//
// Slot composition. The panel reads two distinct doc-store slots:
//
//   - `mod.caseSearchConfig` — owned by Display + Advanced. The slot
//     is OPTIONAL on the Module schema; per-section mutators spread
//     `...(value ?? {})` before applying their patch so first-edit
//     produces a strict-parse-valid empty-but-present config and
//     existing siblings flow through untouched.
//
//   - `mod.caseListConfig.searchInputs` — owned by Search Inputs.
//     Cross-binding with the case-list workspace: the same array is
//     authored from both surfaces. Editing here writes through
//     `caseListConfig.searchInputs`, NOT a parallel
//     `caseSearchConfig.searchInputs`. One source, two views.
//
// Validity propagation. Each section reports its verdict via
// `onValidityChange`; the panel ANDs the three into a single composite
// boolean and propagates it to the parent through the standardized
// `useValidityPropagator` helper. The parent gates its save affordance
// on the composite verdict.

"use client";

import { useCallback, useState } from "react";
import { CaseListSectionHeader } from "@/components/builder/case-list-config/CaseListSectionHeader";
import { SearchInputsSection } from "@/components/builder/case-list-config/SearchInputsSection";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import type {
	CaseListConfig,
	CaseSearchConfig,
	SearchInputDef,
} from "@/lib/domain";
import { AdvancedSection } from "./AdvancedSection";
import { DisplaySection } from "./DisplaySection";

// ── Public types ──────────────────────────────────────────────────

export interface CaseSearchConfigPanelProps {
	/** The module whose case-search authoring is being edited. The
	 *  panel reads this module's `caseSearchConfig` and
	 *  `caseListConfig.searchInputs` from the doc store and routes
	 *  per-section edits back through `updateModule(...)`. */
	readonly moduleUuid: Uuid;
	/** Aggregated validity verdict — fires `false` when any section
	 *  reports invalid, `true` when every section is valid (or
	 *  trivially valid because its slots are absent). The parent
	 *  gates its save affordance on this composite verdict. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Cross-binding seed for caseListConfig ─────────────────────────
//
// When the panel writes a `searchInputs` change but the module's
// `caseListConfig` slot is undefined, the schema-required `columns`
// and `searchInputs` arrays must be present. Routes the empty-slot
// case through a single helper so the emit shape stays in lockstep
// with the schema.

/**
 * Build the next `CaseListConfig` from a possibly-undefined current
 * value plus the next `searchInputs` array. Pins the schema-required
 * `columns: []` default on first edit so the parent never sees a
 * partial config that fails strict parse, and passes through every
 * existing slot (`columns`, `filter`) when the panel already has a
 * config.
 *
 * The helper exists for the case-search panel's cross-binding write
 * so the surfaces don't duplicate the seed logic.
 */
function nextCaseListConfigFromSearchInputs(
	current: CaseListConfig | undefined,
	nextInputs: readonly SearchInputDef[],
): CaseListConfig {
	const base: CaseListConfig = current ?? { columns: [], searchInputs: [] };
	return { ...base, searchInputs: [...nextInputs] };
}

// ── Top-level component ───────────────────────────────────────────

/**
 * Three-section single-scroll authoring panel for case-search.
 * Composes DisplaySection + the cross-bound SearchInputsSection +
 * AdvancedSection inside the case-list workspace's section-header
 * chrome (the `CaseListSectionHeader` primitive isn't case-list-
 * specific — it's a chrome shape used by every magazine-layout
 * workspace).
 */
export function CaseSearchConfigPanel({
	moduleUuid,
	onValidityChange,
}: CaseSearchConfigPanelProps) {
	const mod = useModule(moduleUuid);
	const caseTypes = useCaseTypes();
	const { updateModule } = useBlueprintMutations();

	// Per-section verdicts. Default `true` so the composite verdict
	// fires `true` on a clean module — the section-level effects then
	// flip individual slots to `false` only when the inner editor
	// reports invalid. The aggregator AND-folds the three at every
	// transition.
	const [displayValid, setDisplayValid] = useState(true);
	const [searchInputsValid, setSearchInputsValid] = useState(true);
	const [advancedValid, setAdvancedValid] = useState(true);

	const compositeValid = displayValid && searchInputsValid && advancedValid;
	useValidityPropagator({
		isValid: compositeValid,
		onValidityChange,
	});

	// ── Per-slot mutators ──
	//
	// Each section emits a fully-formed slot value the panel routes
	// straight to `updateModule(...)`. Display + Advanced share the
	// `caseSearchConfig` slot; both sections spread `...(value ?? {})`
	// inside their per-slot mutators, so the panel's mutator just
	// persists what the section emits.

	const handleSearchConfigChange = useCallback(
		(next: CaseSearchConfig) => {
			updateModule(moduleUuid, { caseSearchConfig: next });
		},
		[updateModule, moduleUuid],
	);

	// Cross-binding mutator. Writes flow through `caseListConfig` —
	// the same source the case-list workspace edits — so a search
	// input authored from this panel is the same row the case-list
	// workspace's Search section renders. The seed helper above pins
	// the schema-required defaults on first edit.
	const handleSearchInputsChange = useCallback(
		(nextInputs: readonly SearchInputDef[]) => {
			updateModule(moduleUuid, {
				caseListConfig: nextCaseListConfigFromSearchInputs(
					mod?.caseListConfig,
					nextInputs,
				),
			});
		},
		[updateModule, moduleUuid, mod?.caseListConfig],
	);

	// Defensive return — a module without a case type can't author
	// case-search (there's no scope for property references). The
	// affordance on `ModuleScreen` greys out in this state, but a
	// race (URL points at `/search-config` while the case type is
	// being deleted) shouldn't crash. Render nothing rather than a
	// hard error; the LocationRecoveryEffect scrubs the URL on the
	// next tick.
	if (!mod?.caseType) return null;

	// One source-of-truth alias for `caseListConfig.searchInputs`.
	// Consumed three ways: as `knownInputs` for Display + Advanced
	// (so `input("...")` references inside their inner editors
	// resolve) and as the `value` for the Search Inputs section
	// (which owns the slot). The cross-binding is the load-bearing
	// fact — the case-list workspace and this panel both author the
	// SAME array.
	const searchInputs = mod.caseListConfig?.searchInputs ?? [];
	const caseSearchConfig = mod.caseSearchConfig;
	const currentCaseType = mod.caseType;

	return (
		<div className="case-search-config-panel max-w-5xl mx-auto pb-32">
			{/*
			 * Section: Display.
			 *
			 * Owns the search-screen labels + the optional
			 * `searchButtonDisplayCondition` predicate. The status
			 * line counts authored labels.
			 */}
			<section>
				<CaseListSectionHeader
					title="Display"
					status={buildDisplayStatus(caseSearchConfig)}
				/>
				<div className="px-8 pt-24 pb-16 space-y-6">
					<DisplaySection
						value={caseSearchConfig}
						onChange={handleSearchConfigChange}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={searchInputs}
						onValidityChange={setDisplayValid}
					/>
				</div>
			</section>

			{/*
			 * Section divider — mirrors the case-list workspace's
			 * hairline between sections so the two surfaces compose
			 * with the same vertical rhythm.
			 */}
			<div className="border-t border-nova-violet/[0.15]" aria-hidden="true" />

			{/*
			 * Section: Search Inputs.
			 *
			 * Cross-bound to `mod.caseListConfig.searchInputs`. The
			 * same array the case-list workspace's Search section
			 * edits — the panel just renders a second view onto the
			 * same source. The status line mirrors the case-list
			 * workspace's input-count language.
			 */}
			<section>
				<CaseListSectionHeader
					title="Search Inputs"
					status={buildSearchInputsStatus(searchInputs.length)}
				/>
				<div className="px-8 pt-24 pb-16 space-y-6">
					<SearchInputsSection
						value={searchInputs}
						onChange={handleSearchInputsChange}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						onValidityChange={setSearchInputsValid}
					/>
				</div>
			</section>

			<div className="border-t border-nova-violet/[0.15]" aria-hidden="true" />

			{/*
			 * Section: Advanced.
			 *
			 * Owns niche search-side filters — the cluster carries
			 * `blacklistedOwnerIds` (a search-results owner exclusion
			 * list). The abstract "Advanced" framing scopes the section
			 * to its role (niche filters), not its contents.
			 */}
			<section>
				<CaseListSectionHeader
					title="Advanced"
					status={buildAdvancedStatus(caseSearchConfig)}
				/>
				<div className="px-8 pt-24 pb-16 space-y-6">
					<AdvancedSection
						value={caseSearchConfig}
						onChange={handleSearchConfigChange}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={searchInputs}
						onValidityChange={setAdvancedValid}
					/>
				</div>
			</section>
		</div>
	);
}

// ── Status-line builders ──────────────────────────────────────────
//
// Pure helpers. Each turns the relevant slot's authored state into
// the at-a-glance copy the section header surfaces. Strings prop-
// compare by value, so the section headers re-render when their
// status changes — no memoization needed.

/**
 * Display-section status. Counts authored label slots and reports
 * whether the search-button display condition is set. A blank state
 * surfaces "Defaults" so the user immediately knows the runtime is
 * using built-in copy. Optional-chains the value lookups so an
 * undefined config flows through the same arm as a defined-but-empty
 * one — both have zero authored slots and resolve to the defaults
 * line via the empty-`parts` branch below.
 */
function buildDisplayStatus(value: CaseSearchConfig | undefined): string {
	const labels = [
		value?.searchScreenTitle,
		value?.searchScreenSubtitle,
		value?.emptyListText,
		value?.searchButtonLabel,
		value?.searchAgainButtonLabel,
	].filter((s): s is string => s !== undefined && s.length > 0).length;
	const hasDisplayCondition = value?.searchButtonDisplayCondition !== undefined;
	const parts: string[] = [];
	if (labels > 0) {
		parts.push(`${labels} ${labels === 1 ? "label" : "labels"} authored`);
	}
	if (hasDisplayCondition) parts.push("display condition set");
	if (parts.length === 0) return "Defaults — runtime uses built-in copy.";
	return parts.join(" · ");
}

/**
 * Search-inputs status. Mirrors the case-list workspace's
 * vocabulary — same source data, same status copy — so the user
 * sees one consistent count regardless of which workspace they
 * arrived from.
 */
function buildSearchInputsStatus(count: number): string {
	if (count === 0) {
		return "No search inputs — list-only view (no inline search bar).";
	}
	return `${count} ${count === 1 ? "input" : "inputs"}`;
}

/**
 * Advanced-section status. Surfaces which advanced filters are
 * authored. A blank state reads "None" so the user sees the section
 * is intentionally empty rather than misconfigured. Optional-chains
 * the value lookup so an undefined config flows through the same arm
 * as a defined-but-empty one — both have zero authored slots and
 * resolve to the empty-`parts` branch below.
 */
function buildAdvancedStatus(value: CaseSearchConfig | undefined): string {
	const parts: string[] = [];
	if (value?.blacklistedOwnerIds !== undefined) parts.push("excluded owners");
	if (parts.length === 0) return "None — no advanced filters set.";
	return parts.join(" · ");
}
